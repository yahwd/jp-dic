/* 雪妖精の辭書 — Service Worker
 * 更換 data 檔案或大幅改版時，請同步把這裡與 assets/app.js 的 CACHE_NAME 版本號一起加 1。 */
const CACHE_NAME = 'yukiyosei-v31';

const SHELL = [
  './',
  './index.html',
  './assets/firebase-config.js',
  './assets/firebase-config.js?v=31',
  './assets/app.js',
  './assets/app.js?v=31',
  './assets/style.css',
  './manifest.webmanifest',
  './manifest.webmanifest?v=2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192.png?v=2',
  './icons/apple-touch-icon.png?v=2',
  './icons/favicon-32.png?v=2',
  './icons/logo-72.png?v=2',
  './icons/logo-108.png?v=2',
  './icons/avatar-guest.png',
  './icons/avatar-user.png',
  './icons/celebrate-bird.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('yukiyosei-') && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 有網路時優先抓最新程式與設定檔並更新快取；離線時退回本機快取
function networkFirst(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    fetch(request).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(request, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => cache.match(request))
  );
}

function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((hit) => {
      const network = fetch(request).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
}

// 詞庫檔案由頁面自己負責寫入快取（避免 32 MB 寫兩次）；這裡只負責「有快取就直接給」
function dataFromCache(request) {
  return caches.open(CACHE_NAME).then((cache) =>
    cache.match(request).then((hit) => hit || fetch(request))
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase 與翻譯 API 等外部網路請求不介入
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/data/')) {
      event.respondWith(dataFromCache(req));
    } else if (
      req.mode === 'navigate' ||
      url.pathname.endsWith('.html') ||
      url.pathname.endsWith('.js') ||
      url.pathname.endsWith('.css')
    ) {
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req));
  }
});
