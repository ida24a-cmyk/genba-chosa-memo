// Service Worker: アプリ本体を端末にしまっておき、電波がなくても起動できるようにする。
// 触るのは「同じ配信元の GET(読み込み)」だけ。それ以外の通信には一切関わらない。
//
// 【アプリを更新したとき】
//   1. 下の CACHE_NAME の番号を上げる(古い保存分は activate で自動的に消える)。
//      共通の部品(css、js)を直したときは、写真メモ側(memo/sw.js)の番号も上げること。
//   2. 新しいファイルを足したときは、APP_FILES にも書き足す。
// データ(メモ・写真)は IndexedDB にあるので、ここを更新しても消えない。
//
// これは「調査メモ」(ルート)用。「写真メモ」(memo/ 以下)は memo/sw.js が別に持つ。
// 保存名の頭(CACHE_PREFIX)を版ごとに分けてあり、古い保存分の削除は自分の版の分だけを対象にする。

const CACHE_PREFIX = 'genba-chosa-memo-';
const CACHE_NAME = CACHE_PREFIX + 'v3';

// 写真メモの住所(memo/ 以下)。ここへの読み込みには一切関わらない(写真メモ側の Service Worker に任せる)。
const MEMO_DIR = new URL('./memo/', self.registration.scope).pathname; // 例: /genba-chosa-memo/memo/
function isMemoEdition(url) {
  return url.pathname.startsWith(MEMO_DIR) || url.pathname === MEMO_DIR.slice(0, -1);
}

const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/time.js',
  './js/photo.js',
  './js/zip.js',
  './js/export.js',
  './js/edition.js',
  './js/select.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // ブラウザの一時保存ではなく、必ず配信元の最新ファイルを取得して保存する
      await cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting(); // 新しい版をすぐ使い始める
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 自分の版の古い保存分だけを消す(写真メモの保存分は消さない)
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // 同じ配信元の GET 以外は、何もしない(ブラウザにそのまま任せる)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // 写真メモの住所は横取りしない(電波がないときに調査メモの画面が返るのを防ぐ)
  if (isMemoEdition(url)) return;

  event.respondWith(
    (async () => {
      // 保存済みのものを優先。なければネットから取る。
      // 自分の版の保存分だけを見る(相手の版の保存分は使わない)
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (err) {
        // 画面の読み込みで取得できないときは、アプリ本体のページを返す
        if (request.mode === 'navigate') {
          const fallback = (await cache.match('./index.html')) || (await cache.match('./'));
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
