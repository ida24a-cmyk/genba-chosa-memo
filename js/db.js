// 端末内のデータベース(IndexedDB)への読み書きをまとめたファイル。
// データはこの端末の中だけに保存し、ネットワークには送らない。

import { formatLocalTimestamp, normalizeObserved } from './time.js';
import { currentEdition } from './edition.js';
import { normalizeIds } from './select.js';
import {
  DRAFT_PREFIX,
  DRAFT_PHOTOS_PREFIX,
  DRAFT_BLOB_PREFIX,
  KEY_END,
  draftKey,
  draftPhotosKey,
  draftBlobRange,
  parseDraftKey,
  parseDraftBlobKey,
} from './draft.js';

// 調査メモの DB名(これまでのデータの場所。絶対に変えない)。版ごとの DB名は edition.js にある。
export const DB_NAME = 'genba-chosa-memo';
const DB_VERSION = 1;

// 段階(8つ)と種別(2つ)。順番は画面の表示順。
export const STAGES = ['情報収集', '整理', '原因推定', '再現検証', '対策検討', '効果確認', '展開', '再発防止'];
export const KINDS = ['事実', '推論'];
// ノートの種類(第2版)。作成時に選び、あとから変えられない。
export const NOTE_KINDS = ['調査', 'ふつう'];

// ノートの種類を補う(純粋な処理。テストあり)。
// 第1版で作ったデータは種類を持たないので、読み出すときに「調査」として扱う。保存データ自体は書き換えない。
export function withNoteKind(inv) {
  if (!inv) return inv;
  return inv.kind === 'ふつう' || inv.kind === '調査' ? inv : { ...inv, kind: '調査' };
}

// メモの入力を検証する(純粋な処理。テストあり)。
// 調査ノートは段階・種別が必須。ふつうのノートは段階・種別を持たない(null にそろえる)。
// 戻り値: { stage, kind, observedAt(分まで) }。正しくなければ Error を投げる。
export function validateMemoInput(noteKind, input) {
  let stage = null;
  let kind = null;
  if (noteKind !== 'ふつう') {
    if (!STAGES.includes(input.stage)) throw new Error('段階を選んでください');
    if (!KINDS.includes(input.kind)) throw new Error('種別(事実/推論)を選んでください');
    stage = input.stage;
    kind = input.kind;
  }
  if (normalizeObserved(input.observedAt) === null) {
    throw new Error(noteKind === 'ふつう' ? '日時を入力してください' : '観測時刻を入力してください');
  }
  return { stage, kind, observedAt: input.observedAt.slice(0, 16) };
}

// ---- 番号の書式(純粋な処理。テストあり) ----
// 3桁(または6桁)のゼロ埋め。桁があふれたらそのまま桁が増える。
// prefix は版ごとの頭文字(調査メモ='inv'、写真メモ='note')。
export function formatInvestigationId(n, prefix = 'inv') {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
export function formatMemoId(n) {
  return `m-${String(n).padStart(6, '0')}`;
}
export function formatPhotoId(n) {
  return `p-${String(n).padStart(6, '0')}`;
}

// 写真の付け外しの計算(純粋な処理。テストあり)。
// 元の写真idの並び(oldIds)と、保存後に残す並び(keptIds)から、削除する写真idを返す。
export function diffPhotoIds(oldIds, keptIds) {
  const kept = new Set(keptIds);
  return oldIds.filter((id) => !kept.has(id));
}

// ---- IndexedDB の下請け ----

// 1回の要求(request)を Promise にする。
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 取引(transaction)の完了を待つ Promise。
function done(tx) {
  const p = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // 最初に届いた実際のエラーで拒否する(この時点で tx.error が空のことがあるため、イベントの発生元も見る)
    tx.onerror = (e) => reject((e.target && e.target.error) || tx.error || new Error('保存に失敗しました'));
    tx.onabort = (e) => reject(tx.error || (e.target && e.target.error) || new Error('保存が中止されました'));
  });
  // 先に別の処理で失敗した場合でも「未処理の拒否」の警告が出ないようにする。
  // (最後に await した側には、これまでどおりエラーが届く)
  p.catch(() => {});
  return p;
}

