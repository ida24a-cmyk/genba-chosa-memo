// Service Worker: アプリ本体を端末にしまっておき、電波がなくても起動できるようにする。
// 触るのは「同じ配信元の GET(読み込み)」だけ。それ以外の通信には一切関わらない。
//
// 【アプリを更新したとき】
//   1. 下の CACHE_NAME の番号を上げる(古い保存分は activate で自動的に消える)。
//   2. 新しいファイルを足したときは、APP_FILES にも書き足す。
// データ(メモ・写真)は IndexedDB にあるので、ここを更新しても消えない。

const CACHE_NAME = 'genba-chosa-memo-v1';

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
      // 古い版の保存分を消す
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // 同じ配信元の GET 以外は、何もしない(ブラウザにそのまま任せる)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      // 保存済みのものを優先。なければネットから取る。
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(request);
      } catch (err) {
        // 画面の読み込みで取得できないときは、アプリ本体のページを返す
        if (request.mode === 'navigate') {
          const fallback = (await caches.match('./index.html')) || (await caches.match('./'));
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
