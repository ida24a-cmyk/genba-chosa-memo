// 調査の書き出し(ZIP作成と受け渡し)。
// ZIPの中身: <調査id>_<書き出し日時>.md と photos/ フォルダ。
// 通信は一切しない。端末内で作ったZIPを、共有シートまたはダウンロードで渡すだけ。

import { listMemos, getPhotos } from './db.js';
import { sortMemos, formatLocalTimestamp, formatDisplay, formatFileStamp } from './time.js';
import { buildZip } from './zip.js';

// ---- 名前・番号の決め方(純粋な処理。テストあり) ----

// ZIP名の「拡張子を除いた部分」。mdファイル名にも同じものを使う。
export function exportBaseName(investigationId, exportedAt) {
  return `${investigationId}_${formatFileStamp(exportedAt)}`;
}

// 写真ファイル名: <調査id>_<観測日時 YYYYMMDD-HHMM>_<連番>.jpg(連番は0埋め済みの文字列)
export function photoFileName(investigationId, observedAt, seq, digits) {
  return `${investigationId}_${formatFileStamp(observedAt)}_${String(seq).padStart(digits, '0')}.jpg`;
}

// 写真の連番を振る。
// memos は sortMemos で並べ終えたもの。「並び順の先頭のメモから順に、各メモ内は photoIds の順」に、
// 調査全体の通し番号を 001 から振る。総数が1000枚以上なら全体を4桁にする。
// 戻り値: { names: Map(メモid → 写真ファイル名の配列, photoIds と同じ順), total }
export function assignPhotoNames(investigationId, memos) {
  const total = memos.reduce((sum, m) => sum + (m.photoIds ? m.photoIds.length : 0), 0);
  const digits = total >= 1000 ? 4 : 3;
  const names = new Map();
  let seq = 0;
  for (const memo of memos) {
    const list = [];
    for (const _photoId of memo.photoIds || []) {
      seq += 1;
      list.push(photoFileName(investigationId, memo.observedAt, seq, digits));
    }
    names.set(memo.id, list);
  }
  return { names, total };
}

// mdファイルの本文を作る(改行は LF、末尾は改行1つ)。
// investigation: { id, name, createdAt }
// memos: sortMemos で並べ終えたもの
// photoNames: assignPhotoNames の names
// exportedAt: 書き出した瞬間の現地時刻(保存用の形式の文字列)
// メモが0件のときは、見出し部分(調査名〜書き出し)だけを出す。
export function buildMarkdown(investigation, memos, photoNames, exportedAt) {
  const header = [
    `# ${investigation.name}`,
    '',
    `- 調査ID: ${investigation.id}`,
    `- 作成: ${formatDisplay(investigation.createdAt)}`,
    `- 書き出し: ${formatDisplay(exportedAt)}`,
  ].join('\n');

  const blocks = memos.map((memo) => {
    const paragraphs = [];
    if (memo.body.trim() !== '') paragraphs.push(memo.body.replace(/\r\n?/g, '\n'));
    for (const name of photoNames.get(memo.id) || []) paragraphs.push(`![](photos/${name})`);
    let meta = `記録: ${formatDisplay(memo.recordedAt)}`;
    if (memo.updatedAt) meta += ` / 更新: ${formatDisplay(memo.updatedAt)}`;
    paragraphs.push(meta);
    return `## ${formatDisplay(memo.observedAt)} 【${memo.kind}】${memo.stage}\n\n${paragraphs.join('\n\n')}`;
  });

  return [header, ...blocks].join('\n\n---\n\n') + '\n';
}

// ---- ZIPの作成 ----

// 調査1件ぶんのZIPを作り、{ file, name } を返す。
// 絞り込みに関係なく、その調査のすべてのメモを含める。
export async function prepareExport(investigation, now = new Date()) {
  const exportedAt = formatLocalTimestamp(now);
  const base = exportBaseName(investigation.id, exportedAt);

  const memos = sortMemos(await listMemos(investigation.id));

  // 写真を読み出す(見つからない写真は飛ばす)
  const photoBlobs = new Map(); // メモid → [{ id, blob }]
  for (const memo of memos) {
    photoBlobs.set(memo.id, memo.photoIds && memo.photoIds.length ? await getPhotos(memo.photoIds) : []);
  }
  const memosForNaming = memos.map((m) => ({ ...m, photoIds: photoBlobs.get(m.id).map((p) => p.id) }));
  const { names } = assignPhotoNames(investigation.id, memosForNaming);

  const md = buildMarkdown(investigation, memos, names, exportedAt);
  const files = [
    { name: `${base}.md`, data: new TextEncoder().encode(md) }, // UTF-8・BOMなし
    { name: 'photos/', data: new Uint8Array(0) },
  ];
  // 写真は1枚ずつ順に読み出す(同時に読むとメモリが増えるため)
  for (const memo of memos) {
    const photos = photoBlobs.get(memo.id);
    for (let i = 0; i < photos.length; i++) {
      const buf = await photos[i].blob.arrayBuffer();
      files.push({ name: `photos/${names.get(memo.id)[i]}`, data: new Uint8Array(buf) });
    }
  }

  const zip = buildZip(files, now);
  const fileName = `${base}.zip`;
  return { file: new File([zip], fileName, { type: 'application/zip' }), name: fileName };
}

// ---- 受け渡し ----

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐ消すと iPhone で保存に失敗することがあるため、少し待ってから片付ける
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ZIPを渡す。共有できる端末なら共有シート、できなければダウンロード。
// isRetry: 一度「もう一度押してください」と出したあとの押下かどうか。
// 戻り値: 'shared'(共有した) / 'downloaded'(共有できない端末なのでダウンロードした) /
//         'fallback'(共有に失敗したのでダウンロードに切り替えた) / 'cancelled'(利用者が閉じた) /
//         'retry'(もう一度押す必要がある)
export async function deliverZip(file, isRetry = false) {
  let canShare = false;
  try {
    canShare = typeof navigator.canShare === 'function' && typeof navigator.share === 'function' && navigator.canShare({ files: [file] });
  } catch (err) {
    canShare = false;
  }
  if (!canShare) {
    download(file);
    return 'downloaded';
  }
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled'; // 利用者がキャンセル
    // 操作直後でないと断られた。1回目は「もう一度押してください」、2回目も断られたらダウンロードに切り替える
    if (err && err.name === 'NotAllowedError' && !isRetry) return 'retry';
    // それ以外の失敗でも、書き出したZIPを無駄にしないようダウンロードに切り替える
    download(file);
    return 'fallback';
  }
}
