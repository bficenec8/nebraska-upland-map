/* Hunt log: marks (flushes, harvests, truck, cover…) and recorded GPS tracks.
 * Everything is stored on this device (IndexedDB), so it works with no signal.
 * GPX export/import is for backup and moving data between devices.
 * Depends on globals from app.js: map, $, esc, toast, fmtDate, identify,
 * showSheet, clearHighlight, highlight, settings, save, startLocating, lastFix, watching.
 */
'use strict';

const Hunt = (() => {
  const TYPES = {
    rooster: { label: 'Rooster flush',    emoji: '🐓', color: '#b5541c' },
    hen:     { label: 'Hen flush',        emoji: '🐔', color: '#c9a227' },
    covey:   { label: 'Quail covey',      emoji: '🐦', color: '#6b4f2a' },
    grouse:  { label: 'Grouse / chicken', emoji: '🪶', color: '#7a6a3a' },
    harvest: { label: 'Bird harvested',   emoji: '🎯', color: '#2e8b3a' },
    truck:   { label: 'Truck / parking',  emoji: '🛻', color: '#1a73e8' },
    cover:   { label: 'Good cover',       emoji: '🌾', color: '#8a9a2a' },
    note:    { label: 'Note',             emoji: '📍', color: '#555555' },
  };
  const typeOf = (t) => TYPES[t] || TYPES.note;
  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const miles = (m) => (m / 1609.344).toFixed(2) + ' mi';
  const duration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ---------------- Storage ----------------
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('upland-hunt', 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const [name, keyPath] of [['markers', 'id'], ['tracks', 'id'], ['owners', 'key']]) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
          }
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
  const getAll = (store) => tx(store, 'readonly', s => s.getAll());
  const put = (store, v) => tx(store, 'readwrite', s => s.put(v));
  const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));

  // ---------------- Map layers ----------------
  map.createPane('hunt'); map.getPane('hunt').style.zIndex = 435;
  const layer = L.featureGroup();
  const markerLayers = new Map();
  const trackLines = new Map();
  let markers = [], tracks = [];

  if (settings.hunt === undefined) settings.hunt = true;
  function setVisible(on) {
    settings.hunt = on; save();
    $('hunt-on').checked = on;
    if (on) layer.addTo(map); else map.removeLayer(layer);
  }

  function icon(type) {
    const t = typeOf(type);
    return L.divIcon({
      className: 'hunt-icon', html: `<span style="border-color:${t.color}">${t.emoji}</span>`,
      iconSize: [34, 34], iconAnchor: [17, 17],
    });
  }

  function drawMarker(m) {
    const mk = L.marker([m.lat, m.lng], { icon: icon(m.type), keyboard: false, title: typeOf(m.type).label });
    mk.on('click', () => showMarker(m.id));
    mk.on('dragend', async () => {
      const ll = mk.getLatLng();
      m.lat = +ll.lat.toFixed(6); m.lng = +ll.lng.toFixed(6);
      mk.dragging.disable();
      await put('markers', m);
      toast('Mark moved');
    });
    mk.addTo(layer);
    markerLayers.set(m.id, mk);
  }

  const lineStyle = (live) => ({
    pane: 'hunt', color: live ? '#ff2d55' : '#d63af9', weight: live ? 5 : 4, opacity: 0.9, bubblingMouseEvents: false,
  });
  function drawTrack(t) {
    const line = L.polyline(t.points.map(p => [p[0], p[1]]), lineStyle(false));
    line.on('click', () => showTrack(t.id));
    line.addTo(layer);
    trackLines.set(t.id, line);
  }

  // ---------------- Marks ----------------
  /** Where a new mark goes: your GPS spot if it's fresh, otherwise the map center. */
  function markPosition() {
    if (watching && lastFix && Date.now() - lastFix.time < 120000) return { latlng: lastFix.latlng, gps: true };
    return { latlng: map.getCenter(), gps: false };
  }

  async function addMarker(type, latlng) {
    const m = { id: newId('m'), type, lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6), time: Date.now(), note: '' };
    markers.push(m);
    await put('markers', m);
    if (!settings.hunt) setVisible(true);
    drawMarker(m);
    return m;
  }

  async function markHere(type) {
    const { latlng, gps } = markPosition();
    await addMarker(type, latlng);
    $('hunt-panel').hidden = true;
    toast(`${typeOf(type).emoji} ${typeOf(type).label} marked${gps ? '' : ' at the map center'}`);
  }

  function typeGrid(prefix) {
    return `<div class="type-grid">${Object.entries(TYPES).map(([k, t]) =>
      `<button class="type-btn" data-${prefix}="${k}"><span class="emo">${t.emoji}</span>${esc(t.label)}</button>`).join('')}</div>`;
  }

  // Long-press (or right-click) the map to add a mark at that spot.
  function showAddSheet(latlng) {
    clearHighlight();
    L.circleMarker(latlng, { pane: 'highlight', radius: 6, color: '#fff', weight: 2, fillColor: '#ff2d55', fillOpacity: 1 }).addTo(highlight);
    showSheet(`<div class="headline">Add a mark here</div>${typeGrid('add')}`);
    $('sheet-body').querySelectorAll('[data-add]').forEach(b => {
      b.onclick = async () => {
        const type = b.dataset.add;
        await addMarker(type, latlng);
        clearHighlight();
        $('sheet').hidden = true;
        toast(`${typeOf(type).emoji} ${typeOf(type).label} marked`);
      };
    });
  }
  map.on('contextmenu', (e) => showAddSheet(e.latlng));

  function showMarker(id) {
    const m = markers.find(x => x.id === id);
    if (!m) return;
    const t = typeOf(m.type);
    clearHighlight();
    showSheet(`<div class="card" style="--c:${t.color}">
      <div class="kind">Hunt log mark</div>
      <h4>${t.emoji} ${esc(t.label)}</h4>
      <dl><dt>When</dt><dd>${esc(when(m.time))}</dd>
          <dt>Location</dt><dd>${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</dd></dl>
      <textarea id="mk-note" class="text area" placeholder="Add a note (dog work, cover type, wind…)">${esc(m.note)}</textarea>
      <div class="btn-row">
        <button class="btn small" id="mk-save">Save note</button>
        <button class="btn small secondary" id="mk-land">What land is this?</button>
        <button class="btn small secondary" id="mk-move">Move</button>
        <button class="btn small danger" id="mk-del">Delete</button>
      </div></div>`);
    $('mk-save').onclick = async () => {
      m.note = $('mk-note').value.trim();
      await put('markers', m);
      toast('Note saved');
    };
    $('mk-land').onclick = () => identify(L.latLng(m.lat, m.lng));
    $('mk-move').onclick = () => {
      $('sheet').hidden = true;
      markerLayers.get(m.id).dragging.enable();
      toast('Drag the mark to its new spot', 4000);
    };
    $('mk-del').onclick = async () => {
      if (!confirm(`Delete this ${t.label.toLowerCase()} mark?`)) return;
      await del('markers', m.id);
      markers = markers.filter(x => x.id !== m.id);
      layer.removeLayer(markerLayers.get(m.id));
      markerLayers.delete(m.id);
      $('sheet').hidden = true;
      toast('Mark deleted');
    };
  }

  // ---------------- Tracks ----------------
  let rec = null, recLine = null, recTimer = null, wakeLock = null, lastPersist = 0;
  const MIN_STEP_M = 8, MAX_ACCURACY_M = 50;

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { /* not supported or denied */ }
    if (wakeLock) wakeLock.addEventListener('release', () => { wakeLock = null; });
  }
  // Save the track in progress often, so little is lost if the phone closes the app.
  let dirty = false;
  function persistRec() {
    if (rec && dirty) { dirty = false; lastPersist = Date.now(); put('tracks', rec); }
  }
  document.addEventListener('visibilitychange', () => {
    if (!rec) return;
    if (document.visibilityState === 'visible') requestWakeLock();
    else persistRec();
  });
  window.addEventListener('pagehide', persistRec);

  function beginRecording() {
    recLine = L.polyline(rec.points.map(p => [p[0], p[1]]), lineStyle(true)).addTo(map);
    startLocating(true);
    requestWakeLock();
    clearInterval(recTimer);
    recTimer = setInterval(updateRecUI, 1000);
    updateRecUI();
  }

  async function startTrack() {
    if (rec) return;
    rec = { id: newId('t'), name: '', start: Date.now(), end: null, points: [], distance: 0, recording: true };
    await put('tracks', rec);
    beginRecording();
    $('hunt-panel').hidden = true;
    toast('Recording your track. Keep the app open.', 4000);
  }

  map.on('locationfound', (e) => {
    if (!rec || e.accuracy > MAX_ACCURACY_M) return;
    const pts = rec.points;
    const last = pts[pts.length - 1];
    if (last) {
      const d = map.distance([last[0], last[1]], e.latlng);
      if (d < MIN_STEP_M) return;
      rec.distance += d;
    }
    pts.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6), Date.now()]);
    recLine.addLatLng(e.latlng);
    dirty = true;
    if (Date.now() - lastPersist > 10000) persistRec();
  });

  async function stopTrack() {
    if (!rec) return;
    const t = rec;
    rec = null;
    clearInterval(recTimer);
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (recLine) { map.removeLayer(recLine); recLine = null; }
    t.recording = false;
    t.end = Date.now();
    t.name = t.name || `Hunt ${when(t.start)}`;
    if (t.points.length < 2) {
      await del('tracks', t.id);
      toast('Track too short to save');
    } else {
      await put('tracks', t);
      tracks.push(t);
      if (!settings.hunt) setVisible(true);
      drawTrack(t);
      toast(`Saved "${t.name}" · ${miles(t.distance)}`, 4000);
    }
    updateRecUI();
    render();
  }

  function updateRecUI() {
    if (rec && Date.now() - lastPersist > 10000) persistRec();
    const on = !!rec;
    $('rec-pill').hidden = !on;
    $('rec-idle').hidden = on;
    $('rec-live').hidden = !on;
    if (on) {
      const stats = `${miles(rec.distance)} · ${duration(Date.now() - rec.start)}`;
      $('rec-pill').textContent = `● REC  ${stats}`;
      $('rec-stats').textContent = stats;
      $('rec-points').textContent = rec.points.length
        ? `${rec.points.length} GPS points`
        : 'Waiting for a good GPS signal…';
    }
  }

  function trackStats(t) {
    return `${fmtDate(t.start)} · ${miles(t.distance)} · ${duration((t.end || Date.now()) - t.start)}`;
  }

  async function renameTrack(t) {
    const name = prompt('Track name', t.name);
    if (name == null || !name.trim()) return;
    t.name = name.trim().slice(0, 60);
    await put('tracks', t);
    render();
  }

  async function deleteTrack(t) {
    if (!confirm(`Delete track "${t.name}"?`)) return;
    await del('tracks', t.id);
    tracks = tracks.filter(x => x.id !== t.id);
    layer.removeLayer(trackLines.get(t.id));
    trackLines.delete(t.id);
    $('sheet').hidden = true;
    render();
    toast('Track deleted');
  }

  function viewTrack(t) {
    if (!settings.hunt) setVisible(true);
    map.fitBounds(trackLines.get(t.id).getBounds(), { padding: [40, 40], maxZoom: 17 });
  }

  function showTrack(id) {
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    clearHighlight();
    showSheet(`<div class="card" style="--c:#d63af9">
      <div class="kind">Recorded track</div>
      <h4>${esc(t.name)}</h4>
      <dl><dt>Started</dt><dd>${esc(when(t.start))}</dd>
          <dt>Distance</dt><dd>${miles(t.distance)}</dd>
          <dt>Time</dt><dd>${duration(t.end - t.start)}</dd></dl>
      <div class="btn-row">
        <button class="btn small secondary" id="tr-view">Zoom to track</button>
        <button class="btn small secondary" id="tr-rename">Rename</button>
        <button class="btn small danger" id="tr-del">Delete</button>
      </div></div>`);
    $('tr-view').onclick = () => viewTrack(t);
    $('tr-rename').onclick = async () => { await renameTrack(t); showTrack(t.id); };
    $('tr-del').onclick = () => deleteTrack(t);
  }

  // ---------------- Landowner notes (per parcel) ----------------
  const STATUS = {
    none:  { label: 'Not asked yet',      color: '#888888', dash: '6 4' },
    asked: { label: 'Asked, waiting',     color: '#e0a800', dash: '6 4' },
    yes:   { label: 'Permission granted', color: '#2e8b3a', dash: null },
    no:    { label: 'Permission denied',  color: '#d0021b', dash: null },
  };
  const owners = new Map();      // parcel key -> notes record
  const ownerLayers = new Map(); // parcel key -> outline on the map
  const parcelKey = (p) => p.State_PID || `${p.County_ID}-${p.Parcel_ID}`;

  function drawOwner(o) {
    if (ownerLayers.has(o.key)) { layer.removeLayer(ownerLayers.get(o.key)); ownerLayers.delete(o.key); }
    if (!o.geometry) return;
    const s = STATUS[o.status] || STATUS.none;
    const g = L.geoJSON({ type: 'Feature', geometry: o.geometry }, {
      pane: 'hunt', interactive: false,
      style: { color: s.color, weight: 3, dashArray: s.dash, fillColor: s.color, fillOpacity: 0.12 },
    });
    g.addTo(layer);
    ownerLayers.set(o.key, g);
  }

  function editOwner(feature, done) {
    const p = feature.properties;
    const key = parcelKey(p);
    const o = owners.get(key) || { key, status: 'none', name: '', phone: '', notes: '' };
    showSheet(`<div class="card" style="--c:#555">
      <div class="kind">Landowner notes · Parcel ${esc(p.Parcel_ID || p.State_PID)}</div>
      <label class="field">Owner name<input id="ow-name" class="text" value="${esc(o.name)}" maxlength="80"></label>
      <label class="field">Phone<input id="ow-phone" class="text" type="tel" value="${esc(o.phone)}" maxlength="30"></label>
      <label class="field">Permission<select id="ow-status" class="text">
        ${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select></label>
      <label class="field">Notes<textarea id="ow-notes" class="text area" placeholder="Rules, gate, where to park, when you asked…">${esc(o.notes)}</textarea></label>
      <div class="btn-row">
        <button class="btn small" id="ow-save">Save</button>
        <button class="btn small secondary" id="ow-cancel">Cancel</button>
        ${owners.has(key) ? '<button class="btn small danger" id="ow-del">Delete notes</button>' : ''}
      </div></div>`);
    $('ow-save').onclick = async () => {
      const rec = Object.assign({}, o, {
        name: $('ow-name').value.trim(), phone: $('ow-phone').value.trim(),
        status: $('ow-status').value, notes: $('ow-notes').value.trim(),
        parcelId: p.Parcel_ID || p.State_PID, county: countyFromFips(p.County_ID),
        geometry: feature.geometry, updated: Date.now(),
      });
      await put('owners', rec);
      owners.set(key, rec);
      if (!settings.hunt) setVisible(true);
      drawOwner(rec);
      toast('Landowner notes saved');
      done();
    };
    $('ow-cancel').onclick = done;
    if ($('ow-del')) $('ow-del').onclick = async () => {
      if (!confirm('Delete your notes for this parcel?')) return;
      await del('owners', key);
      owners.delete(key);
      if (ownerLayers.has(key)) { layer.removeLayer(ownerLayers.get(key)); ownerLayers.delete(key); }
      toast('Notes deleted');
      done();
    };
  }

  // ---------------- Panel ----------------
  function render() {
    const { gps } = markPosition();
    $('mark-where').textContent = gps
      ? 'Marks go at your GPS location.'
      : 'Marks go at the center of the map. Turn on location (◎) to mark where you stand. You can also long-press the map to mark any spot.';

    const ul = $('track-list');
    const list = [...tracks].sort((a, b) => b.start - a.start);
    ul.innerHTML = list.length ? '' : '<li class="fine">No tracks yet.</li>';
    for (const t of list) {
      const li = document.createElement('li');
      li.innerHTML = `<div><b>${esc(t.name)}</b><small>${esc(trackStats(t))}</small></div>
        <button class="btn small secondary" data-act="view">View</button>
        <button class="btn small secondary" data-act="ren" aria-label="Rename">✎</button>
        <button class="btn small danger" data-act="del" aria-label="Delete">✕</button>`;
      li.querySelector('[data-act=view]').onclick = () => { $('hunt-panel').hidden = true; viewTrack(t); };
      li.querySelector('[data-act=ren]').onclick = () => renameTrack(t);
      li.querySelector('[data-act=del]').onclick = () => deleteTrack(t);
      ul.appendChild(li);
    }

    const counts = {};
    for (const m of markers) counts[m.type] = (counts[m.type] || 0) + 1;
    $('marker-summary').innerHTML = markers.length
      ? Object.entries(counts).map(([k, n]) => `${typeOf(k).emoji} ${n}`).join(' &nbsp; ')
      : 'No marks yet.';
    const perm = [...owners.values()].filter(o => o.status === 'yes').length;
    $('owner-summary').textContent = owners.size
      ? `Landowner notes on ${owners.size} parcel${owners.size === 1 ? '' : 's'} (${perm} with permission).`
      : 'No landowner notes yet. Tap a parcel and choose "Owner notes".';
    $('marks-show').disabled = !markers.length && !tracks.length && !owners.size;
    updateRecUI();
  }

  // ---------------- GPX export / import ----------------
  function toGpx() {
    const iso = (t) => new Date(t).toISOString();
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Nebraska Upland Map" xmlns="http://www.topografix.com/GPX/1/1">\n';
    for (const m of markers) {
      out += `  <wpt lat="${m.lat.toFixed(6)}" lon="${m.lng.toFixed(6)}"><time>${iso(m.time)}</time><name>${esc(typeOf(m.type).label)}</name>` +
        `${m.note ? `<desc>${esc(m.note)}</desc>` : ''}<type>${esc(m.type)}</type></wpt>\n`;
    }
    // Landowner notes: a waypoint at the parcel center, with the full record
    // (including the parcel outline) tucked in <extensions> for re-import.
    for (const o of owners.values()) {
      const c = o.geometry ? L.geoJSON(o.geometry).getBounds().getCenter() : null;
      if (!c) continue;
      const summary = [STATUS[o.status] ? STATUS[o.status].label : '', o.phone, o.notes, `Parcel ${o.parcelId || ''} (${o.county || ''} Co.)`]
        .filter(Boolean).join(' · ');
      out += `  <wpt lat="${c.lat.toFixed(6)}" lon="${c.lng.toFixed(6)}"><time>${iso(o.updated || Date.now())}</time>` +
        `<name>${esc(o.name || 'Landowner')}</name><desc>${esc(summary)}</desc><type>landowner</type>` +
        `<extensions><upland:owner xmlns:upland="https://bficenec8.github.io/nebraska-upland-map">${esc(JSON.stringify(o))}</upland:owner></extensions></wpt>\n`;
    }
    for (const t of tracks) {
      out += `  <trk><name>${esc(t.name)}</name><trkseg>\n`;
      for (const p of t.points) out += `    <trkpt lat="${p[0]}" lon="${p[1]}"><time>${iso(p[2])}</time></trkpt>\n`;
      out += '  </trkseg></trk>\n';
    }
    return out + '</gpx>\n';
  }

  function exportGpx() {
    if (!markers.length && !tracks.length && !owners.size) { toast('Nothing to export yet'); return; }
    const blob = new Blob([toGpx()], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `upland-hunt-log-${new Date().toISOString().slice(0, 10)}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  const childText = (el, tag) => {
    const c = el.getElementsByTagName(tag)[0];
    return c ? c.textContent.trim() : '';
  };

  async function importGpx(file) {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('gpx').length) {
      toast('That file is not a GPX file'); return;
    }
    const seenMarks = new Set(markers.map(m => `${m.lat.toFixed(5)},${m.lng.toFixed(5)},${m.time}`));
    let nm = 0, nt = 0, no = 0;
    for (const w of doc.getElementsByTagName('wpt')) {
      const lat = parseFloat(w.getAttribute('lat')), lng = parseFloat(w.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lng)) continue;
      if (childText(w, 'type') === 'landowner') {
        let o = null;
        try { o = JSON.parse(childText(w, 'upland:owner')); } catch (e) { /* not ours */ }
        if (o && o.key && STATUS[o.status] !== undefined) {
          const existing = owners.get(o.key);
          if (!existing || (o.updated || 0) > (existing.updated || 0)) {
            await put('owners', o);
            owners.set(o.key, o);
            drawOwner(o);
            no++;
          }
          continue;
        }
      }
      const time = Date.parse(childText(w, 'time')) || Date.now();
      if (seenMarks.has(`${lat.toFixed(5)},${lng.toFixed(5)},${time}`)) continue;
      const typeText = childText(w, 'type');
      const type = TYPES[typeText] ? typeText : 'note';
      const name = childText(w, 'name');
      const note = childText(w, 'desc') || (type === 'note' ? name : '');
      const m = { id: newId('m'), type, lat, lng, time, note };
      await put('markers', m);
      markers.push(m);
      drawMarker(m);
      nm++;
    }
    for (const trk of doc.getElementsByTagName('trk')) {
      const pts = [...trk.getElementsByTagName('trkpt')]
        .map(p => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon')), Date.parse(childText(p, 'time')) || 0])
        .filter(p => isFinite(p[0]) && isFinite(p[1]));
      if (pts.length < 2) continue;
      const name = (childText(trk, 'name') || 'Imported track').slice(0, 60);
      if (tracks.some(t => t.name === name && t.points.length === pts.length)) continue;
      let distance = 0;
      for (let i = 1; i < pts.length; i++) distance += map.distance([pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]);
      const start = pts[0][2] || Date.now();
      const t = { id: newId('t'), name, start, end: pts[pts.length - 1][2] || start, points: pts, distance, recording: false };
      await put('tracks', t);
      tracks.push(t);
      drawTrack(t);
      nt++;
    }
    if (!settings.hunt) setVisible(true);
    render();
    toast(`Imported ${nm} mark${nm === 1 ? '' : 's'}, ${nt} track${nt === 1 ? '' : 's'}` +
      ` and ${no} landowner note${no === 1 ? '' : 's'}`, 4000);
  }

  // ---------------- Wire up UI ----------------
  $('hunt-type-grid').innerHTML = typeGrid('mark');
  $('hunt-type-grid').querySelectorAll('[data-mark]').forEach(b => { b.onclick = () => markHere(b.dataset.mark); });
  $('rec-start').onclick = startTrack;
  $('rec-stop').onclick = stopTrack;
  $('rec-pill').onclick = () => { $('hunt-panel').hidden = false; render(); };
  $('marks-show').onclick = () => {
    if (!settings.hunt) setVisible(true);
    if (layer.getLayers().length) map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 16 });
    $('hunt-panel').hidden = true;
  };
  $('gpx-export').onclick = exportGpx;
  $('gpx-import').onclick = () => $('gpx-file').click();
  $('gpx-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) {
      try { await importGpx(file); } catch (err) { toast('Could not import: ' + (err.message || err)); }
    }
  };
  $('hunt-on').checked = settings.hunt;
  $('hunt-on').onchange = (e) => setVisible(e.target.checked);

  // ---------------- Startup ----------------
  (async function load() {
    try {
      markers = await getAll('markers');
      const all = await getAll('tracks');
      tracks = all.filter(t => !t.recording);
      markers.forEach(drawMarker);
      tracks.forEach(drawTrack);
      for (const o of await getAll('owners')) { owners.set(o.key, o); drawOwner(o); }
      // A track that was recording when the app closed: keep going.
      const unfinished = all.find(t => t.recording);
      if (unfinished) {
        rec = unfinished;
        beginRecording();
        toast('Still recording your track', 4000);
      }
    } catch (e) {
      console.warn('Hunt log unavailable', e);
    }
    setVisible(settings.hunt);
    updateRecUI();
  })();

  return {
    render, isRecording: () => !!rec, TYPES, STATUS,
    parcelKey, ownerFor: (p) => owners.get(parcelKey(p)) || null, editOwner,
  };
})();
