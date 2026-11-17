/* Offline support: app shell cached on install; map tiles cached as they are viewed. */
const SHELL = 'tp-shell-v1';
const TILES = 'tp-tiles-v1';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'lib/leaflet.js', 'lib/leaflet.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      try {
        const res = await fetch(e.request.url, { mode: 'no-cors' });
        if (res.ok || res.type === 'opaque') c.put(e.request.url, res.clone());
        return res;
      } catch (err) { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // network first for the app itself (so updates arrive), cache when offline
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
  }
});
