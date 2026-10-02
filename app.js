// 事前検証用テストページ(SPEC.md 1.5)
// 架空のテキスト1つと画像1つを入れた無圧縮ZIPを作り、共有またはダウンロードを試す。
// 外部への通信は一切行わない。
'use strict';

const $ = (id) => document.getElementById(id);

// ページを開いた時点で作っておくテスト画像(JPEG)のバイト列。
// ボタンを押してから画像を作ると時間がかかり、iPhone が「操作直後ではない」と
// 判断して共有を断ることがあるため、先に用意しておく。
let sampleJpeg = null;

// ---------- CRC32(ZIPの検査用の値) ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- 無圧縮ZIPの作成 ----------
// files: [{ name: 'a.txt', data: Uint8Array }] 名前は英数字のみを想定する。
function buildZip(files, date) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    // ローカルファイルヘッダー
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 10, true);        // 展開に必要なバージョン
    local.setUint16(6, 0, true);         // フラグ
    local.setUint16(8, 0, true);         // 圧縮方式:無圧縮
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    // 中央ディレクトリ(ファイル一覧)
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);      // 作成したバージョン
    central.setUint16(6, 10, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, file.name.endsWith('/') ? 0x10 : 0, true); // フォルダの印
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);

  // 終端レコード
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- テスト用の中身 ----------
function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

function sampleText(date) {
  return [
    'これは事前検証用の架空のテキストです。',
    '実在の調査とは関係ありません。',
    '',
    `作成: ${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    '',
  ].join('\n');
}

// 架空のテスト画像を端末内で描いてJPEGにする(外部から取得しない)
function makeSampleJpeg() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#dbeafe';
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#1a5fb4';
  ctx.fillRect(40, 40, 560, 400);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('TEST IMAGE', 320, 230);
  ctx.font = '28px sans-serif';
  ctx.fillText('dummy data', 320, 290);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('画像を作れませんでした'));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, 'image/jpeg', 0.8);
  });
}

function makeZipFile() {
  const now = new Date();
  const zip = buildZip([
    { name: 'sample.txt', data: new TextEncoder().encode(sampleText(now)) },
    { name: 'photos/', data: new Uint8Array(0) },
    { name: 'photos/sample_01.jpg', data: sampleJpeg },
  ], now);
  const name = `test_${stamp(now)}.zip`;
  return new File([zip], name, { type: 'application/zip' });
}

// ---------- 保存の方法 ----------
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

function canShareFile(file) {
  if (typeof navigator.canShare !== 'function') {
    return { ok: false, text: 'false(この端末には canShare がありません)' };
  }
  try {
    const ok = navigator.canShare({ files: [file] });
    return { ok, text: String(ok) };
  } catch (err) {
    return { ok: false, text: `false(エラー: ${err.name})` };
  }
}

function onShare() {
  let file;
  try {
    file = makeZipFile();
  } catch (err) {
    $('result').textContent = `ZIPを作れませんでした(${err.name}: ${err.message})`;
    return;
  }

  const check = canShareFile(file);
  $('canshare').textContent = check.text;

  if (check.ok && typeof navigator.share === 'function') {
    $('result').textContent = `共有シートを開きます(${file.name} / ${file.size} バイト)`;
    navigator.share({ files: [file] }).then(
      () => {
        $('result').textContent = `共有が完了しました(${file.name})`;
      },
      (err) => {
        if (err.name === 'AbortError') {
          $('result').textContent = '共有シートが閉じられました(キャンセル)';
        } else {
          $('result').textContent = `共有に失敗しました(${err.name}: ${err.message})`;
        }
      },
    );
  } else {
    download(file);
    $('result').textContent = `共有できないため、ダウンロードを試しました(${file.name} / ${file.size} バイト)`;
  }
}

function onDownload() {
  try {
    const file = makeZipFile();
    download(file);
    $('result').textContent = `ダウンロードを試しました(${file.name} / ${file.size} バイト)`;
  } catch (err) {
    $('result').textContent = `ダウンロードに失敗しました(${err.name}: ${err.message})`;
  }
}

function showMode() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('mode').textContent = standalone ? 'ホーム画面から起動しています' : 'ブラウザ(Safari など)で開いています';
}

function init() {
  showMode();
  $('btn-share').addEventListener('click', onShare);
  $('btn-download').addEventListener('click', onDownload);
  makeSampleJpeg().then(
    (bytes) => {
      sampleJpeg = bytes;
      $('ready').textContent = `完了(${bytes.length} バイト)`;
      $('btn-share').disabled = false;
      $('btn-download').disabled = false;
    },
    (err) => {
      $('ready').textContent = `失敗しました(${err.message})`;
    },
  );
}

init();
