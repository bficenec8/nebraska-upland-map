/* Nebraska Upland Map
 * Map of public hunting access (NGPC Public Access Atlas data) plus statewide
 * land parcels. Tap anywhere to identify the access area and parcel there.
 */
'use strict';

// ------------------------------------------------------------------
// Data sources
// ------------------------------------------------------------------
const NGPC = 'https://services5.arcgis.com/IOshH1zLrIieqrNk/arcgis/rest/services/';
const PARCELS_URL = 'https://giscat.ne.gov/enterprise/rest/services/StatewideParcelsExternal/MapServer/0';

const UPLAND_WORDS = ['pheasant', 'quail', 'grouse', 'prairie chicken', 'partridge'];
// Keep areas that list an upland bird, plus areas with no species list at all
// (most WMAs leave the species field blank, and we don't want to hide them).
const uplandSql = (field) =>
  `(${field} IS NULL OR ${field} IN ('', ' ') OR ` +
  UPLAND_WORDS.map(w => `LOWER(${field}) LIKE '%${w}%'`).join(' OR ') + ')';

// Public-access layers from Nebraska Game & Parks.
const ACCESS_LAYERS = [
  {
    id: 'ngpc', name: 'Game & Parks lands (WMAs, parks)', color: '#2e8b3a',
    url: NGPC + 'NPGCProperties2023_2024/FeatureServer/268',
    where: "Display2Public = 'Yes'",
    uplandWhere: uplandSql('SpeciesAvailable'),
    nameField: 'AreaName', searchable: true,
  },
  {
    id: 'ofw', name: 'Open Fields & Waters (walk-in)', color: '#e0a800',
    url: NGPC + 'OFW_2026_2027_QA_Web_Map_View/FeatureServer/0',
    where: "ProgramBou IS NULL OR ProgramBou NOT LIKE '%Fishing Only%'",
    uplandWhere: "ProgramBou IS NULL OR ProgramBou NOT LIKE '%Turkey Season Only%'",
  },
  {
    id: 'federal', name: 'Federal & other public lands', color: '#a0522d',
    url: NGPC + 'StateLands/FeatureServer/0',
    where: '1=1', uplandWhere: uplandSql('SpeciesLikelyPresent'),
    nameField: 'AreaName', searchable: true,
  },
  {
    id: 'partner', name: 'Conservation partner lands', color: '#7b4fb5',
    url: NGPC + 'Conservation_Partner_Lands/FeatureServer/0',
    where: '1=1', uplandWhere: uplandSql('SpeciesLikelyPresent'),
    nameField: 'AreaName', searchable: true,
  },
];

// Nebraska counties in alphabetical order; FIPS code = 2*index + 1.
const COUNTIES = ['Adams','Antelope','Arthur','Banner','Blaine','Boone','Box Butte','Boyd','Brown','Buffalo',
  'Burt','Butler','Cass','Cedar','Chase','Cherry','Cheyenne','Clay','Colfax','Cuming','Custer','Dakota','Dawes',
  'Dawson','Deuel','Dixon','Dodge','Douglas','Dundy','Fillmore','Franklin','Frontier','Furnas','Gage','Garden',
  'Garfield','Gosper','Grant','Greeley','Hall','Hamilton','Harlan','Hayes','Hitchcock','Holt','Hooker','Howard',
  'Jefferson','Johnson','Kearney','Keith','Keya Paha','Kimball','Knox','Lancaster','Lincoln','Logan','Loup',
  'McPherson','Madison','Merrick','Morrill','Nance','Nemaha','Nuckolls','Otoe','Pawnee','Perkins','Phelps',
  'Pierce','Platte','Polk','Red Willow','Richardson','Rock','Saline','Sarpy','Saunders','Scotts Bluff','Seward',
  'Sheridan','Sherman','Sioux','Stanton','Thayer','Thomas','Thurston','Valley','Washington','Wayne','Webster',
  'Wheeler','York'];
