/* Offline storage for the Upland Map.
 *  - Map tiles (USGS, public domain) are saved in Cache Storage; the service
 *    worker serves them when there's no signal.
 *  - Public access layers and parcels are saved in IndexedDB.
 * Only USGS base maps are saved: Esri and OpenStreetMap terms don't allow
 * bulk downloading for offline use.
 */
'use strict';

const Offline = (() => {
  const DB_NAME = 'upland-offline';
  const TILE_CACHE = 'upland-tiles-v1';
  const NE_BOUNDS = [[39.95, -104.1], [43.05, -95.25]];
  const USGS = (svc) => `https://basemap.nationalmap.gov/arcgis/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
  const TILE_SOURCES = {
    usgs: USGS('USGSImageryTopo'), topo: USGS('USGSTopo'),
    // UNL 2005 land use tiles hosted with the app (only exist up to zoom 12, only inside Nebraska)
    landuse: new URL('tiles/landuse2005/{z}/{x}/{y}.png', location.href).href,
    gap: new URL('tiles/gap/{z}/{x}/{y}.png', location.href).href,
  };
  const SOURCE_MAX_ZOOM = { landuse: 12, gap: 12 };
  const isHostedTile = (url) => url.includes('/tiles/landuse2005/') || url.includes('/tiles/gap/');
  const maxZoomFor = (src, z) => Math.min(z, SOURCE_MAX_ZOOM[src] || 99);
  const AREA_MIN_ZOOM = 10;
  const OVERVIEW_ZOOMS = [6, 9];
  const AVG_TILE_KB = 20;
  const MAX_TILES = 15000;
  const MAX_PARCELS = 40000;

  // ---------------- IndexedDB ----------------
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('kv');
          req.result.createObjectStore('areas', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  const kvGet = (k) => tx('kv', 'readonly', s => s.get(k));
  const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
  const listAreas = () => tx('areas', 'readonly', s => s.getAll());
  const putArea = (a) => tx('areas', 'readwrite', s => s.put(a));
  const removeArea = (id) => tx('areas', 'readwrite', s => s.delete(id));

  // ---------------- Tile math ----------------
  const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
  const lat2y = (lat, z) => {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z);
  };
  function tileRange(b, z) {
    return { x0: lon2x(b[0][1], z), x1: lon2x(b[1][1], z), y0: lat2y(b[1][0], z), y1: lat2y(b[0][0], z) };
  }
  function tileUrls(b, z0, z1, sources, out = new Set()) {
    for (const src of sources) {
      for (let z = z0; z <= maxZoomFor(src, z1); z++) {
        const r = tileRange(b, z);
        for (let x = r.x0; x <= r.x1; x++)
          for (let y = r.y0; y <= r.y1; y++)
            out.add(TILE_SOURCES[src].replace('{z}', z).replace('{y}', y).replace('{x}', x));
      }
    }
    return out;
  }
  function countTiles(b, z0, z1) {
    let c = 0;
    for (let z = z0; z <= z1; z++) {
      const r = tileRange(b, z);
      c += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
    }
    return c;
  }
  function estimate(bounds, sources, maxZoom) {
    const tiles = sources.reduce((n, src) => n + countTiles(bounds, AREA_MIN_ZOOM, maxZoomFor(src, maxZoom)), 0);
    return { tiles, mb: Math.round(tiles * AVG_TILE_KB / 1024), tooBig: tiles > MAX_TILES };
  }

  async function fetchTiles(urls, onProgress, signal) {
    const cache = await caches.open(TILE_CACHE);
    const list = [...urls];
    let next = 0, done = 0, failed = 0, bytes = 0;
    async function worker() {
      while (next < list.length) {
        if (signal.aborted) return;
        const url = list[next++];
        try {
          if (!(await cache.match(url))) {
            let res = null;
            for (let attempt = 0; attempt < 2 && !(res && res.ok); attempt++) {
              try { res = await fetch(url, { mode: 'cors', signal }); } catch (e) { if (signal.aborted) return; }
            }
            // Land use tiles that are entirely empty were never made: not a failure.
            if (res && res.status === 404 && isHostedTile(url)) { done++; onProgress(done, list.length); continue; }
            if (!res || !res.ok) throw new Error('tile failed');
            const blob = await res.blob();
            bytes += blob.size;
            await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } }));
          }
        } catch (e) { failed++; }
        done++;
        onProgress(done, list.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    return { done, failed, bytes };
  }

  // ---------------- Feature downloads ----------------
  function runQuery(q) {
    return new Promise((resolve, reject) => q.run((err, fc, raw) => (err ? reject(err) : resolve({ fc, raw }))));
  }
  async function fetchAllFeatures({ url, where, fields, bounds, pageSize, max, signal, onPage }) {
    const features = [];
    for (let offset = 0; ;) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      let q = L.esri.query({ url }).where(where).fields(fields).precision(6)
        .orderBy('OBJECTID').offset(offset).limit(pageSize);
      if (bounds) q = q.intersects(L.latLngBounds(bounds));
      const { fc, raw } = await runQuery(q);
      features.push(...fc.features);
      offset += fc.features.length;
      if (onPage) onPage(features.length);
      if (!fc.features.length || !(raw && raw.exceededTransferLimit) || (max && features.length >= max)) break;
    }
    return { type: 'FeatureCollection', features };
  }

  async function downloadAccess(defs, signal, onProgress) {
    const layers = {};
    let i = 0;
    for (const d of defs) {
      onProgress && onProgress(i++, defs.length);
      layers[d.id] = await fetchAllFeatures({ url: d.url, where: d.where, fields: ['*'], pageSize: 1000, signal });
    }
    const rec = { savedAt: Date.now(), layers };
    await kvSet('access', rec);
    return rec;
  }

  // ---------------- Areas ----------------
  /** Download tiles + parcels for an area. */
  async function downloadArea({ name, bounds, sources, maxZoom, parcelsUrl, parcelFields, signal, onProgress }) {
    // 1. Parcels
    let parcels = null, parcelError = null;
    try {
      parcels = await fetchAllFeatures({
        url: parcelsUrl, where: '1=1', fields: parcelFields, bounds, pageSize: 2000, max: MAX_PARCELS, signal,
        onPage: (n) => onProgress({ stage: 'parcels', done: n }),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      parcelError = e.message || String(e);
    }

    // 2. Tiles: the area at zoom 10..maxZoom, plus a statewide overview.
    const urls = tileUrls(bounds, AREA_MIN_ZOOM, maxZoom, sources);
    tileUrls(NE_BOUNDS, OVERVIEW_ZOOMS[0], OVERVIEW_ZOOMS[1], sources, urls);
    const result = await fetchTiles(urls, (done, total) => onProgress({ stage: 'tiles', done, total }), signal);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');

    const area = {
      id: 'a' + Date.now(), name, bounds, sources, maxZoom, savedAt: Date.now(),
      tiles: urls.size, failedTiles: result.failed, bytes: result.bytes,
      parcels, parcelCount: parcels ? parcels.features.length : 0, parcelError,
    };
    await putArea(area);
    return area;
  }

  async function deleteArea(id) {
    const areas = await listAreas();
    const target = areas.find(a => a.id === id);
    if (!target) return;
    const others = areas.filter(a => a.id !== id);
    await removeArea(id);

    const keep = new Set();
    for (const a of others) {
      tileUrls(a.bounds, AREA_MIN_ZOOM, a.maxZoom, a.sources, keep);
      tileUrls(NE_BOUNDS, OVERVIEW_ZOOMS[0], OVERVIEW_ZOOMS[1], a.sources, keep);
    }
    const drop = tileUrls(target.bounds, AREA_MIN_ZOOM, target.maxZoom, target.sources);
    tileUrls(NE_BOUNDS, OVERVIEW_ZOOMS[0], OVERVIEW_ZOOMS[1], target.sources, drop);
    const cache = await caches.open(TILE_CACHE);
    await Promise.all([...drop].filter(u => !keep.has(u)).map(u => cache.delete(u)));
  }

  // ---------------- Geometry ----------------
  const bboxCache = new WeakMap();
  function bbox(geom) {
    let b = bboxCache.get(geom);
    if (!b) {
      b = [Infinity, Infinity, -Infinity, -Infinity];
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const rings of polys) for (const ring of rings) for (const [x, y] of ring) {
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      }
      bboxCache.set(geom, b);
    }
    return b;
  }
  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function geomContains(geom, x, y) {
    if (!geom) return false;
    const b = bbox(geom);
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    return polys.some(rings => {
      let inside = false;
      for (const ring of rings) if (ringContains(ring, x, y)) inside = !inside;
      return inside;
    });
  }
  /** Features in a FeatureCollection that contain the point. */
  function featuresAt(fc, latlng) {
    if (!fc) return [];
    return fc.features.filter(f => geomContains(f.geometry, latlng.lng, latlng.lat));
  }
  /** True if a saved area contains the LatLng or LatLngBounds. */
  function areaCovers(areas, target) {
    return areas.some(a => L.latLngBounds(a.bounds).contains(target));
  }

  // ---------------- Storage ----------------
  async function storageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return { usedMb: Math.round((e.usage || 0) / 1048576), quotaMb: Math.round((e.quota || 0) / 1048576), persisted };
  }
  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  return {
    TILE_SOURCES, MAX_TILES, estimate, downloadArea, deleteArea, listAreas,
    getAccess: () => kvGet('access'), downloadAccess,
    featuresAt, areaCovers, storageInfo, requestPersist,
  };
})();