// 取引を開いて処理を実行し、完了を待つ。途中で失敗したら取引を中止(それまでの書き込みを取り消す)してエラーを返す。
async function inTx(stores, fn) {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  const finished = done(tx);
  let result;
  try {
    result = await fn(tx);
  } catch (err) {
    try { tx.abort(); } catch (e) { /* すでに終了していれば何もしない */ }
    throw err;
  }
  await finished;
  return result;
}

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(currentEdition().dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      // meta: 採番カウンター(削除しても番号を戻さないために持つ)
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('investigations', { keyPath: 'id' });
      const memos = db.createObjectStore('memos', { keyPath: 'id' });
      memos.createIndex('investigationId', 'investigationId');
      // photos: 縮小済みの写真(JPEG)。メモ・調査の削除時に一緒に消す。
      const photos = db.createObjectStore('photos', { keyPath: 'id' });
      photos.createIndex('memoId', 'memoId');
    };
    open.onsuccess = () => {
      const db = open.result;
      // 別の画面が新しい版に更新しようとしたら、こちらは接続を閉じて邪魔をしない
      db.onclose = () => {
        dbPromise = null; // 閉じられた接続は使い続けない
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('データベースを開けません(他の画面で使用中)'));
  });
  // 失敗したら次回やり直せるように、記憶を捨てる
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// カウンターを1つ進めて、新しい番号を返す(取引の中で呼ぶ)。
async function nextNumber(metaStore, field) {
  const counters = (await req(metaStore.get('counters'))) || {
    key: 'counters',
    investigation: 0,
    memo: 0,
    photo: 0,
  };
  counters[field] = (counters[field] || 0) + 1;
  await req(metaStore.put(counters));
  return counters[field];
}

// ---- 調査 ----

export async function listInvestigations() {
  const db = await openDb();
  const all = await req(db.transaction('investigations').objectStore('investigations').getAll());
  return sortInvestigations(all.map(withNoteKind));
}

// 調査の並び順: id の番号の昇順(= 作成順)。inv-1000 は inv-999 の後に来る。
export function sortInvestigations(list) {
  const num = (id) => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0);
  return [...list].sort((a, b) => num(a.id) - num(b.id));
}

export async function getInvestigation(id) {
  const db = await openDb();
  return withNoteKind((await req(db.transaction('investigations').objectStore('investigations').get(id))) || null);
}

function cleanName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('名前を入力してください');
  return trimmed;
}

export async function createInvestigation(name, kind) {
  const cleaned = cleanName(name);
  // 種類を選ばせない版(写真メモ)は、常に「ふつう」にする
  if (!currentEdition().kindChoice) kind = 'ふつう';
  if (!NOTE_KINDS.includes(kind)) throw new Error('種類(調査/ふつう)を選んでください');
  return inTx(['meta', 'investigations'], async (tx) => {
    const n = await nextNumber(tx.objectStore('meta'), 'investigation');
    const inv = {
      id: formatInvestigationId(n, currentEdition().idPrefix),
      name: cleaned,
      kind, // 'ふつう' | '調査'。作成後は変えない
      createdAt: formatLocalTimestamp(),
      lastStage: null, // その調査ノートで直前に使った段階。初回は null
    };
    tx.objectStore('investigations').put(inv);
    return inv;
  });
}

export async function renameInvestigation(id, name) {
  const cleaned = cleanName(name);
  return inTx(['investigations'], async (tx) => {
    const store = tx.objectStore('investigations');
    const inv = await req(store.get(id));
    if (!inv) throw new Error('ノートが見つかりません');
    inv.name = cleaned;
    store.put(inv);
    return inv;
  });
}

// 調査を削除する。その調査のメモと写真も一緒に削除する。
export async function deleteInvestigation(id) {
  return deleteInvestigations([id]);
}

// 複数の調査を、1つの取引でまとめて削除する(途中で失敗したら何も消えない)。
export async function deleteInvestigations(ids) {
  const list = normalizeIds(ids);
  if (!list.length) return;
  return inTx(['investigations', 'memos', 'photos'], async (tx) => {
    const memoStore = tx.objectStore('memos');
    const photoStore = tx.objectStore('photos');
    for (const id of list) {
      const memos = await req(memoStore.index('investigationId').getAll(id));
      for (const memo of memos) {
        const photoKeys = await req(photoStore.index('memoId').getAllKeys(memo.id));
        for (const key of photoKeys) photoStore.delete(key);
        memoStore.delete(memo.id);
      }
      tx.objectStore('investigations').delete(id);
    }
  });
}

