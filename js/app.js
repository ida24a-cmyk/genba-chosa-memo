// 起動処理と画面の切り替え。
// 画面は3つ: ノート一覧 → ノートの中(メモ一覧) → メモの入力/編集。
// (コード上の名前の「investigation」は、画面でいう「ノート」のこと)
// 画面の切り替えは URL の「#」以降で行う(スマホの「戻る」操作が自然に使える)。
//   #/                      ノート一覧
//   #/inv/inv-001           ノートの中
//   #/inv/inv-001/memo/new  メモの新規入力
//   #/inv/inv-001/memo/m-000001  メモの編集

import {
  STAGES,
  KINDS,
  NOTE_KINDS,
  listInvestigations,
  getInvestigation,
  createInvestigation,
  renameInvestigation,
  deleteInvestigation,
  deleteInvestigations,
  deleteMemos,
  listMemos,
  getMemo,
  saveMemo,
  deleteMemo,
  getPhotos,
  listDrafts,
  getDraft,
  putDraftText,
  putDraftBlob,
  putDraftPhotos,
  deleteDraftBlobs,
  deleteDraft,
} from './db.js';
import {
  draftKey,
  draftPhotosKey,
  draftBlobKey,
  nextBlobNumber,
  unusedBlobKeys,
  hasChanges,
  draftLabel,
  restorablePhotos,
} from './draft.js';
import { shrinkToJpeg } from './photo.js';
import { prepareExport, deliverZip } from './export.js';
import { sortMemos, formatDisplay, formatObservedInput } from './time.js';
import { currentEdition } from './edition.js';
import { toggleSelected, bulkDeleteButtonState, bulkConfirmMessage } from './select.js';

// どちらの版か(調査メモ / 写真メモ)。版ごとの違いは edition.js に集めてある。
const edition = currentEdition();

const app = document.getElementById('app');

// ---- 小さな部品づくり ----

// 要素を作る。文字は textContent で入れるので、入力された文字が HTML として解釈されることはない。
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

// いま開いているメモの入力/編集画面の「下書きを今すぐ書く」処理(なければ null)。route() が呼ぶ。
let activeDraftFlush = null;

// 画面を離れるときに実行する後片付け(写真の表示用データの解放など)。
let pageCleanups = [];
function onLeavePage(fn) {
  pageCleanups.push(fn);
}

function show(...nodes) {
  // 前の画面の後片付けを先に行う
  const old = pageCleanups;
  pageCleanups = [];
  old.forEach((fn) => fn());
  // 無い部品(null など)は渡さない。replaceChildren に null を渡すと「null」という文字が表示されるため。
  app.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  window.scrollTo(0, 0);
}

// 普通の画面移動(「戻る」で元の画面に戻れる)。
function go(hash) {
  location.hash = hash;
}

// 保存・削除のあとの画面移動。履歴を置き換えるので、「戻る」で保存前の画面に戻って二重に保存することがない。
function goReplace(hash) {
  location.replace(location.pathname + location.search + hash);
}

// 処理中はボタンを押せなくして、連打による二重実行を防ぐ。
// 処理が true を返したとき(成功して別の画面へ移動するとき)は、画面が切り替わるまでの間も押せないままにする。
// 失敗したとき(true 以外)は元に戻す。
async function withBusy(buttons, fn) {
  const list = buttons.filter(Boolean);
  if (list.some((b) => b.disabled)) return;
  list.forEach((b) => { b.disabled = true; });
  let moving = false;
  try {
    moving = (await fn()) === true;
  } finally {
    if (!moving) list.forEach((b) => { b.disabled = false; });
  }
}

function errorMessage(err) {
  if (err && err.name === 'QuotaExceededError') return '端末の空きが足りず保存できませんでした';
  return err && err.message ? err.message : '保存できませんでした';
}

