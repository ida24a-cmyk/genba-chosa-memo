// 起動処理と画面の切り替え。
// 画面は3つ: 調査一覧 → 調査の中(メモ一覧) → メモの入力/編集。
// 画面の切り替えは URL の「#」以降で行う(スマホの「戻る」操作が自然に使える)。
//   #/                      調査一覧
//   #/inv/inv-001           調査の中
//   #/inv/inv-001/memo/new  メモの新規入力
//   #/inv/inv-001/memo/m-000001  メモの編集

import {
  STAGES,
  KINDS,
  listInvestigations,
  getInvestigation,
  createInvestigation,
  renameInvestigation,
  deleteInvestigation,
  listMemos,
  getMemo,
  saveMemo,
  deleteMemo,
  getPhotos,
} from './db.js';
import { shrinkToJpeg } from './photo.js';
import { prepareExport, deliverZip } from './export.js';
import { sortMemos, formatDisplay, formatObservedInput } from './time.js';

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

// ---- 調査一覧 ----

async function renderList(token) {
  const investigations = await listInvestigations();
  if (token !== renderToken) return;
  const errorBox = h('div', { class: 'error', role: 'alert' });
  const nameInput = h('input', { type: 'text', id: 'new-name', placeholder: '調査の名前', autocomplete: 'off' });
  const createButton = h('button', { type: 'submit', class: 'primary', text: '作成' });

  const form = h(
    'form',
    {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy([createButton], async () => {
          try {
            const inv = await createInvestigation(nameInput.value);
            goReplace(`#/inv/${inv.id}`);
            return true;
          } catch (err) {
            errorBox.textContent = errorMessage(err);
          }
        });
      },
    },
    h('label', { for: 'new-name', text: '新しい調査を作る' }),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput), createButton),
    errorBox
  );

  const items = investigations.length
    ? investigations.map((inv) =>
        h(
          'button',
          { type: 'button', class: 'list-item', onclick: () => go(`#/inv/${inv.id}`) },
          inv.name,
          h('span', { class: 'sub', text: `${inv.id} / 作成: ${formatDisplay(inv.createdAt)}` })
        )
      )
    : [h('p', { class: 'empty', text: 'まだ調査がありません。上から作ってください。' })];

  show(h('h1', { text: '現場調査メモ' }), form, h('h2', { text: '調査一覧' }), ...items, h('p', { class: 'status', id: 'persist-status', text: persistText() }));
}

// ---- 調査の中(メモ一覧) ----

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

  const loaded = await listMemos(invId);
  if (token !== renderToken) return;
  const allMemos = sortMemos(loaded); // 観測時刻 → 記録時刻 → メモid
  const memos = kindFilter === 'all' ? allMemos : allMemos.filter((m) => m.kind === kindFilter);

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
    h('label', { for: 'rename-input', text: '調査の名前' }),
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
    text: '調査を削除',
    onclick: async () => {
      if (!confirm(`調査「${inv.name}」を削除します。\nこの調査のメモと写真もすべて消え、元に戻せません。\nよろしいですか?`)) return;
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

  const memoNodes = memos.length
    ? memos.map(memoCard(inv))
    : [h('p', { class: 'empty', text: allMemos.length ? 'この種別のメモはありません。' : 'まだメモがありません。' })];

  show(
    h('button', { type: 'button', class: 'back', text: '← 調査一覧', onclick: () => go('#/') }),
    h('h1', { text: inv.name }),
    h('p', { class: 'memo-meta', text: `${inv.id} / 作成: ${formatDisplay(inv.createdAt)}` }),
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
    h('div', { class: 'filter', role: 'group', 'aria-label': '種別で絞り込み' }, filterButtons),
    ...memoNodes
  );
}