// ---- メモ ----

// その調査のメモを、並べ替えずに返す(並べ替えは time.js の sortMemos を使う)。
export async function listMemos(investigationId) {
  const db = await openDb();
  return req(db.transaction('memos').objectStore('memos').index('investigationId').getAll(investigationId));
}

export async function getMemo(id) {
  const db = await openDb();
  return (await req(db.transaction('memos').objectStore('memos').get(id))) || null;
}

// メモを新規追加または更新する。
// input: { id(編集のときだけ), investigationId, stage, kind, body, observedAt, photos }
//   photos(省略可): 保存後の写真の並び。{ id } = 元からある写真、{ blob } = 新しく足す写真。
//   省略すると写真は変えない。外された写真は photos から削除し、メモと同じ取引で保存する。
//   draftKeys(省略可): 保存と同じ取引で消す下書きのキー(文字と写真の並び。写真の中身も一緒に消す)。下書きのキー以外は受け付けない。
// 段階・種別・観測時刻が正しくなければエラーにする(保存しない)。
// 保存のたびに、調査の lastStage をこのメモの段階に更新する。
export async function saveMemo(input) {
  const body = String(input.body ?? '');
  // 下書き以外のキー(採番カウンターなど)を巻き込んで消さないよう、先に確かめる
  const draftKeys = Array.isArray(input.draftKeys) ? input.draftKeys : [];
  if (!draftKeys.every((k) => parseDraftKey(k))) throw new Error('下書きのキーが不正です');

  return inTx(['meta', 'investigations', 'memos', 'photos'], async (tx) => {
    const memoStore = tx.objectStore('memos');
    const invStore = tx.objectStore('investigations');

    const inv = withNoteKind(await req(invStore.get(input.investigationId)));
    if (!inv) throw new Error('ノートが見つかりません');
    // 調査ノートだけ段階・種別が必須。ふつうのノートは null で保存する
    const { stage, kind, observedAt } = validateMemoInput(inv.kind, input);

    const now = formatLocalTimestamp();
    let memo;
    if (input.id) {
      memo = await req(memoStore.get(input.id));
      if (!memo) throw new Error('メモが見つかりません');
      // 別の調査のメモを書き換えないための確認
      if (memo.investigationId !== input.investigationId) throw new Error('メモが見つかりません');
      memo.stage = stage;
      memo.kind = kind;
      memo.body = body;
      memo.observedAt = observedAt;
      memo.updatedAt = now; // 記録時刻は変えない
    } else {
      const n = await nextNumber(tx.objectStore('meta'), 'memo');
      memo = {
        id: formatMemoId(n),
        investigationId: input.investigationId,
        stage,
        kind,
        body,
        observedAt,
        recordedAt: now,
        updatedAt: null, // 未編集
        photoIds: [], // 添付した写真のid(添付順)
      };
    }
    if (Array.isArray(input.photos)) {
      const photoStore = tx.objectStore('photos');
      const oldIds = memo.photoIds || [];
      const newIds = [];
      for (const item of input.photos) {
        if (item.id) {
          if (!oldIds.includes(item.id)) throw new Error('写真が見つかりません');
          newIds.push(item.id);
        } else {
          if (!(item.blob instanceof Blob)) throw new Error('写真のデータが不正です');
          const pid = formatPhotoId(await nextNumber(tx.objectStore('meta'), 'photo'));
          photoStore.put({ id: pid, memoId: memo.id, blob: item.blob });
          newIds.push(pid);
        }
      }
      for (const id of diffPhotoIds(oldIds, newIds)) photoStore.delete(id);
      memo.photoIds = newIds;
    }
    memoStore.put(memo);
    // 下書きは、メモの保存と同じ取引で消す(保存が失敗すれば下書きも残る)
    // 文字・写真の並びのほか、そのメモの下書きの写真の中身もすべて消す
    for (const key of draftKeys) {
      const parsed = parseDraftKey(key);
      const metaStore = tx.objectStore('meta');
      metaStore.delete(key);
      const [start, end] = draftBlobRange(parsed.invId, parsed.memoId);
      metaStore.delete(IDBKeyRange.bound(start, end));
    }
    if (inv.kind === '調査') {
      // 保存データに種類が無い第1版のノートも、ここでは変えずに lastStage だけ更新する
      const raw = await req(invStore.get(inv.id));
      raw.lastStage = stage;
      invStore.put(raw);
    }
    return memo;
  });
}