// ---- まとめて削除(「選んで削除」)の共通部品 ----
// rows: [{ id, box(チェック欄), onSelectMode(selecting) }]
// 戻り値: toggleButton(「選んで削除」)、bar(「N件を削除」「やめる」)、isSelecting()、toggle(id)
function selectionController({ target, rows, deleteFn, afterDelete }) {
  let selecting = false;
  let selected = new Set();

  const toggleButton = h('button', { type: 'button', class: 'block', text: '選んで削除', onclick: () => setSelecting(true) });
  const deleteButton = h('button', { type: 'button', class: 'danger grow' });
  const cancelButton = h('button', { type: 'button', text: 'やめる', onclick: () => setSelecting(false) });
  const bar = h('div', { class: 'row', hidden: true }, deleteButton, cancelButton);

  deleteButton.addEventListener('click', async () => {
    const ids = [...selected];
    if (!ids.length) return;
    // OKのときだけ削除する
    if (!confirm(bulkConfirmMessage(target, ids.length))) return;
    await withBusy([deleteButton, cancelButton], async () => {
      try {
        await deleteFn(ids); // 1つの取引。失敗したら何も消えない
        await afterDelete();
        return true; // 画面が描き直されるまで押せないままにする
      } catch (err) {
        alert(errorMessage(err));
      }
    });
  });

  function refresh() {
    const state = bulkDeleteButtonState(selected.size);
    deleteButton.textContent = state.text;
    deleteButton.disabled = state.disabled;
    toggleButton.hidden = selecting;
    bar.hidden = !selecting;
    for (const row of rows) {
      row.box.hidden = !selecting;
      row.box.checked = selected.has(row.id);
      row.onSelectMode(selecting);
    }
  }
  function setSelecting(value) {
    selecting = value;
    selected = new Set();
    refresh();
  }
  function toggle(id) {
    selected = toggleSelected(selected, id);
    refresh();
  }
  for (const row of rows) row.box.addEventListener('change', () => toggle(row.id));
  refresh();
  return { toggleButton, bar, toggle, isSelecting: () => selecting };
}

// ---- 永続化(端末にデータが残りやすくする依頼) ----

let persistedState = false;

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
    if (navigator.storage && navigator.storage.persisted) {
      persistedState = await navigator.storage.persisted();
    }
  } catch (err) {
    persistedState = false;
  }
}

function persistText() {
  return persistedState
    ? '端末保存:永続化済み'
    : '端末保存:未永続化(こまめに書き出してください)';
}

// ---- 書きかけのメモ(下書き)の案内帯 ----
// drafts: listDrafts() の結果。1件もなければ null(何も出さない)。
// 「続きを書く」で編集画面へ移り、「捨てる」は確認のあとで下書きを消して画面を描き直す。
function draftBanner(drafts) {
  if (!drafts.length) return null;
  const items = drafts.map((d) => {
    const discardButton = h('button', {
      type: 'button',
      class: 'danger',
      text: '捨てる',
      onclick: async () => {
        if (!confirm('この書きかけのメモを捨てます。\n書きかけの内容は消え、元に戻せません。\nよろしいですか?')) return;
        await withBusy([discardButton], async () => {
          try {
            await deleteDraft(d.invId, d.memoId);
            await route();
            return true; // 画面が描き直されるまで押せないままにする
          } catch (err) {
            alert(errorMessage(err));
          }
        });
      },
    });
    return h(
      'div',
      { class: 'draft-item' },
      h('div', { class: 'draft-label', text: draftLabel(d) }),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'primary', text: '続きを書く', onclick: () => go(`#/inv/${d.invId}/memo/${d.memoId}`) }),
        discardButton
      )
    );
  });
  return h('div', { class: 'draft-banner', role: 'status' }, h('div', { class: 'draft-title', text: '保存していない書きかけのメモがあります' }), items);
}

// 下書きの一覧を読む。読めなくても画面は出す(案内帯が出ないだけ)。
async function loadDrafts(invId) {
  try {
    return await listDrafts(invId);
  } catch (err) {
    return [];
  }
}

// ---- ノート一覧 ----

async function renderList(token) {
  const investigations = await listInvestigations();
  if (token !== renderToken) return;
  const drafts = await loadDrafts(null);
  if (token !== renderToken) return;
  const errorBox = h('div', { class: 'error', role: 'alert' });
  const nameInput = h('input', { type: 'text', id: 'new-name', placeholder: 'ノートの名前', autocomplete: 'off' });
  // 種類は初期値なし。選ばないと作成できない(db.js でも確認する)
  // 写真メモでは種類を選ばせない(常に「ふつう」)
  const noteKindChoices = NOTE_KINDS.map((k) =>
    h('label', {}, h('input', { type: 'radio', name: 'note-kind', value: k }), k)
  );
  const createButton = h('button', { type: 'submit', class: 'primary', text: '作成' });

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy([createButton], async () => {
          try {
            const checkedKind = form.querySelector('input[name="note-kind"]:checked');
            const kind = edition.kindChoice ? (checkedKind ? checkedKind.value : '') : 'ふつう';
            const inv = await createInvestigation(nameInput.value, kind);
            goReplace(`#/inv/${inv.id}`);
            return true;
          } catch (err) {
            errorBox.textContent = errorMessage(err);
          }
        });
      },
    },
    h('label', { for: 'new-name', text: '新しいノートを作る' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput), createButton),
    edition.kindChoice ? h('div', { class: 'label', text: '種類(必須)' }) : null,
    edition.kindChoice ? h('div', { class: 'kind-choices', role: 'radiogroup', 'aria-label': 'ノートの種類' }, noteKindChoices) : null,
    errorBox
  );

  // 一覧の各行: チェック欄(「選んで削除」のときだけ表示)+ ノートのボタン
  const selectRows = [];
  let controller = null;
  const items = investigations.length
    ? investigations.map((inv) => {
        const box = h('input', { type: 'checkbox', class: 'select-box', hidden: true, 'aria-label': `${inv.name}を選ぶ` });
        const item = h(
          'button',
          {
            type: 'button',
            class: 'list-item',
            onclick: () => (controller.isSelecting() ? controller.toggle(inv.id) : go(`#/inv/${inv.id}`)),
          },
          inv.name,
          h('span', { class: 'sub', text: `${inv.id} / ${inv.kind} / 作成: ${formatDisplay(inv.createdAt)}` })
        );
        selectRows.push({ id: inv.id, box, onSelectMode: () => {} });
        return h('div', { class: 'select-row' }, box, item);
      })
    : [h('p', { class: 'empty', text: 'まだノートがありません。上から作ってください。' })];
  controller = selectionController({
    target: 'note',
    rows: selectRows,
    deleteFn: deleteInvestigations,
    afterDelete: () => route(),
  });

  show(
    h('h1', { text: edition.label }),
    draftBanner(drafts),
    form,
    h('h2', { text: 'ノート一覧' }),
    investigations.length ? controller.toggleButton : null,
    investigations.length ? controller.bar : null,
    ...items,
    h('p', { class: 'status', id: 'persist-status', text: persistText() })
  );
}

