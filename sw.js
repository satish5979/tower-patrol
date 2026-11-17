/* Offline support: app shell cached on install. Map tiles are cached by the page itself (Cache API 'tp-tiles-v2'). */
const SHELL = 'tp-shell-v2';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'lib/leaflet.js', 'lib/leaflet.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== 'tp-tiles-v2').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // network first for the app itself (so updates arrive), cache when offline
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