// メモ1件ぶんの表示を作る関数を返す。
function memoCard(inv) {
  return (memo) => {
    const isFact = memo.kind === '事実';
    const meta = `記録: ${formatDisplay(memo.recordedAt)}` + (memo.updatedAt ? ` / 更新: ${formatDisplay(memo.updatedAt)}` : '');
    return h(
      'div',
      { class: `card memo ${isFact ? 'fact' : 'infer'}` },
      h(
        'div',
        { class: 'memo-head' },
        h('span', { text: formatDisplay(memo.observedAt) }),
        h('span', { class: `badge ${isFact ? 'fact' : 'infer'}`, text: `【${memo.kind}】` }),
        h('span', { text: memo.stage })
      ),
      memo.body ? h('div', { class: 'memo-body', text: memo.body }) : null,
      memo.photoIds && memo.photoIds.length ? h('div', { class: 'memo-meta', text: `写真: ${memo.photoIds.length}枚` }) : null,
      h('div', { class: 'memo-meta', text: meta }),
      h('button', { type: 'button', class: 'block', text: '編集', onclick: () => go(`#/inv/${inv.id}/memo/${memo.id}`) })
    );
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
  const initial = memo || { stage: inv.lastStage || '', kind: '', body: '', observedAt: formatObservedInput() };

  const errorBox = h('div', { class: 'error', role: 'alert' });

  // 写真の並び。{ id, blob, url } = 保存済みの写真、{ blob, url } = まだ保存していない写真。
  // 保存ボタンを押すまでは画面の中だけで持ち、押さずに画面を離れたら捨てる。
  const photoItems = (isNew ? [] : await getPhotos(memo.photoIds || [])).map((p) => ({ id: p.id, blob: p.blob, url: null }));
  if (token !== renderToken) return;

  const stageSelect = h(
    'select',
    { id: 'memo-stage' },
    h('option', { value: '', text: '選んでください' }),
    STAGES.map((s) => h('option', { value: s, text: s, selected: s === initial.stage }))
  );

  const kindChoices = KINDS.map((k) =>
    h('label', {}, h('input', { type: 'radio', name: 'kind', value: k, checked: k === initial.kind }), `【${k}】`)
  );

  const bodyInput = h('textarea', { id: 'memo-body' });
  bodyInput.value = initial.body; // 改行をそのまま入れるため value で設定する
  const observedInput = h('input', { type: 'datetime-local', id: 'memo-observed', value: initial.observedAt.slice(0, 16) });

  const saveButton = h('button', { type: 'submit', class: 'primary block', text: '保存' });

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
      onclick: () => {
        // 外すだけ(確認なし)。メモを保存しなければ元に戻る。
        releaseUrl(item);
        photoItems.splice(photoItems.indexOf(item), 1);
        item.el.remove();
        relabelThumbs();
      },
    });
    item.el = h('div', { class: 'thumb-item' }, item.img, item.removeButton);
    thumbList.append(item.el);
  }

  // 選ばれた写真を1枚ずつ順番に縮小する(同時に何枚も処理しない)。
  async function addPhotos(files) {
    if (!files.length || processing) return;
    processing = true;
    photoError.textContent = '';
    [cameraButton, libraryButton, saveButton, deleteButton].forEach((b) => { if (b) b.disabled = true; });
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        photoStatus.textContent = `写真を処理中 ${i + 1}/${files.length}`;
        try {
          const blob = await shrinkToJpeg(files[i]);
          if (!alive) return;
          const item = { blob, url: null };
          photoItems.push(item);
          addThumb(item);
          relabelThumbs();
        } catch (err) {
          failed++;
        }
      }
    } finally {
      processing = false;
      if (alive) {
        photoStatus.textContent = '';
        [cameraButton, libraryButton, saveButton, deleteButton].forEach((b) => { if (b) b.disabled = false; });
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
          await withBusy([saveButton, deleteButton, cameraButton, libraryButton], async () => {
            try {
              await deleteMemo(memo.id);
              goReplace(`#/inv/${invId}`);
              return true;
            } catch (err) {
              errorBox.textContent = errorMessage(err);
            }
          });
        },
      });

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const checked = form.querySelector('input[name="kind"]:checked');
        await withBusy([saveButton, deleteButton, cameraButton, libraryButton], async () => {
          try {
            await saveMemo({
              id: isNew ? null : memo.id,
              investigationId: invId,
              stage: stageSelect.value,
              kind: checked ? checked.value : '',
              body: bodyInput.value,
              observedAt: observedInput.value,
              photos: photoItems.map((p) => (p.id ? { id: p.id } : { blob: p.blob })),
            });
            goReplace(`#/inv/${invId}`);
            return true;
          } catch (err) {
            errorBox.textContent = errorMessage(err);
          }
        });
      },
    },
    h('label', { for: 'memo-stage', text: '段階(必須)' }),
    stageSelect,
    h('div', { class: 'label', text: '種別(必須)' }),
    h('div', { class: 'kind-choices', role: 'radiogroup', 'aria-label': '種別' }, kindChoices),
    h('label', { for: 'memo-body', text: '本文' }),
    bodyInput,
    h('label', { for: 'memo-observed', text: '観測時刻' }),
    observedInput,
    photoArea,
    errorBox,
    saveButton
  );

  show(
    h('button', { type: 'button', class: 'back', text: `← ${inv.name}`, onclick: () => go(`#/inv/${invId}`) }),
    h('h1', { text: isNew ? 'メモを追加' : 'メモを編集' }),
    form,
    deleteButton
  );
  // 画面に出したあとで、写真の表示と後片付けを登録する(show が前の画面の後片付けを先に行うため)
  photoItems.forEach(addThumb);
  relabelThumbs();
  onLeavePage(() => {
    alive = false;
    photoItems.forEach(releaseUrl);
  });
}

// ---- 画面の振り分け ----

let renderToken = 0; // 古い描画が新しい描画を上書きしないための番号

async function route() {
  const token = ++renderToken;
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
      h('h1', { text: '現場調査メモ' }),
      h('p', { class: 'error', text: `画面を表示できませんでした: ${errorMessage(err)}` }),
      h('button', { type: 'button', class: 'primary block', text: '調査一覧へ', onclick: () => { goReplace('#/'); route(); } })
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