// ---- ノートの中(メモ一覧) ----

let kindFilter = 'all'; // 'all' | '事実' | '推論'
let filterInvestigationId = null;

async function renderInvestigation(token, invId) {
  const inv = await getInvestigation(invId);
  if (token !== renderToken) return;
  if (!inv) return goReplace('#/');
  if (filterInvestigationId !== invId) {
    kindFilter = 'all';
    filterInvestigationId = invId;
  }

  const isResearch = inv.kind === '調査'; // ふつうのノートは段階・種別・絞り込みなし
  const loaded = await listMemos(invId);
  if (token !== renderToken) return;
  const drafts = await loadDrafts(invId);
  if (token !== renderToken) return;
  const allMemos = sortMemos(loaded); // 観測時刻 → 記録時刻 → メモid
  const memos = !isResearch || kindFilter === 'all' ? allMemos : allMemos.filter((m) => m.kind === kindFilter);

  // 名前変更(ふだんは隠しておく)
  const renameError = h('div', { class: 'error', role: 'alert' });
  const renameInput = h('input', { type: 'text', id: 'rename-input', value: inv.name, autocomplete: 'off' });
  const renameSaveButton = h('button', { type: 'submit', class: 'primary', text: '名前を保存' });
  const renameForm = h(
    'form',
    {
      class: 'card',
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy([renameSaveButton], async () => {
          try {
            await renameInvestigation(inv.id, renameInput.value);
            await route();
          } catch (err) {
            renameError.textContent = errorMessage(err);
          }
        });
      },
    },
    h('label', { for: 'rename-input', text: 'ノートの名前' }),
    renameInput,
    renameError,
    h(
      'div',
      { class: 'row' },
      renameSaveButton,
      h('button', { type: 'button', text: 'やめる', onclick: () => { renameForm.hidden = true; } })
    )
  );

  const deleteInvButton = h('button', {
    type: 'button',
    class: 'danger',
    text: 'ノートを削除',
    onclick: async () => {
      if (!confirm(`ノート「${inv.name}」を削除します。\nこのノートのメモと写真もすべて消え、元に戻せません。\nよろしいですか?`)) return;
      await withBusy([deleteInvButton], async () => {
        try {
          await deleteInvestigation(inv.id);
          goReplace('#/');
          return true;
        } catch (err) {
          alert(errorMessage(err));
        }
      });
    },
  });

  // ---- 書き出し ----
  // 共有を「操作直後ではない」と断られたとき(retry)のために、作成済みのZIPをここに持っておく。
  // 次に押したときは、作り直さずにすぐ共有する。
  let readyZip = null;
  let readyZipTried = false; // 作成済みのZIPで共有を一度試したか
  const exportStatus = h('div', { class: 'memo-meta', role: 'status' });
  const exportButton = h('button', {
    type: 'button',
    class: 'block',
    text: '書き出し(ZIP)',
    onclick: () => withBusy([exportButton], async () => {
      exportStatus.textContent = readyZip ? '' : 'ZIPを作成中...';
      try {
        if (!readyZip) readyZip = await prepareExport(inv);
        const result = await deliverZip(readyZip.file, readyZipTried);
        readyZipTried = true;
        if (result === 'retry') {
          exportStatus.textContent = 'もう一度押してください(作成済みのZIPをすぐ共有します)';
        } else if (result === 'cancelled') {
          exportStatus.textContent = '共有を中止しました';
        } else {
          const texts = {
            shared: `共有しました: ${readyZip.name}`,
            downloaded: `ダウンロードしました: ${readyZip.name}`,
            fallback: `共有できなかったため、ダウンロードに切り替えました: ${readyZip.name}`,
          };
          exportStatus.textContent = texts[result];
          readyZip = null;
          readyZipTried = false;
        }
      } catch (err) {
        readyZip = null;
        readyZipTried = false;
        exportStatus.textContent = `書き出せませんでした: ${errorMessage(err)}`;
      }
    }),
  });

  const filterButtons = [
    ['all', 'すべて'],
    ['事実', '事実のみ'],
    ['推論', '推論のみ'],
  ].map(([value, label]) =>
    h('button', {
      type: 'button',
      text: label,
      'aria-pressed': kindFilter === value ? 'true' : 'false',
      onclick: () => {
        kindFilter = value;
        route();
      },
    })
  );

  let controller = null;
  const selectRows = [];
  const makeCard = memoCard(inv);
  const memoNodes = memos.length
    ? memos.map((memo) => {
        const card = makeCard(memo);
        selectRows.push({
          id: memo.id,
          box: card.box,
          onSelectMode: (on) => {
            card.editButton.hidden = on;
            card.el.classList.toggle('selectable', on);
          },
        });
        // 選んで削除のときは、メモの行のどこを押しても切り替える(チェック欄自体の押下は change で処理される)
        card.el.addEventListener('click', (e) => {
          if (e.target !== card.box && controller.isSelecting()) controller.toggle(memo.id);
        });
        return card.el;
      })
    : [h('p', { class: 'empty', text: allMemos.length ? 'この種別のメモはありません。' : 'まだメモがありません。' })];

  // 絞り込み中は、画面に出ているメモ(selectRows)だけが選べる
  controller = selectionController({
    target: 'memo',
    rows: selectRows,
    deleteFn: deleteMemos,
    afterDelete: () => route(),
  });

  show(
    h('button', { type: 'button', class: 'back', text: '← ノート一覧', onclick: () => go('#/') }),
    h('h1', { text: inv.name }),
    h('p', { class: 'memo-meta', text: `${inv.id} / ${inv.kind} / 作成: ${formatDisplay(inv.createdAt)}` }),
    draftBanner(drafts),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', text: '名前を変更', onclick: () => { renameForm.hidden = false; renameInput.focus(); } }),
      deleteInvButton
    ),
    renameForm,
    h('div', { id: 'export-area' }, exportButton, exportStatus),
    h('h2', { text: 'メモ' }),
    h('button', { type: 'button', class: 'primary block', text: '＋ メモを追加', onclick: () => go(`#/inv/${inv.id}/memo/new`) }),
    isResearch ? h('div', { class: 'filter', role: 'group', 'aria-label': '種別で絞り込み' }, filterButtons) : null,
    memos.length ? controller.toggleButton : null,
    memos.length ? controller.bar : null,
    ...memoNodes
  );
}

