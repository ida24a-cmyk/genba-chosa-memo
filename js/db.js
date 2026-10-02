// 端末内のデータベース(IndexedDB)への読み書きをまとめたファイル。
// データはこの端末の中だけに保存し、ネットワークには送らない。

import { formatLocalTimestamp, normalizeObserved } from './time.js';

export const DB_NAME = 'genba-chosa-memo';
const DB_VERSION = 1;

// 段階(8つ)と種別(2つ)。順番は画面の表示順。
export const STAGES = ['情報収集', '整理', '原因推定', '再現検証', '対策検討', '効果確認', '展開', '再発防止'];
export const KINDS = ['事実', '推論'];

// ---- 番号の書式(純粋な処理。テストあり) ----
// 3桁(または6桁)のゼロ埋め。桁があふれたらそのまま桁が増える。
export function formatInvestigationId(n) {
  return `inv-${String(n).padStart(3, '0')}`;
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
    const open = indexedDB.open(DB_NAME, DB_VERSION);
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
  return sortInvestigations(all);
}

// 調査の並び順: id の番号の昇順(= 作成順)。inv-1000 は inv-999 の後に来る。
export function sortInvestigations(list) {
  const num = (id) => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0);
  return [...list].sort((a, b) => num(a.id) - num(b.id));
}

export async function getInvestigation(id) {
  const db = await openDb();
  return (await req(db.transaction('investigations').objectStore('investigations').get(id))) || null;
}

function cleanName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('名前を入力してください');
  return trimmed;
}

export async function createInvestigation(name) {
  const cleaned = cleanName(name);
  return inTx(['meta', 'investigations'], async (tx) => {
    const n = await nextNumber(tx.objectStore('meta'), 'investigation');
    const inv = {
      id: formatInvestigationId(n),
      name: cleaned,
      createdAt: formatLocalTimestamp(),
      lastStage: null, // その調査で直前に使った段階。初回は null
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
    if (!inv) throw new Error('調査が見つかりません');
    inv.name = cleaned;
    store.put(inv);
    return inv;
  });
}

// 調査を削除する。その調査のメモと写真も一緒に削除する。
export async function deleteInvestigation(id) {
  return inTx(['investigations', 'memos', 'photos'], async (tx) => {
    const memoStore = tx.objectStore('memos');
    const photoStore = tx.objectStore('photos');
    const memos = await req(memoStore.index('investigationId').getAll(id));
    for (const memo of memos) {
      const photoKeys = await req(photoStore.index('memoId').getAllKeys(memo.id));
      for (const key of photoKeys) photoStore.delete(key);
      memoStore.delete(memo.id);
    }
    tx.objectStore('investigations').delete(id);
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
// 段階・種別・観測時刻が正しくなければエラーにする(保存しない)。
// 保存のたびに、調査の lastStage をこのメモの段階に更新する。
export async function saveMemo(input) {
  if (!STAGES.includes(input.stage)) throw new Error('段階を選んでください');
  if (!KINDS.includes(input.kind)) throw new Error('種別(事実/推論)を選んでください');
  if (normalizeObserved(input.observedAt) === null) throw new Error('観測時刻を入力してください');
  const observedAt = input.observedAt.slice(0, 16); // 分まで
  const body = String(input.body ?? '');

  return inTx(['meta', 'investigations', 'memos', 'photos'], async (tx) => {
    const memoStore = tx.objectStore('memos');
    const invStore = tx.objectStore('investigations');

    const inv = await req(invStore.get(input.investigationId));
    if (!inv) throw new Error('調査が見つかりません');

    const now = formatLocalTimestamp();
    let memo;
    if (input.id) {
      memo = await req(memoStore.get(input.id));
      if (!memo) throw new Error('メモが見つかりません');
      // 別の調査のメモを書き換えないための確認
      if (memo.investigationId !== input.investigationId) throw new Error('メモが見つかりません');
      memo.stage = input.stage;
      memo.kind = input.kind;
      memo.body = body;
      memo.observedAt = observedAt;
      memo.updatedAt = now; // 記録時刻は変えない
    } else {
      const n = await nextNumber(tx.objectStore('meta'), 'memo');
      memo = {
        id: formatMemoId(n),
        investigationId: input.investigationId,
        stage: input.stage,
        kind: input.kind,
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
    inv.lastStage = input.stage;
    invStore.put(inv);
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
  return inTx(['memos', 'photos'], async (tx) => {
    const photoStore = tx.objectStore('photos');
    const photoKeys = await req(photoStore.index('memoId').getAllKeys(id));
    for (const key of photoKeys) photoStore.delete(key);
    tx.objectStore('memos').delete(id);
  });
}
