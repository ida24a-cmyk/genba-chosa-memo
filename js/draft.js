// 下書き(書きかけのメモ)まわりの「純粋な処理」をまとめたファイル(第4版)。
// ブラウザの機能に頼らないので、Node でもテストできる。
//
// 下書きは IndexedDB の meta ストア(キーは 'key')に、次の3種類に分けてしまう。
//   文字:  key = 'draft:<調査id>:<メモid>'        新しいメモのメモidは 'new'
//   写真:  key = 'draftphotos:<調査id>:<メモid>'   写真の並び [{ id } | { blobKey }] だけを書く(足した/外したときだけ)
//   写真の中身: key = 'draftblob:<調査id>:<メモid>:<連番>'  新しい写真1枚ずつ。一度だけ書く(並びを書き直しても中身は書き直さない)
// meta ストアを使うのは、DBのバージョンを上げずに済ませるため(古い端末のデータを触らない)。

import { formatDisplay } from './time.js';

export const DRAFT_PREFIX = 'draft:';
export const DRAFT_PHOTOS_PREFIX = 'draftphotos:';
export const DRAFT_BLOB_PREFIX = 'draftblob:';
// キーの範囲指定で「この接頭辞で始まるものすべて」を表すための、十分に大きい末尾の文字
export const KEY_END = String.fromCharCode(0xffff);

// 文字の下書きのキー
export function draftKey(invId, memoId) {
  return `${DRAFT_PREFIX}${invId}:${memoId}`;
}

// 写真の下書きのキー
export function draftPhotosKey(invId, memoId) {
  return `${DRAFT_PHOTOS_PREFIX}${invId}:${memoId}`;
}

// 新しい写真1枚ぶんの中身のキー。n は連番(1から)。'draft:' の範囲指定には入らない名前にしてある。
export function draftBlobKey(invId, memoId, n) {
  return `${DRAFT_BLOB_PREFIX}${invId}:${memoId}:${n}`;
}

// そのメモの写真の中身のキーが並ぶ範囲(開始, 終了)。まとめて消すときに使う。
export function draftBlobRange(invId, memoId) {
  const start = `${DRAFT_BLOB_PREFIX}${invId}:${memoId}:`;
  return [start, start + KEY_END];
}

// 写真の中身のキーから { invId, memoId, n } を取り出す。そうでなければ null。
export function parseDraftBlobKey(key) {
  const s = String(key ?? '');
  if (!s.startsWith(DRAFT_BLOB_PREFIX)) return null;
  const parts = s.slice(DRAFT_BLOB_PREFIX.length).split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) return null;
  return { invId: parts[0], memoId: parts[1], n: Number(parts[2]) };
}

// 次に使う連番(すでにあるキーの最大 + 1。なければ 1)。
export function nextBlobNumber(blobKeys) {
  let max = 0;
  for (const k of blobKeys || []) {
    const parsed = parseDraftBlobKey(k);
    if (parsed && parsed.n > max) max = parsed.n;
  }
  return max + 1;
}

// 書き込み済みの写真の中身のうち、いまの並び(photos)から使われなくなったキー。消してよいもの。
// photos の要素は { id } または { blobKey }。
export function unusedBlobKeys(writtenKeys, photos) {
  const used = new Set((Array.isArray(photos) ? photos : []).filter((p) => p && p.blobKey).map((p) => p.blobKey));
  return [...(writtenKeys || [])].filter((k) => !used.has(k));
}

// キーから { invId, memoId, photos(写真側のキーなら true) } を取り出す。下書きのキーでなければ null。
export function parseDraftKey(key) {
  const s = String(key ?? '');
  let photos;
  let rest;
  if (s.startsWith(DRAFT_PHOTOS_PREFIX)) {
    photos = true;
    rest = s.slice(DRAFT_PHOTOS_PREFIX.length);
  } else if (s.startsWith(DRAFT_PREFIX)) {
    photos = false;
    rest = s.slice(DRAFT_PREFIX.length);
  } else {
    return null;
  }
  const parts = rest.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { invId: parts[0], memoId: parts[1], photos };
}

// 写真の並びを「元からある写真のidの並び」と「新しい写真の数」にまとめる。
// photos の要素は { id }(元からある写真)または { blob }(新しい写真)。
function photoSummary(photos) {
  const list = Array.isArray(photos) ? photos : [];
  return {
    ids: list.filter((p) => p && p.id).map((p) => p.id),
    fresh: list.filter((p) => p && !p.id).length,
  };
}

// 開いたときの内容(initial)と今の内容(current)に違いがあるか。
// 見るのは 段階・種別・本文・観測時刻(分まで)・写真。段階と種別は null と空文字を同じ扱いにする。
export function hasChanges(initial, current) {
  const a = initial || {};
  const b = current || {};
  const text = (v) => (v === null || v === undefined ? '' : String(v));
  if (text(a.stage) !== text(b.stage)) return true;
  if (text(a.kind) !== text(b.kind)) return true;
  if (text(a.body) !== text(b.body)) return true;
  if (text(a.observedAt).slice(0, 16) !== text(b.observedAt).slice(0, 16)) return true;
  const pa = photoSummary(a.photos);
  const pb = photoSummary(b.photos);
  if (pa.fresh !== pb.fresh) return true;
  return pa.ids.join('\n') !== pb.ids.join('\n');
}

// 案内帯に出す1行。「ノート名 / 新しいメモ」または「ノート名 / メモの編集(観測時刻)」。
export function draftLabel({ invName, memoId, memoObservedAt }) {
  const name = invName || '';
  if (memoId === 'new') return `${name} / 新しいメモ`;
  const when = formatDisplay(memoObservedAt);
  return when ? `${name} / メモの編集(${when})` : `${name} / メモの編集`;
}

// 下書きの写真のうち、いま画面に戻せるものだけを残す。
//   photos:      下書きに入っている写真の並び({ id } または { blob, blobKey })
//   currentIds:  いまのメモが持っている写真id(新しいメモのときは空)
// 元の写真({ id })が今のメモに無ければ飛ばす。新しいメモでは {id} はありえないので必ず飛ばす。
export function restorablePhotos(photos, currentIds) {
  const own = new Set(Array.isArray(currentIds) ? currentIds : []);
  const result = [];
  for (const p of Array.isArray(photos) ? photos : []) {
    if (!p) continue;
    if (p.id) {
      if (own.has(p.id)) result.push({ id: p.id });
    } else if (p.blob) {
      result.push(p.blobKey ? { blob: p.blob, blobKey: p.blobKey } : { blob: p.blob });
    }
  }
  return result;
}