// メモ1件ぶんの表示を作る関数を返す。
function memoCard(inv) {
  return (memo) => {
    const isResearch = inv.kind === '調査';
    const isFact = memo.kind === '事実';
    const meta = `記録: ${formatDisplay(memo.recordedAt)}` + (memo.updatedAt ? ` / 更新: ${formatDisplay(memo.updatedAt)}` : '');
    const box = h('input', { type: 'checkbox', class: 'select-box', hidden: true, 'aria-label': 'このメモを選ぶ' });
    const editButton = h('button', { type: 'button', class: 'block', text: '編集', onclick: () => go(`#/inv/${inv.id}/memo/${memo.id}`) });
    const el = h(
      'div',
      { class: isResearch ? `card memo ${isFact ? 'fact' : 'infer'}` : 'card memo' },
      h(
        'div',
        { class: 'memo-head' },
        box,
        h('span', { text: formatDisplay(memo.observedAt) }),
        isResearch ? h('span', { class: `badge ${isFact ? 'fact' : 'infer'}`, text: `【${memo.kind}】` }) : null,
        isResearch ? h('span', { text: memo.stage }) : null
      ),
      memo.body ? h('div', { class: 'memo-body', text: memo.body }) : null,
      memo.photoIds && memo.photoIds.length ? h('div', { class: 'memo-meta', text: `写真: ${memo.photoIds.length}枚` }) : null,
      h('div', { class: 'memo-meta', text: meta }),
      editButton
    );
    return { el, box, editButton };
  };
}

// ---- メモの入力/編集 ----