// 写真(id の並びの順)を取り出す。見つからない id は飛ばす。
export async function getPhotos(ids) {
  const db = await openDb();
  const store = db.transaction('photos').objectStore('photos');
  const result = [];
  for (const id of ids) {
    const photo = await req(store.get(id));
    if (photo) result.push({ id: photo.id, blob: photo.blob });
  }
  return result;
}

// メモを削除する。そのメモの写真も一緒に削除する。
export async function deleteMemo(id) {
  return deleteMemos([id]);
}

// 複数のメモを、1つの取引でまとめて削除する(写真も一緒。途中で失敗したら何も消えない)。
export async function deleteMemos(ids) {
  const list = normalizeIds(ids);
  if (!list.length) return;
  return inTx(['memos', 'photos'], async (tx) => {
    const photoStore = tx.objectStore('photos');
    for (const id of list) {
      const photoKeys = await req(photoStore.index('memoId').getAllKeys(id));
      for (const key of photoKeys) photoStore.delete(key);
      tx.objectStore('memos').delete(id);
    }
  });
}

// ---- 下書き(第4版) ----
// 書きかけのメモを meta ストアにしまう(DBのバージョンは上げない)。キーの形式は draft.js を参照。
// 文字:       { key, invId, memoId, stage, kind, body, observedAt, savedAt }
// 写真の並び: { key, photos: [{ id } | { blobKey }] }(写真を足した/外したときだけ書く)
// 写真の中身: { key, blob }(新しい写真1枚ずつ。一度だけ書く)
// 書く順番は 文字 → 写真の中身 → 写真の並び(「並びにあるのに中身が無い」状態を作らないため)。

// そのメモの下書きの写真の中身をすべて消す(取引の中で呼ぶ)。
function deleteDraftBlobsOf(store, invId, memoId) {
  const [start, end] = draftBlobRange(invId, memoId);
  store.delete(IDBKeyRange.bound(start, end));
}

// 文字の下書きを書く(同じメモの下書きは上書き)。
export async function putDraftText(draft) {
  return inTx(['meta'], async (tx) => {
    tx.objectStore('meta').put({
      key: draftKey(draft.invId, draft.memoId),
      invId: draft.invId,
      memoId: draft.memoId,
      stage: draft.stage ?? '',
      kind: draft.kind ?? '',
      body: String(draft.body ?? ''),
      observedAt: String(draft.observedAt ?? ''),
      savedAt: formatLocalTimestamp(),
    });
  });
}

// 新しい写真1枚ぶんの中身を書く。key は draftBlobKey() で作ったもの。
export async function putDraftBlob(key, blob) {
  if (!parseDraftBlobKey(key)) throw new Error('下書きのキーが不正です');
  return inTx(['meta'], async (tx) => {
    tx.objectStore('meta').put({ key, blob });
  });
}

// 使わなくなった写真の中身を消す。
export async function deleteDraftBlobs(keys) {
  const list = (keys || []).filter((k) => parseDraftBlobKey(k));
  if (!list.length) return;
  return inTx(['meta'], async (tx) => {
    for (const k of list) tx.objectStore('meta').delete(k);
  });
}

// 写真の並びの下書きを書く。photos は { id }(元からある写真)または { blobKey }(新しい写真)の並び。
export async function putDraftPhotos(invId, memoId, photos) {
  const list = (photos || []).map((p) => (p.id ? { id: p.id } : { blobKey: p.blobKey }));
  return inTx(['meta'], async (tx) => {
    tx.objectStore('meta').put({ key: draftPhotosKey(invId, memoId), photos: list });
  });
}