const countyFromFips = (code) => {
  const n = parseInt(code, 10);
  return (n % 2 === 1 && COUNTIES[(n - 1) / 2]) || code || '';
};

const NGPC_AREA_TYPES = {
  WMA: 'Wildlife Management Area', SRA: 'State Recreation Area', SP: 'State Park',
  SHP: 'State Historical Park', TRA: 'Trail', FH: 'Fish Hatchery',
};

// ------------------------------------------------------------------
// Saved settings
// ------------------------------------------------------------------
const saved = JSON.parse(localStorage.getItem('upland-settings') || '{}');
const settings = Object.assign({
  basemap: 'satellite',
  overlays: { ngpc: true, ofw: true, federal: true, partner: true },
  parcels: true,
  uplandOnly: false,
  view: null,
}, saved);
const save = () => localStorage.setItem('upland-settings', JSON.stringify(settings));

// ------------------------------------------------------------------
// Map + base layers
// ------------------------------------------------------------------
const map = L.map('map', { zoomControl: false, attributionControl: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(map);

if (settings.view && settings.view.zoom >= 6) map.setView(settings.view.center, settings.view.zoom);
else map.setView([41.5, -99.8], 7); // Nebraska
map.setMinZoom(5);

map.on('moveend', () => {
  const c = map.getCenter();
  settings.view = { center: [c.lat, c.lng], zoom: map.getZoom() };
  save();
});

const esriTile = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
const BASEMAPS = {
  satellite: {
    label: 'Satellite',
    layer: L.layerGroup([
      L.tileLayer(esriTile('World_Imagery'), { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, USDA' }),
      L.tileLayer(esriTile('Reference/World_Transportation'), { maxZoom: 19, opacity: 0.8 }),
      L.tileLayer(esriTile('Reference/World_Boundaries_and_Places'), { maxZoom: 19 }),
    ]),
    parcelColor: '#ffffff',
  },
  topo: {
    label: 'Topo',
    layer: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' }),
    parcelColor: '#333333',
  },
  streets: {
    label: 'Streets',
    layer: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '© OpenStreetMap contributors' }),
    parcelColor: '#333333',
  },
};

let currentBase = null;
function setBasemap(key) {
  if (currentBase) map.removeLayer(currentBase.layer);
  currentBase = BASEMAPS[key];
  currentBase.layer.addTo(map);
  settings.basemap = key; save();
  document.querySelectorAll('#basemap-list button').forEach(b => b.classList.toggle('on', b.dataset.key === key));
  if (parcelLayer) parcelLayer.setStyle(parcelStyle());
}

// ------------------------------------------------------------------
// Public access overlays
// ------------------------------------------------------------------
map.createPane('access');  map.getPane('access').style.zIndex = 410;
map.createPane('parcels'); map.getPane('parcels').style.zIndex = 420;
map.createPane('highlight'); map.getPane('highlight').style.zIndex = 430;

function accessWhere(def) {
  return settings.uplandOnly && def.uplandWhere
    ? `(${def.where}) AND (${def.uplandWhere})`
    : def.where;
}

function accessStyle(def) {
  return (feature) => {
    const p = feature.properties || {};
    const turkeyOnly = def.id === 'ofw' && /turkey season only/i.test(p.ProgramBou || '');
    return {
      color: turkeyOnly ? '#888' : def.color,
      weight: 2,
      dashArray: turkeyOnly ? '4 4' : null,
      fillColor: turkeyOnly ? '#888' : def.color,
      fillOpacity: 0.3,
    };
  };
}

for (const def of ACCESS_LAYERS) {
  def.layer = L.esri.featureLayer({
    url: def.url, where: accessWhere(def), pane: 'access',
    style: accessStyle(def), simplifyFactor: 0.35, precision: 5,
    fields: ['OBJECTID', 'ProgramBou'].filter(f => def.id === 'ofw' || f === 'OBJECTID'),
  });
  if (settings.overlays[def.id]) def.layer.addTo(map);
}

// ------------------------------------------------------------------
// Parcels (shown when zoomed in)
// ------------------------------------------------------------------
const PARCEL_MIN_ZOOM = 14;
const parcelStyle = () => ({ color: currentBase ? currentBase.parcelColor : '#fff', weight: 1, opacity: 0.8, fill: false });
let parcelLayer = null;
parcelLayer = L.esri.featureLayer({
  url: PARCELS_URL, pane: 'parcels', minZoom: PARCEL_MIN_ZOOM,
  fields: ['OBJECTID'], simplifyFactor: 0.5, precision: 5,
  style: parcelStyle, interactive: false,
});
if (settings.parcels) parcelLayer.addTo(map);

setBasemap(BASEMAPS[settings.basemap] ? settings.basemap : 'satellite');

// ------------------------------------------------------------------
// Layers panel
// ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

for (const [key, b] of Object.entries(BASEMAPS)) {
  const btn = document.createElement('button');
  btn.textContent = b.label; btn.dataset.key = key;
  btn.classList.toggle('on', key === settings.basemap);
  btn.onclick = () => setBasemap(key);
  $('basemap-list').appendChild(btn);
}

for (const def of ACCESS_LAYERS) {
  const row = document.createElement('label');
  row.className = 'row';
  row.innerHTML = `<input type="checkbox" ${settings.overlays[def.id] ? 'checked' : ''}>
    <span class="swatch" style="border-color:${def.color};background:${def.color}55"></span> ${def.name}`;
  row.querySelector('input').onchange = (e) => {
    settings.overlays[def.id] = e.target.checked; save();
    e.target.checked ? def.layer.addTo(map) : map.removeLayer(def.layer);
  };
  $('overlay-list').appendChild(row);
}

$('upland-only').checked = settings.uplandOnly;
$('upland-only').onchange = (e) => {
  settings.uplandOnly = e.target.checked; save();
  ACCESS_LAYERS.forEach(def => def.layer.setWhere(accessWhere(def)));
  toast(settings.uplandOnly ? 'Upland focus on' : 'Showing all access areas');
};

$('parcels-on').checked = settings.parcels;
$('parcels-on').onchange = (e) => {
  settings.parcels = e.target.checked; save();
  e.target.checked ? parcelLayer.addTo(map) : map.removeLayer(parcelLayer);
  if (e.target.checked && map.getZoom() < PARCEL_MIN_ZOOM) toast('Zoom in closer to see parcel lines');
};

$('btn-layers').onclick = () => { $('layers-panel').hidden = !$('layers-panel').hidden; };
document.querySelectorAll('[data-close]').forEach(b => {
  b.onclick = () => {
    $(b.dataset.close).hidden = true;
    if (b.dataset.close === 'sheet') clearHighlight();
  };
});

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const blank = (v) => v == null || String(v).trim() === '';
const acres = (v) => (blank(v) ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ac');

function highlightSpecies(text) {
  if (blank(text)) return '';
  return esc(text).split(/,\s*/).map(s =>
    UPLAND_WORDS.some(w => s.toLowerCase().includes(w)) ? `<span class="upland">${s}</span>` : s
  ).join(', ');
}

function linkFrom(v) {
  if (blank(v)) return '';
  const m = String(v).match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0] : '';
}

function dl(rows) {
  const items = rows.filter(([, v]) => !blank(v)).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return items ? `<dl>${items}</dl>` : '';
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function runQuery(q) {
  return new Promise((resolve, reject) => q.run((err, fc) => (err ? reject(err) : resolve(fc))));
}

// ------------------------------------------------------------------
// Info cards for each kind of land
// ------------------------------------------------------------------
const CARDS = {
  ngpc(p, def) {
    const type = NGPC_AREA_TYPES[(p.AreaType || '').trim()] || p.AreaType;
    const regs = linkFrom(p.Regulations);
    const site = linkFrom(p.siteurl);
    const parkNote = /^(SP|SRA|SHP)$/.test((p.AreaType || '').trim())
      ? '<div class="note">Hunting in state parks and recreation areas is limited to certain areas and seasons. Check the regulations.</div>' : '';
    return `<div class="card" style="--c:${def.color}">
      <div class="kind">Nebraska Game &amp; Parks · ${esc(type)}</div>
      <h4>${esc(p.AreaName)}</h4>
      ${dl([
        ['Species', highlightSpecies(p.SpeciesAvailable)],
        ['Acres', acres(p.Acres)],
        ['County', esc(p.County)],
        ['District', esc(p.District)],
        ['Regulations', regs ? `<a href="${esc(regs)}" target="_blank" rel="noopener">Atlas page</a>` : ''],
        ['More info', site ? `<a href="${esc(site)}" target="_blank" rel="noopener">Link</a>` : ''],
      ])}${parkNote}</div>`;
  },

  ofw(p, def) {
    const prog = p.ProgramBou || 'Open Fields & Waters';
    const turkey = /turkey season only/i.test(prog);
    const deer = /rifle deer/i.test(prog);
    const special = /special regulations/i.test(prog);
    let note = '<div class="note">Walk-in access. Follow the posted signs and the rules in the Public Access Atlas.</div>';
    if (turkey) note = '<div class="note warn">Open for the <b>spring turkey season only</b>. Not open for upland hunting.</div>';
    else if (deer) note = '<div class="note warn">Closed during the nine-day November rifle deer season.</div>' + note;
    else if (special) note = '<div class="note warn">Special regulations apply to this tract. Check the Atlas before you hunt.</div>';
    return `<div class="card" style="--c:${turkey ? '#888' : def.color}">
      <div class="kind">Open Fields &amp; Waters · walk-in</div>
      <h4>${esc(prog.replace(/^OFW\s*/, ''))}</h4>
      ${dl([
        ['Acres', acres(p.ContractLandAcres || p.ContractAcres)],
        ['County', esc(p.County)],
        ['District', esc(p.District)],
        ['Contract #', esc(p.ContractNumber2 || p.ContractNu)],
      ])}${note}</div>`;
  },

  federal(p, def) { return otherCard(p, def); },
  partner(p, def) { return otherCard(p, def); },
};

function otherCard(p, def) {
  const site = linkFrom(p.SiteURL);
  const flags = [];
  if (p.NontoxicShotOnly === 'Yes') flags.push('Nontoxic shot only');
  if (p.NoRiflesOrHandguns === 'Yes') flags.push('No rifles or handguns');
  if (p.NoCenterfireOrRimfireRiflesorPi === 'Yes') flags.push('No centerfire/rimfire rifles or pistols');
  if (p.NoTargetShooting === 'Yes') flags.push('No target shooting');
  const phone = blank(p.DistrictManagerPhone) ? '' :
    `<a href="tel:${esc(p.DistrictManagerPhone)}">${esc(p.DistrictManagerPhone)}</a> (${esc(p.DistrictManager)})`;
  return `<div class="card" style="--c:${def.color}">
    <div class="kind">${esc(p.AtlasRepresentation || def.name)}</div>
    <h4>${esc(p.AreaName)}</h4>
    ${dl([
      ['Owner', esc(p.OwnerAgency)],
      ['Species', highlightSpecies(p.SpeciesLikelyPresent)],
      ['Acres', acres(p.Acres)],
      ['County', esc(p.County)],
      ['Location', esc(p.LocationInfo)],
      ['Contact', phone],
      ['More info', site ? `<a href="${esc(site)}" target="_blank" rel="noopener">Website</a>` : ''],
    ])}
    ${flags.length ? `<div class="note warn">${flags.join(' · ')}</div>` : ''}
    ${blank(p.Regulations) ? '' : `<div class="note">${esc(p.Regulations)}</div>`}
  </div>`;
}

function parcelCard(p, isPublic) {
  const cls = [p.Property_SubClass, p.Classification_Code].find(v => !blank(v) && !/^\d+$/.test(String(v).trim()));
  const county = esc(countyFromFips(p.County_ID));
  const note = isPublic
    ? ''
    : `<div class="note">The statewide parcel data does not include owner names. Look up the parcel ID with the ${county} County Assessor to find the owner. You need landowner permission on any land that is not public or walk-in access.</div>`;
  const trs = [p.Sect && `Sec ${p.Sect}`, p.Twn && `T${p.Twn}N`, p.Rng && `R${p.Rng}${p.Rng_Direction || ''}`]
    .filter(Boolean).join(', ');
  const url = linkFrom(p.Parcel_URL);
  return `<div class="card" style="--c:#555">
    <div class="kind">Land parcel</div>
    <h4>Parcel ${esc(p.Parcel_ID || p.State_PID)}</h4>
    ${dl([
      ['County', county],
      ['Acres', acres(p.GIS_Acres || p.Acres_Deeded)],
      ['Legal', esc(p.Legal_Description)],
      ['Sec/Twp/Rng', esc(trs)],
      ['Address', esc(p.Situs_Address)],
      ['Class', esc(cls)],
      ['Assessor', url ? `<a href="${esc(url)}" target="_blank" rel="noopener">County record</a>` : ''],
    ])}${note}
  </div>`;
}

// ------------------------------------------------------------------
// Tap to identify
// ------------------------------------------------------------------
const highlight = L.featureGroup().addTo(map);
function clearHighlight() { highlight.clearLayers(); }

let identifySeq = 0;
async function identify(latlng) {
  const seq = ++identifySeq;
  $('layers-panel').hidden = true;
  $('search-results').hidden = true;
  clearHighlight();
  L.circleMarker(latlng, { pane: 'highlight', radius: 6, color: '#fff', weight: 2, fillColor: '#b5541c', fillOpacity: 1 }).addTo(highlight);
  showSheet('<div class="status">Looking up this spot…</div>');

  // On phones the info sheet covers the bottom half, so slide the map up.
  if (window.innerWidth < 800) {
    const y = map.latLngToContainerPoint(latlng).y;
    const target = window.innerHeight * 0.25;
    if (y > window.innerHeight * 0.4) map.panBy([0, y - target]);
  }

  const active = ACCESS_LAYERS.filter(d => settings.overlays[d.id]);
  const accessJobs = active.map(def =>
    runQuery(L.esri.query({ url: def.url }).intersects(latlng).where(accessWhere(def)).returnGeometry(false))
      .then(fc => fc.features.map(f => ({ def, p: f.properties })))
      .catch(() => []));
  const parcelJob = runQuery(L.esri.query({ url: PARCELS_URL }).intersects(latlng).precision(6))
    .then(fc => fc.features[0] || null)
    .catch(() => 'error');

  const [accessResults, parcel] = await Promise.all([Promise.all(accessJobs), parcelJob]);
  if (seq !== identifySeq) return; // a newer tap happened

  const access = accessResults.flat();
  // Show each OFW contract only once (one tract can have several program lines).
  const seen = new Set();
  const accessHtml = access.filter(({ def, p }) => {
    const key = def.id === 'ofw' ? `ofw-${p.ContractNumber2 || p.ContractNu}-${p.ProgramBou}` : `${def.id}-${p.OBJECTID}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).map(({ def, p }) => CARDS[def.id](p, def)).join('');

  let head;
  if (access.length) head = '<div class="headline">✅ Public hunting access found here</div>';
  else head = '<div class="headline">⛔ No public access mapped here. Assume this is private land.</div>';

  let parcelHtml = '';
  if (parcel === 'error') parcelHtml = '<div class="status">Parcel lookup failed. Check your connection.</div>';
  else if (parcel) {
    parcelHtml = parcelCard(parcel.properties, access.length > 0);
    L.geoJSON(parcel, { pane: 'highlight', style: { color: '#ff5a1f', weight: 3, fill: false } }).addTo(highlight);
  }

  showSheet(head + accessHtml + parcelHtml);
}

function showSheet(html) {
  $('sheet-body').innerHTML = html;
  $('sheet').hidden = false;
  $('sheet').scrollTop = 0;
}

map.on('click', (e) => identify(e.latlng));

// ------------------------------------------------------------------
// Search public areas by name
// ------------------------------------------------------------------
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const text = e.target.value.trim();
  if (text.length < 2) { $('search-results').hidden = true; return; }
  searchTimer = setTimeout(() => doSearch(text), 350);
});

async function doSearch(text) {
  const safe = text.replace(/'/g, "''").toLowerCase();
  const jobs = ACCESS_LAYERS.filter(d => d.searchable).map(def =>
    runQuery(L.esri.query({ url: def.url })
      .where(`(${def.where}) AND LOWER(${def.nameField}) LIKE '%${safe}%'`)
      .fields(['OBJECTID', def.nameField, 'County']).precision(4).limit(15))
      .then(fc => fc.features.map(f => ({ def, f })))
      .catch(() => []));
  const results = (await Promise.all(jobs)).flat().slice(0, 25);
  const ul = $('search-results');
  ul.innerHTML = '';
  if (!results.length) {
    ul.innerHTML = '<li><small>No matching public areas</small></li>';
  }
  for (const { def, f } of results) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `${esc(f.properties[def.nameField])}<small>${esc(f.properties.County)} County · ${esc(def.name)}</small>`;
    li.onclick = () => {
      ul.hidden = true;
      $('search').blur();
      const bounds = L.geoJSON(f).getBounds();
      map.fitBounds(bounds, { maxZoom: 15, padding: [30, 30] });
      clearHighlight();
      L.geoJSON(f, { pane: 'highlight', style: { color: '#ff5a1f', weight: 3, fill: false } }).addTo(highlight);
    };
    li.onkeydown = (ev) => { if (ev.key === 'Enter') li.onclick(); };
    ul.appendChild(li);
  }
  ul.hidden = false;
}

// ------------------------------------------------------------------
// GPS location
// ------------------------------------------------------------------
let locMarker = null, locCircle = null, following = false, watching = false;

$('btn-locate').onclick = () => {
  if (!watching) {
    watching = true; following = true;
    map.locate({ watch: true, enableHighAccuracy: true, setView: false });
    toast('Finding your location…');
  } else if (!following) {
    following = true;
    if (locMarker) map.setView(locMarker.getLatLng(), Math.max(map.getZoom(), 15));
  } else {
    // Third tap: stop tracking.
    map.stopLocate(); watching = false; following = false;
    if (locMarker) { map.removeLayer(locMarker); map.removeLayer(locCircle); locMarker = locCircle = null; }
    toast('Location off');
  }
  updateLocateButton();
};

function updateLocateButton() {
  $('btn-locate').classList.toggle('active', watching);
  $('btn-locate').classList.toggle('following', watching && following);
}

let firstFix = true;
map.on('locationfound', (e) => {
  if (!locMarker) {
    locCircle = L.circle(e.latlng, { radius: e.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    locMarker = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    locMarker.on('click', (ev) => { L.DomEvent.stopPropagation(ev); identify(locMarker.getLatLng()); });
  } else {
    locMarker.setLatLng(e.latlng); locCircle.setLatLng(e.latlng).setRadius(e.accuracy);
  }
  if (following) map.setView(e.latlng, firstFix ? Math.max(map.getZoom(), 15) : map.getZoom());
  if (firstFix) { firstFix = false; toast('Tap the blue dot to see what land you are on'); }
});
map.on('locationerror', (e) => {
  toast('Could not get location: ' + e.message);
  watching = following = false; updateLocateButton();
});
map.on('dragstart', () => { if (following) { following = false; updateLocateButton(); } });

// ------------------------------------------------------------------
// Install as an app (offline shell)
// ------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