async function renderMemoForm(token, invId, memoId) {
  const inv = await getInvestigation(invId);
  if (token !== renderToken) return;
  if (!inv) return goReplace('#/');
  const isNew = memoId === 'new';
  const memo = isNew ? null : await getMemo(memoId);
  if (token !== renderToken) return;
  if (!isNew && (!memo || memo.investigationId !== invId)) return goReplace(`#/inv/${invId}`);

  // 初期値: 段階は直前に使った段階(初回は空)。種別は必ず空。観測時刻は現在の現地時刻。
  const isResearch = inv.kind === '調査'; // ふつうのノートは段階・種別の欄を出さない
  const initial = memo || { stage: inv.lastStage || '', kind: '', body: '', observedAt: formatObservedInput() };

  // 保存していなかった下書きがあれば、それで欄と写真を埋める(なければ null)。
  // 下書きの読み出しに失敗しても、ふつうに開けるようにする。
  let draft = null;
  let draftReadFailed = false;
  try {
    draft = await getDraft(invId, memoId);
  } catch (err) {
    draft = null;
    draftReadFailed = true; // 読めなかっただけで、下書きは「あるかもしれない」
  }
  if (token !== renderToken) return;
  const start = draft
    ? { stage: draft.stage, kind: draft.kind, body: draft.body, observedAt: draft.observedAt || initial.observedAt }
    : initial;

  const errorBox = h('div', { class: 'error', role: 'alert' });

  // 写真の並び。{ id, blob, url } = 保存済みの写真、{ blob, url } = まだ保存していない写真。
  // 保存ボタンを押すまでは画面の中で持つ。ただし下書きとして端末の中にも自動でしまっておく。
  const savedPhotos = isNew ? [] : await getPhotos(memo.photoIds || []);
  if (token !== renderToken) return;
  let photoItems;
  if (draft && draft.photos) {
    // 下書きの写真の並びで復元する。今のメモに無い写真({id})は飛ばす
    const byId = new Map(savedPhotos.map((p) => [p.id, p.blob]));
    photoItems = restorablePhotos(draft.photos, isNew ? [] : memo.photoIds || [])
      .map((p) => (p.id ? { id: p.id, blob: byId.get(p.id), url: null } : { blob: p.blob, blobKey: p.blobKey, url: null }))
      .filter((p) => p.blob);
  } else {
    photoItems = savedPhotos.map((p) => ({ id: p.id, blob: p.blob, url: null }));
  }

  const stageSelect = h(
    'select',
    { id: 'memo-stage' },
    h('option', { value: '', text: '選んでください' }),
    STAGES.map((s) => h('option', { value: s, text: s, selected: s === start.stage }))
  );

  const kindChoices = KINDS.map((k) =>
    h('label', {}, h('input', { type: 'radio', name: 'kind', value: k, checked: k === start.kind }), `【${k}】`)
  );

  const bodyInput = h('textarea', { id: 'memo-body' });
  bodyInput.value = start.body; // 改行をそのまま入れるため value で設定する
  const observedInput = h('input', { type: 'datetime-local', id: 'memo-observed', value: start.observedAt.slice(0, 16) });

  // 下の保存ボタンはフォームの中。上の帯の保存ボタンは、form 属性でこのフォームに結ぶ。
  const saveButton = h('button', { type: 'submit', class: 'primary block', text: '保存' });
  const topSaveButton = h('button', { type: 'submit', class: 'primary', form: 'memo-form', text: '保存' });

  // ---- 写真欄 ----
  const photoStatus = h('div', { class: 'memo-meta', role: 'status' });
  const photoError = h('div', { class: 'error', role: 'alert' });
  const thumbList = h('div', { class: 'thumbs' });
  const cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'file-input', tabindex: '-1' });
  const libraryInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'file-input', tabindex: '-1' });
  const cameraButton = h('button', { type: 'button', text: 'カメラで撮る', onclick: () => cameraInput.click() });
  const libraryButton = h('button', { type: 'button', text: '写真から選ぶ', onclick: () => libraryInput.click() });
  const photoArea = h(
    'div',
    { id: 'photo-area' },
    h('div', { class: 'label', text: '写真' }),
    h('div', { class: 'row' }, cameraButton, libraryButton),
    cameraInput,
    libraryInput,
    photoStatus,
    photoError,
    thumbList
  );
  let alive = true; // 画面を離れたら false(処理中の写真は捨てる)
  let processing = false;

  // ---- 下書きの自動保存(第4版) ----
  // 開いたときの内容(DBの値)。いまの内容と比べて、変わっていれば「保存していない変更あり」。
  const baseline = {
    stage: isResearch ? initial.stage || '' : '',
    kind: isResearch ? initial.kind || '' : '',
    body: initial.body,
    observedAt: initial.observedAt,
    photos: isNew ? [] : (memo.photoIds || []).map((id) => ({ id })),
  };
  const forcedDirty = !!draft; // 下書きから戻した内容は、最初から「変更あり」として扱う

  function currentState() {
    const checked = form.querySelector('input[name="kind"]:checked');
    return {
      stage: isResearch ? stageSelect.value : '',
      kind: isResearch && checked ? checked.value : '',
      body: bodyInput.value,
      observedAt: observedInput.value,
      photos: photoItems.map((p) => (p.id ? { id: p.id } : { blob: p.blob })),
    };
  }
  function isDirty() {
    return forcedDirty || hasChanges(baseline, currentState());
  }

  // 下書きの書き込みの状態
  let draftExists = !!draft || draftReadFailed; // 端末の中に、このメモの下書きがありそうか(読めなかったときも「ありそう」)
  let photosDirty = !!(draft && draft.photos); // 写真の並びの下書きに、まだ書いていない付け外しがあるか
  let draftStopped = false; // true の間は下書きを書かない(保存・削除・破棄の最中と、その後)
  let draftTimer = null;
  let draftTimerPending = false;
  let draftQueue = Promise.resolve(); // 下書きの書き込みは1本の順番待ち(追い越しを防ぐ)
  let flushQueued = false;
  // 新しい写真の中身は、1枚ずつ別のキーに一度だけ書く。書き込み済みのキーをここで覚える。
  const writtenBlobKeys = new Set(photoItems.filter((p) => p.blobKey).map((p) => p.blobKey));
  let blobCounter = nextBlobNumber(writtenBlobKeys);
  const draftWarning = h('div', { class: 'memo-meta draft-warning', role: 'status' });

  // 順番待ちの先頭に来たときに、そのときの最新の内容を書く。書いたら true、書かなかったら false。
  async function writeDraft() {
    if (draftStopped) return false;
    if (!isDirty()) {
      // 開いたときと同じ状態に戻った: 下書きはいらない
      photosDirty = false;
      if (draftExists) {
        await deleteDraft(invId, memoId);
        draftExists = false;
        writtenBlobKeys.clear();
      }
      return true;
    }
    // 文字と写真の並びは同じ瞬間の内容を取り、写真の印もすぐ戻す(書いている間の付け外しは次の回で書く)
    const state = currentState();
    const items = photoItems.slice();
    const writePhotos = photosDirty;
    photosDirty = false;
    try {
      await putDraftText({ invId, memoId, stage: state.stage, kind: state.kind, body: state.body, observedAt: state.observedAt });
      draftExists = true;
      if (writePhotos) {
        // 順番: 写真の中身(まだ書いていないものだけ)→ 並び → 使わなくなった中身を消す
        for (const item of items) {
          if (!item.id && !writtenBlobKeys.has(item.blobKey)) {
            await putDraftBlob(item.blobKey, item.blob);
            writtenBlobKeys.add(item.blobKey);
          }
        }
        const list = items.map((p) => (p.id ? { id: p.id } : { blobKey: p.blobKey }));
        await putDraftPhotos(invId, memoId, list);
        const unused = unusedBlobKeys(writtenBlobKeys, list);
        if (unused.length) {
          await deleteDraftBlobs(unused);
          unused.forEach((k) => writtenBlobKeys.delete(k));
        }
      }
    } catch (err) {
      if (writePhotos) photosDirty = true; // 次の機会にもう一度書く
      throw err;
    }
    return true;
  }
  // 今すぐ書く。順番待ちに入れて、待っている間に重なった分は1回にまとめる。
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimerPending = false;
    if (flushQueued) return draftQueue;
    flushQueued = true;
    draftQueue = draftQueue.then(async () => {
      flushQueued = false;
      try {
        if (await writeDraft()) draftWarning.textContent = '';
      } catch (err) {
        // 入力そのものは続けられる。書けなかったことだけ、控えめに知らせる
        draftWarning.textContent = '下書きを保存できませんでした(保存ボタンで保存してください)';
      }
    });
    return draftQueue;
  }
  // 入力のたびに呼ぶ。約0.5秒ためてまとめて書く。
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimerPending = true;
    draftTimer = setTimeout(flushDraft, 500);
  }
  // 保存・削除・破棄の前に呼ぶ: 以降は下書きを書かない状態にして、書きかけの書き込みが終わるのを待つ。
  // flushFirst が true なら、0.5秒待ちの分があるとき、止める前に一度書き切る(保存に失敗しても直前の入力が残るように)。
  async function stopDraft(flushFirst = true) {
    const pending = draftTimerPending;
    clearTimeout(draftTimer);
    draftTimerPending = false;
    if (!flushFirst) draftStopped = true;
    else if (pending) flushDraft();
    await draftQueue;
    draftStopped = true;
    await draftQueue;
  }
  // 保存や削除が失敗したときに呼ぶ: 下書きの書き込みを再開し、直ちに書き直す。
  function resumeDraft() {
    draftStopped = false;
    if (alive) flushDraft();
  }
  // 写真を付けた・外したとき。写真の下書きもすぐ書く。
  function photosChanged() {
    photosDirty = true;
    flushDraft();
  }

  function releaseUrl(item) {
    if (item.url) {
      URL.revokeObjectURL(item.url);
      item.url = null;
    }
  }

  // 「写真nを外す」の番号と代替文字だけを付け直す(画像の要素は作り直さない)。
  function relabelThumbs() {
    photoItems.forEach((item, i) => {
      item.img.alt = `写真${i + 1}`;
      item.removeButton.textContent = `写真${i + 1}を外す`;
    });
  }

  // 写真1枚ぶんの表示を作って、末尾に足す。
  function addThumb(item) {
    item.url = URL.createObjectURL(item.blob);
    item.img = h('img', { class: 'thumb', src: item.url, alt: '' });
    item.removeButton = h('button', {
      type: 'button',
      class: 'danger',
      onclick: () => {
        // 押し間違いを防ぐため、確認してから外す。メモを保存しなければ元に戻る。
        const n = photoItems.indexOf(item) + 1;
        if (!confirm(`写真${n}を外しますか?`)) return;
        releaseUrl(item);
        photoItems.splice(photoItems.indexOf(item), 1);
        item.el.remove();
        relabelThumbs();
        photosChanged();
      },
    });
    item.el = h('div', { class: 'thumb-item' }, item.img, item.removeButton);
    thumbList.append(item.el);
  }

  // 写真の取り込み中に押せなくするボタン(上の帯の保存ボタンも含む)
  function busyButtons() {
    return [cameraButton, libraryButton, saveButton, topSaveButton, deleteButton];
  }

  // 選ばれた写真を1枚ずつ順番に縮小する(同時に何枚も処理しない)。
  async function addPhotos(files) {
    if (!files.length || processing) return;
    processing = true;
    photoError.textContent = '';
    busyButtons().forEach((b) => { if (b) b.disabled = true; });
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        photoStatus.textContent = `写真を処理中 ${i + 1}/${files.length}`;
        try {
          const blob = await shrinkToJpeg(files[i]);
          if (!alive) return;
          const item = { blob, blobKey: draftBlobKey(invId, memoId, blobCounter++), url: null };
          photoItems.push(item);
          addThumb(item);
          relabelThumbs();
          photosChanged(); // 1枚ごとに下書きへ(続けて足した分は重なれば1回にまとめて書かれる)
        } catch (err) {
          failed++;
        }
      }
    } finally {
      processing = false;
      if (alive) {
        photoStatus.textContent = '';
        busyButtons().forEach((b) => { if (b) b.disabled = false; });
        if (failed) photoError.textContent = `${failed}枚の写真を読み込めませんでした`;
      }
    }
  }
  for (const input of [cameraInput, libraryInput]) {
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = ''; // 同じ写真をもう一度選べるようにする
      addPhotos(files);
    });
  }

  // 新規のときは削除ボタンなし(null)。
  const deleteButton = isNew
    ? null
    : h('button', {
        type: 'button',
        class: 'danger block',
        text: 'このメモを削除',
        onclick: async () => {
          if (!confirm('このメモを削除します。写真がある場合も一緒に消え、元に戻せません。\nよろしいですか?')) return;
          await withBusy([saveButton, topSaveButton, deleteButton, cameraButton, libraryButton, backButton], async () => {
            await stopDraft(false); // 削除のあとに下書きが書き戻されないようにする
            try {
              await deleteMemo(memo.id);
              try {
                await deleteDraft(invId, memoId);
              } catch (err) {
                // 消せなくても、メモが無いので次の一覧読み出しで片付く
              }
              goReplace(`#/inv/${invId}`);
              return true;
            } catch (err) {
              errorBox.textContent = errorMessage(err);
              resumeDraft();
            }
          });
        },
      });

  const form = h(
    'form',
    {
      id: 'memo-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const checked = form.querySelector('input[name="kind"]:checked');
        await withBusy([saveButton, topSaveButton, deleteButton, cameraButton, libraryButton, backButton], async () => {
          // 保存の間は下書きを書かない(保存のあとに下書きが復活しないように)。待ち中の入力は先に書き切る
          await stopDraft(true);
          try {
            await saveMemo({
              id: isNew ? null : memo.id,
              investigationId: invId,
              stage: isResearch ? stageSelect.value : null,
              kind: isResearch && checked ? checked.value : '',
              body: bodyInput.value,
              observedAt: observedInput.value,
              photos: photoItems.map((p) => (p.id ? { id: p.id } : { blob: p.blob })),
              draftKeys: [draftKey(invId, memoId), draftPhotosKey(invId, memoId)], // メモの保存と同じ取引で下書きを消す
            });
            goReplace(`#/inv/${invId}`);
            return true;
          } catch (err) {
            errorBox.textContent = errorMessage(err);
            resumeDraft(); // 保存できなかったので、書きかけは下書きに残す
          }
        });
      },
    },
    isResearch ? h('label', { for: 'memo-stage', text: '段階(必須)' }) : null,
    isResearch ? stageSelect : null,
    isResearch ? h('div', { class: 'label', text: '種別(必須)' }) : null,
    isResearch ? h('div', { class: 'kind-choices', role: 'radiogroup', 'aria-label': '種別' }, kindChoices) : null,
    h('label', { for: 'memo-body', text: '本文' }),
    bodyInput,
    h('label', { for: 'memo-observed', text: isResearch ? '観測時刻' : '日時' }),
    observedInput,
    photoArea,
    errorBox,
    saveButton
  );
  // 入力欄が変わるたびに、下書きを(少しためてから)書く
  form.addEventListener('input', scheduleDraft);
  form.addEventListener('change', scheduleDraft);

  // 「← 戻る」: 保存していない変更があれば確認する。戻るなら下書きも捨てる。
  const backButton = h('button', {
    type: 'button',
    class: 'back',
    text: `← ${inv.name}`,
    onclick: async () => {
      if (isDirty() && !confirm('保存していない変更があります。保存せずに戻りますか?\n(書きかけの内容は捨てられます)')) return;
      await withBusy([backButton], async () => {
        await stopDraft(false);
        try {
          await deleteDraft(invId, memoId);
        } catch (err) {
          // 消せなくても戻る(もう無いメモの下書きは自動で片付く。残っても「続きを書く」「捨てる」が使える)
        }
        go(`#/inv/${invId}`);
        return true;
      });
    },
  });
  // 上の帯: 下へスクロールしても画面の上に残る
  const topBar = h('div', { class: 'topbar' }, backButton, topSaveButton);

  show(
    topBar,
    h('h1', { text: isNew ? 'メモを追加' : 'メモを編集' }),
    draft ? h('div', { class: 'restored', role: 'status', text: '前回保存していなかった内容を戻しました' }) : null,
    draftWarning,
    form,
    deleteButton
  );
  // 画面に出したあとで、写真の表示と後片付けを登録する(show が前の画面の後片付けを先に行うため)
  photoItems.forEach(addThumb);
  relabelThumbs();
  // 別のアプリに切り替えた・画面を閉じかけたときは、待たずにすぐ下書きを書く
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushDraft();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const flushNow = () => flushDraft();
  activeDraftFlush = flushNow;
  onLeavePage(() => {
    alive = false;
    document.removeEventListener('visibilitychange', onVisibility);
    if (activeDraftFlush === flushNow) activeDraftFlush = null;
    flushDraft(); // 画面を離れるときも、待たずにすぐ書く(保存・削除・破棄のあとは書かない)
    photoItems.forEach(releaseUrl);
  });
}