// 下書きを読む(文字と写真を合わせて返す)。文字の下書きが無ければ null。
// photos は、写真の並びの下書きが無ければ null(= 写真は元のまま)。
// あれば { id } または { blob, blobKey } の並び。中身が見つからない写真は飛ばす。
export async function getDraft(invId, memoId) {
  const db = await openDb();
  const store = db.transaction('meta').objectStore('meta');
  const text = await req(store.get(draftKey(invId, memoId)));
  if (!text) return null;
  const record = await req(store.get(draftPhotosKey(invId, memoId)));
  let photos = null;
  if (record && Array.isArray(record.photos)) {
    photos = [];
    for (const p of record.photos) {
      if (p && p.id) {
        photos.push({ id: p.id });
      } else if (p && p.blobKey && parseDraftBlobKey(p.blobKey)) {
        const stored = await req(store.get(p.blobKey));
        if (stored && stored.blob) photos.push({ blob: stored.blob, blobKey: p.blobKey });
      }
    }
  }
  return {
    invId: text.invId,
    memoId: text.memoId,
    stage: text.stage ?? '',
    kind: text.kind ?? '',
    body: text.body ?? '',
    observedAt: text.observedAt ?? '',
    savedAt: text.savedAt ?? '',
    photos,
  };
}

// そのメモの下書き(文字・写真の並び・写真の中身)をすべて消す。無ければ何もしない。
export async function deleteDraft(invId, memoId) {
  return inTx(['meta'], async (tx) => {
    const store = tx.objectStore('meta');
    store.delete(draftKey(invId, memoId));
    store.delete(draftPhotosKey(invId, memoId));
    deleteDraftBlobsOf(store, invId, memoId);
  });
}

// 下書きの一覧(新しい順)。invId を渡すと、そのノートの下書きだけ。
// もう無いノート・メモの下書きは、ここで消して一覧に出さない。
// 戻り値: [{ invId, memoId, invName, memoObservedAt(新しいメモは null), savedAt }]
export async function listDrafts(invId = null) {
  const db = await openDb();
  const tx = db.transaction(['meta', 'investigations', 'memos']);
  const meta = tx.objectStore('meta');
  const textRange = IDBKeyRange.bound(DRAFT_PREFIX, DRAFT_PREFIX + KEY_END);
  const photoRange = IDBKeyRange.bound(DRAFT_PHOTOS_PREFIX, DRAFT_PHOTOS_PREFIX + KEY_END);
  const blobRange = IDBKeyRange.bound(DRAFT_BLOB_PREFIX, DRAFT_BLOB_PREFIX + KEY_END);
  const texts = await req(meta.getAll(textRange)); // 写真のキー('draftphotos:' など)はこの範囲に入らない
  // 写真の並び・中身は大きいので、中身は読まずキーだけ取る
  const photoKeys = await req(meta.getAllKeys(photoRange));
  const blobKeys = await req(meta.getAllKeys(blobRange));

  const result = [];
  const staleMemos = new Map(); // 片付けるメモ('invId:memoId' → { invId, memoId })
  const textKeys = new Set();
  for (const d of texts) {
    textKeys.add(d.key);
    const parsed = parseDraftKey(d.key);
    if (!parsed) continue;
    if (invId && parsed.invId !== invId) continue;
    const inv = await req(tx.objectStore('investigations').get(parsed.invId));
    let memo = null;
    if (inv && parsed.memoId !== 'new') {
      memo = await req(tx.objectStore('memos').get(parsed.memoId));
      if (memo && memo.investigationId !== parsed.invId) memo = null;
    }
    if (!inv || (parsed.memoId !== 'new' && !memo)) {
      staleMemos.set(`${parsed.invId}:${parsed.memoId}`, parsed);
      continue;
    }
    result.push({
      invId: parsed.invId,
      memoId: parsed.memoId,
      invName: inv.name,
      memoObservedAt: memo ? memo.observedAt : null,
      savedAt: d.savedAt || '',
    });
  }
  // 文字の下書きが無いのに残っている、写真の並び・写真の中身も片付ける
  for (const k of [...photoKeys, ...blobKeys]) {
    const parsed = parseDraftKey(k) || parseDraftBlobKey(k);
    if (!parsed) continue;
    if (invId && parsed.invId !== invId) continue;
    if (!textKeys.has(draftKey(parsed.invId, parsed.memoId))) staleMemos.set(`${parsed.invId}:${parsed.memoId}`, parsed);
  }

  if (staleMemos.size) {
    try {
      await inTx(['meta'], async (wtx) => {
        const store = wtx.objectStore('meta');
        for (const { invId: i, memoId: m } of staleMemos.values()) {
          store.delete(draftKey(i, m));
          store.delete(draftPhotosKey(i, m));
          deleteDraftBlobsOf(store, i, m);
        }
      });
    } catch (err) {
      // 片付けに失敗しても、一覧の表示は続ける
    }
  }
  result.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return result;
}
