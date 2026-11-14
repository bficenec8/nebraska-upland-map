// Service worker:
//  - caches the app itself so it opens with no signal and installs as an app
//  - serves saved USGS map tiles (saved by offline.js) when there's no signal
const CACHE = 'upland-shell-v2';
const TILE_CACHE = 'upland-tiles-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'offline.js', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('upland-shell') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Saved map tiles: use the saved copy first, otherwise the network.
  if (url.hostname === 'basemap.nationalmap.gov' && url.pathname.includes('/tile/')) {
    e.respondWith(
      caches.open(TILE_CACHE)
        .then(c => c.match(e.request.url))
        .then(hit => hit || fetch(e.request))
    );
    return;
  }

  // App files: try the network first (so updates show up) but give up after a
  // few seconds on a weak signal and use the saved copy.
  const isShell = SHELL.some(s => url.href === new URL(s, self.registration.scope).href);
  if (!isShell) return;
  e.respondWith(
    Promise.race([fetch(e.request), timeout(4000)])
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || fetch(e.request)))
  );
});
