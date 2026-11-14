// Service worker: caches the app itself so it opens quickly and installs as an app.
// Map tiles and land data still need a connection (offline maps come later).
const CACHE = 'upland-shell-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files: try the network first (so updates show up), fall back to the cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isShell = SHELL.some(s => url.href === new URL(s, self.registration.scope).href);
  if (e.request.method !== 'GET' || !isShell) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request))
  );
});