// ---- 画面の振り分け ----

let renderToken = 0; // 古い描画が新しい描画を上書きしないための番号

async function route() {
  const token = ++renderToken;
  // 書きかけのメモ画面から移るときは、下書きを先に書き終えてから次の画面を作る
  // (次の画面の「書きかけのメモがあります」に、いま書いた分が出るようにするため)
  if (activeDraftFlush) {
    try { await activeDraftFlush(); } catch (err) { /* 下書きが書けなくても画面移動は続ける */ }
    if (token !== renderToken) return;
  }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'inv' && parts[1] && parts[2] === 'memo' && parts[3]) {
      await renderMemoForm(token, decodeURIComponent(parts[1]), decodeURIComponent(parts[3]));
    } else if (parts[0] === 'inv' && parts[1]) {
      await renderInvestigation(token, decodeURIComponent(parts[1]));
    } else {
      await renderList(token);
    }
  } catch (err) {
    if (token !== renderToken) return;
    show(
      h('h1', { text: edition.label }),
      h('p', { class: 'error', text: `画面を表示できませんでした: ${errorMessage(err)}` }),
      h('button', { type: 'button', class: 'primary block', text: 'ノート一覧へ', onclick: () => { goReplace('#/'); route(); } })
    );
  }
}

window.addEventListener('hashchange', route);

// 起動: 先に画面を出し、永続化の結果は分かった時点で一覧下部の1行だけ書き換える。
route();
requestPersistence().then(() => {
  const status = document.getElementById('persist-status');
  if (status) status.textContent = persistText();
});

// オフラインでも起動できるよう、アプリ本体を端末にしまう(Service Worker)。
// 登録に失敗しても、アプリ自体はふつうに動く。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
