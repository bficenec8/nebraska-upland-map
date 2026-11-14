// Service worker:
//  - caches the app itself so it opens with no signal and installs as an app
//  - serves saved USGS map tiles (saved by offline.js) when there's no signal
const CACHE = 'upland-shell-v16';
const TILE_CACHE = 'upland-tiles-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'offline.js', 'app.js', 'hunt.js', 'manifest.webmanifest', 'icon.svg',
  'data/native_vegetation.geojson', // small, so it's kept for offline use automatically
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we never save stale files.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  const isUsgsTile = url.hostname === 'basemap.nationalmap.gov' && url.pathname.includes('/tile/');
  const isLanduseTile = url.origin === self.location.origin &&
    (url.pathname.includes('/tiles/landuse2005/') || url.pathname.includes('/tiles/gap/'));
  if (isUsgsTile || isLanduseTile) {
    e.respondWith(
      caches.open(TILE_CACHE)
        .then(c => c.match(e.request.url))
        .then(hit => hit || fetch(e.request))
    );
    return;
  }

  // App files: try the network first (so updates show up) but give up after a
  // few seconds on a weak signal and use the saved copy. 'no-cache' makes the
  // browser check with GitHub every time, so the page and scripts always match.
  const isShell = SHELL.some(s => url.href === new URL(s, self.registration.scope).href);
  if (!isShell) return;
  e.respondWith(
    Promise.race([fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }), timeout(4000)])
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || fetch(e.request)))
  );
});
