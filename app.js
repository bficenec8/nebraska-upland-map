/* Nebraska Upland Map
 * Map of public hunting access (NGPC Public Access Atlas data) plus statewide
 * land parcels. Tap anywhere to identify the access area and parcel there.
 * Areas can be saved for offline use (see offline.js).
 */
'use strict';

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const blank = (v) => v == null || String(v).trim() === '';
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const acres = (v) => (blank(v) ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ac');
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
function runQuery(q) {
  return new Promise((resolve, reject) => q.run((err, fc) => (err ? reject(err) : resolve(fc))));
}
let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------
// Data sources
// ------------------------------------------------------------------
const NGPC = 'https://services5.arcgis.com/IOshH1zLrIieqrNk/arcgis/rest/services/';
const PARCELS_URL = 'https://giscat.ne.gov/enterprise/rest/services/StatewideParcelsExternal/MapServer/0';
const PARCEL_FIELDS = ['OBJECTID', 'State_PID', 'Parcel_ID', 'Situs_Address', 'Legal_Description', 'Twn', 'Sect',
  'Rng', 'Rng_Direction', 'Acres_Deeded', 'GIS_Acres', 'County_ID', 'Property_SubClass', 'Classification_Code', 'Parcel_URL'];

const UPLAND_WORDS = ['pheasant', 'quail', 'grouse', 'prairie chicken', 'partridge'];
// Keep areas that list an upland bird, plus areas with no species list at all
// (most WMAs leave the species field blank, and we don't want to hide them).
const uplandSql = (field) =>
  `(${field} IS NULL OR ${field} IN ('', ' ') OR ` +
  UPLAND_WORDS.map(w => `LOWER(${field}) LIKE '%${w}%'`).join(' OR ') + ')';
const hasUpland = (s) => blank(s) || UPLAND_WORDS.some(w => String(s).toLowerCase().includes(w));

// Public-access layers from Nebraska Game & Parks.
const ACCESS_LAYERS = [
  {
    id: 'ngpc', name: 'Game & Parks lands (WMAs, parks)', color: '#2e8b3a',
    url: NGPC + 'NPGCProperties2023_2024/FeatureServer/268',
    where: "Display2Public = 'Yes'",
    uplandWhere: uplandSql('SpeciesAvailable'), uplandTest: p => hasUpland(p.SpeciesAvailable),
    nameField: 'AreaName', searchable: true,
  },
  {
    id: 'ofw', name: 'Open Fields & Waters (walk-in)', color: '#e0a800',
    url: NGPC + 'OFW_2026_2027_QA_Web_Map_View/FeatureServer/0',
    where: "ProgramBou IS NULL OR ProgramBou NOT LIKE '%Fishing Only%'",
    uplandWhere: "ProgramBou IS NULL OR ProgramBou NOT LIKE '%Turkey Season Only%'",
    uplandTest: p => !/turkey season only/i.test(p.ProgramBou || ''),
  },
  {
    id: 'federal', name: 'Federal & other public lands', color: '#a0522d',
    url: NGPC + 'StateLands/FeatureServer/0',
    where: '1=1', uplandWhere: uplandSql('SpeciesLikelyPresent'), uplandTest: p => hasUpland(p.SpeciesLikelyPresent),
    nameField: 'AreaName', searchable: true,
  },
  {
    id: 'partner', name: 'Conservation partner lands', color: '#7b4fb5',
    url: NGPC + 'Conservation_Partner_Lands/FeatureServer/0',
    where: '1=1', uplandWhere: uplandSql('SpeciesLikelyPresent'), uplandTest: p => hasUpland(p.SpeciesLikelyPresent),
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

// Each county assessor's official online parcel search (owner names live there).
// Source: Nebraska Dept. of Revenue, County Assessors and Parcel Search.
const ASSESSOR_URLS = {
  'Adams': 'https://adams.nebraskaassessors.com/', 'Antelope': 'https://schneidergis.co/antelopecone',
  'Arthur': 'https://arthur.gworks.com/', 'Banner': 'https://banner.gworks.com/', 'Blaine': 'https://blaine.gworks.com/',
  'Boone': 'https://boone.gworks.com/', 'Box Butte': 'https://boxbutte.mipsgis.com/', 'Boyd': 'https://boyd.gworks.com/',
  'Brown': 'https://brown.gworks.com/',
  'Buffalo': 'https://beacon.schneidercorp.com/Application.aspx?App=BuffaloCountyNE&PageType=Map',
  'Burt': 'https://burt.gworks.com/', 'Butler': 'https://butler.gworks.com/', 'Cass': 'https://gis-cass.hub.arcgis.com/',
  'Cedar': 'https://cedar.gworks.com/', 'Chase': 'https://chase.gworks.com/',
  'Cherry': 'https://beacon.schneidercorp.com/Application.aspx?AppID=1216&LayerID=36932&PageTypeID=1&PageID=14138',
  'Cheyenne': 'https://cheyenne.gworks.com/', 'Clay': 'https://clay.gworks.com/',
  'Colfax': 'https://beacon.schneidercorp.com/Application.aspx?App=ColfaxCountyNE&PageType=Search',
  'Cuming': 'https://cuming.gworks.com/', 'Custer': 'https://custer.gworks.com/', 'Dakota': 'https://dakota.gworks.com/',
  'Dawes': 'https://dawes.gworks.com/', 'Dawson': 'https://dawson.gworks.com/', 'Deuel': 'https://deuel.gworks.com/',
  'Dixon': 'https://beacon.schneidercorp.com/Application.aspx?AppID=1305&LayerID=44588&PageTypeID=2&PageID=17000',
  'Dodge': 'https://dodge.gworks.com/',
  'Douglas': 'https://beacon.schneidercorp.com/Application.aspx?App=DouglasCountyNE&PageType=Search',
  'Dundy': 'https://dundy.gworks.com/',
  'Fillmore': 'https://beacon.schneidercorp.com/Application.aspx?AppID=1265&LayerID=42728&PageTypeID=2&PageID=15630',
  'Franklin': 'https://franklin.gworks.com/', 'Frontier': 'http://frontier.nebraskaassessors.com/',
  'Furnas': 'https://furnas.gworks.com/', 'Gage': 'https://gage.gworks.com/', 'Garden': 'https://garden.gworks.com/',
  'Garfield': 'https://garfield.gworks.com/', 'Gosper': 'https://schneidergis.co/gospercone',
  'Grant': 'https://grant.gworks.com/', 'Greeley': 'https://greeley.gworks.com/',
  'Hall': 'https://nebraskaassessorsonline.us/search.aspx?county=Hall', 'Hamilton': 'https://hamilton.gworks.com/',
  'Harlan': 'https://harlan.gworks.com/', 'Hayes': 'https://hayes.gworks.com/', 'Hitchcock': 'https://hitchcock.gworks.com/',
  'Holt': 'http://holt.nebraskaassessors.com/', 'Hooker': 'https://hooker.gworks.com/', 'Howard': 'https://howard.gworks.com/',
  'Jefferson': 'https://www.nebraskaassessorsonline.us/search.aspx?county=Jefferson',
  'Johnson': 'https://johnson.gworks.com/', 'Kearney': 'https://kearney.gworks.com/', 'Keith': 'https://keith.gworks.com/',
  'Keya Paha': 'https://keyapaha.gworks.com/', 'Kimball': 'https://kimball.gworks.com/', 'Knox': 'https://knox.gworks.com/',
  'Lancaster': 'http://orion.lancaster.ne.gov/', 'Lincoln': 'https://lincoln.gworks.com/', 'Logan': 'https://logan.gworks.com/',
  'Loup': 'https://loup.gworks.com/', 'Madison': 'https://madison.gworks.com/', 'McPherson': 'https://mcpherson.gworks.com/',
  'Merrick': 'https://merrick.gworks.com/',
  'Morrill': 'https://beacon.schneidercorp.com/Application.aspx?App=MorrillCountyNE&PageType=Search',
  'Nance': 'https://beacon.schneidercorp.com/Application.aspx?AppID=1229&LayerID=39090&PageTypeID=1&PageID=14515',
  'Nemaha': 'https://nemaha.nebraskaassessors.com/', 'Nuckolls': 'https://nuckolls.gworks.com/',
  'Otoe': 'https://otoe.gworks.com/', 'Pawnee': 'https://pawnee.gworks.com/', 'Perkins': 'https://perkins.gworks.com/',
  'Phelps': 'https://phelps.gworks.com/', 'Pierce': 'https://pierce.gworks.com/', 'Platte': 'https://platte.gworks.com/',
  'Polk': 'https://polk.gworks.com/', 'Red Willow': 'https://beacon.schneidercorp.com/',
  'Richardson': 'https://beacon.schneidercorp.com/Application.aspx?AppID=1312&LayerID=44856&PageTypeID=2&PageID=17241',
  'Rock': 'https://rock.gworks.com/', 'Saline': 'https://saline.gworks.com/',
  'Sarpy': 'https://apps.sarpy.gov/CaptureCZ/CAPortal/CAMA/CAPortal/CZ_MainPage.aspx',
  'Saunders': 'https://saunders.gworks.com/',
  'Scotts Bluff': 'https://scottsbluffcountyne.gov/gis-mapping/beacon-gis-map-online/',
  'Seward': 'https://seward.nebraskaassessors.com/', 'Sheridan': 'https://sheridan.gworks.com/',
  'Sherman': 'https://sherman.gworks.com/', 'Sioux': 'https://sioux.gworks.com/',
  'Stanton': 'https://beacon.schneidercorp.com/', 'Thayer': 'https://thayer.nebraskaassessors.com/',
  'Thomas': 'https://thomas.gworks.com/', 'Thurston': 'https://thurston.gworks.com/', 'Valley': 'https://valley.gworks.com/',
  'Washington': 'https://beacon.schneidercorp.com/Application.aspx?App=WashingtonCountyNE&PageType=Search',
  'Wayne': 'https://wayne.gworks.com/', 'Webster': 'https://webster.gworks.com/', 'Wheeler': 'https://wheeler.gworks.com/',
  'York': 'https://maps.camavision.com/yorkne',
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

// Offline data (loaded from IndexedDB at startup)
let offlineAccess = null;   // { savedAt, layers: { id: FeatureCollection } }
let savedAreas = [];        // [{ id, name, bounds, parcels, ... }]

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
  usgs: {
    label: 'USGS imagery ⤓', offline: true,
    layer: L.tileLayer(Offline.TILE_SOURCES.usgs, { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' }),
    parcelColor: '#ffffff',
  },
  topo: {
    label: 'Topo ⤓', offline: true,
    layer: L.tileLayer(Offline.TILE_SOURCES.topo, { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' }),
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
  for (const l of [onlineParcels, localParcels]) if (l) l.setStyle(parcelStyle());
}

// When there's no signal, switch to a base map that can be saved offline.
function ensureOfflineBasemap() {
  if (navigator.onLine || currentBase.offline) return;
  const src = savedAreas.length && savedAreas[0].sources.includes('topo') && !savedAreas[0].sources.includes('usgs') ? 'topo' : 'usgs';
  setBasemap(src);
  toast('No signal: switched to a saved base map');
}

// ------------------------------------------------------------------
// Panes and renderers
// ------------------------------------------------------------------
map.createPane('access');    map.getPane('access').style.zIndex = 410;
map.createPane('parcels');   map.getPane('parcels').style.zIndex = 420;
map.createPane('highlight'); map.getPane('highlight').style.zIndex = 430;
const accessCanvas = L.canvas({ pane: 'access', padding: 0.3 });
const parcelCanvas = L.canvas({ pane: 'parcels', padding: 0.3 });

// ------------------------------------------------------------------
// Public access overlays (live from Game & Parks, or saved copy)
// ------------------------------------------------------------------
function accessWhere(def) {
  return settings.uplandOnly && def.uplandWhere ? `(${def.where}) AND (${def.uplandWhere})` : def.where;
}
const passesFilter = (def, p) => !settings.uplandOnly || !def.uplandTest || def.uplandTest(p || {});

function accessStyle(def) {
  return (feature) => {
    const p = feature.properties || {};
    const turkeyOnly = def.id === 'ofw' && /turkey season only/i.test(p.ProgramBou || '');
    return {
      color: turkeyOnly ? '#888' : def.color, weight: 2, dashArray: turkeyOnly ? '4 4' : null,
      fillColor: turkeyOnly ? '#888' : def.color, fillOpacity: 0.3,
    };
  };
}

function buildAccessLayer(def) {
  const local = offlineAccess && offlineAccess.layers[def.id];
  if (local) {
    return L.geoJSON(local, {
      pane: 'access', renderer: accessCanvas, interactive: false,
      style: accessStyle(def), filter: f => passesFilter(def, f.properties),
    });
  }
  return L.esri.featureLayer({
    url: def.url, where: accessWhere(def), pane: 'access', interactive: false,
    style: accessStyle(def), simplifyFactor: 0.35, precision: 5,
    fields: def.id === 'ofw' ? ['OBJECTID', 'ProgramBou'] : ['OBJECTID'],
  });
}

function refreshAccessLayers() {
  for (const def of ACCESS_LAYERS) {
    if (def.layer) map.removeLayer(def.layer);
    def.layer = buildAccessLayer(def);
    if (settings.overlays[def.id]) def.layer.addTo(map);
  }
}

// ------------------------------------------------------------------
// Parcels: live layer, or saved parcels inside downloaded areas
// ------------------------------------------------------------------
const PARCEL_MIN_ZOOM = 14;
const parcelStyle = () => ({ color: currentBase ? currentBase.parcelColor : '#fff', weight: 1, opacity: 0.8, fill: false });
const onlineParcels = L.esri.featureLayer({
  url: PARCELS_URL, pane: 'parcels', fields: ['OBJECTID'], simplifyFactor: 0.5, precision: 5,
  style: parcelStyle, interactive: false,
});
let localParcels = null;

function rebuildLocalParcels() {
  if (localParcels) map.removeLayer(localParcels);
  const features = savedAreas.flatMap(a => (a.parcels ? a.parcels.features : []));
  localParcels = features.length
    ? L.geoJSON({ type: 'FeatureCollection', features },
      { pane: 'parcels', renderer: parcelCanvas, interactive: false, style: parcelStyle })
    : null;
  updateParcelLayer();
}

function setOnMap(layer, on) {
  if (!layer) return;
  if (on && !map.hasLayer(layer)) layer.addTo(map);
  if (!on && map.hasLayer(layer)) map.removeLayer(layer);
}

function updateParcelLayer() {
  const want = settings.parcels && map.getZoom() >= PARCEL_MIN_ZOOM;
  // Inside a saved area (or with no signal) use the saved parcels: instant, and no signal needed.
  const useLocal = want && !!localParcels && (!navigator.onLine || Offline.areaCovers(savedAreas, map.getBounds()));
  setOnMap(onlineParcels, want && !useLocal);
  setOnMap(localParcels, useLocal);
}
map.on('zoomend moveend', updateParcelLayer);

setBasemap(BASEMAPS[settings.basemap] ? settings.basemap : 'satellite');

// ------------------------------------------------------------------
// Layers panel
// ------------------------------------------------------------------
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
    setOnMap(def.layer, e.target.checked);
  };
  $('overlay-list').appendChild(row);
}

$('upland-only').checked = settings.uplandOnly;
$('upland-only').onchange = (e) => {
  settings.uplandOnly = e.target.checked; save();
  refreshAccessLayers();
  toast(settings.uplandOnly ? 'Upland focus on' : 'Showing all access areas');
};

$('parcels-on').checked = settings.parcels;
$('parcels-on').onchange = (e) => {
  settings.parcels = e.target.checked; save();
  updateParcelLayer();
  if (e.target.checked && map.getZoom() < PARCEL_MIN_ZOOM) toast('Zoom in closer to see parcel lines');
};

function openPanel(id) {
  for (const p of ['layers-panel', 'offline-panel', 'hunt-panel']) if (p !== id) $(p).hidden = true;
  $(id).hidden = !$(id).hidden;
  onOfflinePanelToggle();
  if (id === 'hunt-panel' && !$(id).hidden && typeof Hunt !== 'undefined') Hunt.render();
}
$('btn-layers').onclick = () => openPanel('layers-panel');
$('btn-offline').onclick = () => openPanel('offline-panel');
if ($('btn-hunt')) $('btn-hunt').onclick = () => openPanel('hunt-panel');
document.querySelectorAll('[data-close]').forEach(b => {
  b.onclick = () => {
    $(b.dataset.close).hidden = true;
    if (b.dataset.close === 'sheet') clearHighlight();
    if (b.dataset.close === 'offline-panel') onOfflinePanelToggle();
  };
});

// ------------------------------------------------------------------
// Info cards for each kind of land
// ------------------------------------------------------------------
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

function ownerBox(owner) {
  if (!owner) return '';
  const s = Hunt.STATUS[owner.status] || Hunt.STATUS.none;
  return `<div class="owner-box" style="--c:${s.color}">
    <div class="owner-status">${esc(s.label)}</div>
    ${dl([
      ['Owner', esc(owner.name)],
      ['Phone', blank(owner.phone) ? '' : `<a href="tel:${esc(owner.phone)}">${esc(owner.phone)}</a>`],
      ['Notes', esc(owner.notes).replace(/\n/g, '<br>')],
    ])}</div>`;
}

function parcelCard(p, isPublic, owner) {
  const trs = [p.Sect && `Sec ${p.Sect}`, p.Twn && `T${p.Twn}N`, p.Rng && `R${p.Rng}${p.Rng_Direction || ''}`]
    .filter(Boolean).join(', ');
  const url = linkFrom(p.Parcel_URL);
  const cls = [p.Property_SubClass, p.Classification_Code].find(v => !blank(v) && !/^\d+$/.test(String(v).trim()));
  const countyName = countyFromFips(p.County_ID);
  const county = esc(countyName);
  const assessor = url || ASSESSOR_URLS[countyName];
  const note = isPublic || owner
    ? ''
    : `<div class="note">Owner names aren't in the state parcel data. Tap <b>Look up owner</b>: the parcel ID is copied, and the ${county} County Assessor's search opens so you can paste it. You need landowner permission on any land that is not public or walk-in access.</div>`;
  const buttons = `<div class="btn-row">
    ${assessor ? `<a class="btn small" id="owner-lookup" href="${esc(assessor)}" target="_blank" rel="noopener">Look up owner</a>` : ''}
    ${typeof Hunt !== 'undefined' ? `<button class="btn small secondary" id="owner-edit">${owner ? 'Edit owner notes' : 'Owner notes'}</button>` : ''}
  </div>`;
  return `<div class="card" style="--c:#555">
    <div class="kind">Land parcel</div>
    <h4>Parcel ${esc(p.Parcel_ID || p.State_PID)}</h4>
    ${ownerBox(owner)}
    ${dl([
      ['County', county],
      ['Acres', acres(p.GIS_Acres || p.Acres_Deeded)],
      ['Legal', esc(p.Legal_Description)],
      ['Sec/Twp/Rng', esc(trs)],
      ['Address', esc(p.Situs_Address)],
      ['Class', esc(cls)],
    ])}${buttons}${note}
  </div>`;
}

// ------------------------------------------------------------------
// Tap to identify (works offline with saved data)
// ------------------------------------------------------------------
const highlight = L.featureGroup().addTo(map);
function clearHighlight() { highlight.clearLayers(); }

/** Returns [{def, p}] of access areas at the point, or null if it can't be checked. */
async function accessAt(latlng) {
  const active = ACCESS_LAYERS.filter(d => settings.overlays[d.id]);
  if (offlineAccess) {
    return active.flatMap(def =>
      Offline.featuresAt(offlineAccess.layers[def.id], latlng)
        .filter(f => passesFilter(def, f.properties))
        .map(f => ({ def, p: f.properties })));
  }
  if (!navigator.onLine) return null;
  let failures = 0;
  const results = await Promise.all(active.map(def =>
    withTimeout(runQuery(L.esri.query({ url: def.url }).intersects(latlng).where(accessWhere(def)).returnGeometry(false)), 10000)
      .then(fc => fc.features.map(f => ({ def, p: f.properties })))
      .catch(() => { failures++; return []; })));
  return failures === active.length && active.length ? null : results.flat();
}

/** Returns a parcel feature, null (none), 'offline' (no saved data), or 'error'. */
async function parcelAt(latlng) {
  const local = () => {
    for (const a of savedAreas) {
      const hit = a.parcels && Offline.featuresAt(a.parcels, latlng)[0];
      if (hit) return hit;
    }
    return null;
  };
  if (Offline.areaCovers(savedAreas, latlng)) {
    const hit = local();
    if (hit) return hit;
  }
  if (!navigator.onLine) return 'offline';
  try {
    const fc = await withTimeout(runQuery(L.esri.query({ url: PARCELS_URL }).intersects(latlng).precision(6)), 10000);
    return fc.features[0] || null;
  } catch (e) {
    return local() || 'error';
  }
}

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

  const [access, parcel] = await Promise.all([accessAt(latlng), parcelAt(latlng)]);
  if (seq !== identifySeq) return; // a newer tap happened

  let head, accessHtml = '';
  if (access === null) {
    head = '<div class="headline">⚠️ Can\'t check public access: no connection, and the access data isn\'t saved. Save an area in Offline maps before you lose signal.</div>';
  } else {
    // Show each OFW contract only once (one tract can have several program lines).
    const seen = new Set();
    accessHtml = access.filter(({ def, p }) => {
      const key = def.id === 'ofw' ? `ofw-${p.ContractNumber2 || p.ContractNu}-${p.ProgramBou}` : `${def.id}-${p.OBJECTID}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map(({ def, p }) => CARDS[def.id](p, def)).join('');
    head = access.length
      ? '<div class="headline">✅ Public hunting access found here</div>'
      : '<div class="headline">⛔ No public access mapped here. Assume this is private land.</div>';
  }

  let parcelHtml = '';
  const isFeature = parcel && typeof parcel === 'object';
  const owner = isFeature && typeof Hunt !== 'undefined' ? Hunt.ownerFor(parcel.properties) : null;
  if (parcel === 'error') parcelHtml = '<div class="status">Parcel lookup failed. Check your connection.</div>';
  else if (parcel === 'offline') parcelHtml = '<div class="status">No signal, and parcels aren\'t saved for this spot.</div>';
  else if (isFeature) {
    parcelHtml = parcelCard(parcel.properties, !!(access && access.length), owner);
    L.geoJSON(parcel, { pane: 'highlight', style: { color: '#ff5a1f', weight: 3, fill: false } }).addTo(highlight);
  }

  // Private land you've noted permission for (or been turned down on).
  if (owner && access && !access.length) {
    if (owner.status === 'yes') head = '<div class="headline">🤝 Private land: you have permission (from your owner notes)</div>';
    else if (owner.status === 'no') head = '<div class="headline">⛔ Private land: permission denied (from your owner notes)</div>';
  }

  showSheet(head + accessHtml + parcelHtml);

  if (isFeature) {
    const p = parcel.properties;
    const lookup = $('owner-lookup');
    if (lookup) lookup.onclick = () => {
      const id = p.Parcel_ID || p.State_PID;
      if (navigator.clipboard && id) {
        navigator.clipboard.writeText(id).then(
          () => toast(`Parcel ID ${id} copied. Paste it into the county's search.`, 5000),
          () => toast(`Search the county site for parcel ID ${id}`, 6000));
      } else if (id) {
        toast(`Search the county site for parcel ID ${id}`, 6000);
      }
      // the link itself opens the county site in a new tab
    };
    const edit = $('owner-edit');
    if (edit) edit.onclick = () => Hunt.editOwner(parcel, () => identify(latlng));
  }
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

async function searchFeatures(text) {
  const searchable = ACCESS_LAYERS.filter(d => d.searchable);
  if (offlineAccess) {
    const t = text.toLowerCase();
    return searchable.flatMap(def => ((offlineAccess.layers[def.id] || {}).features || [])
      .filter(f => String(f.properties[def.nameField] || '').toLowerCase().includes(t))
      .slice(0, 15).map(f => ({ def, f })));
  }
  const safe = text.replace(/'/g, "''").toLowerCase();
  const jobs = searchable.map(def =>
    runQuery(L.esri.query({ url: def.url })
      .where(`(${def.where}) AND LOWER(${def.nameField}) LIKE '%${safe}%'`)
      .fields(['OBJECTID', def.nameField, 'County']).precision(4).limit(15))
      .then(fc => fc.features.map(f => ({ def, f })))
      .catch(() => []));
  return (await Promise.all(jobs)).flat();
}

async function doSearch(text) {
  const results = (await searchFeatures(text)).slice(0, 25);
  const ul = $('search-results');
  ul.innerHTML = '';
  if (!results.length) {
    ul.innerHTML = `<li><small>${navigator.onLine || offlineAccess ? 'No matching public areas' : 'No signal: save access data in Offline maps to search offline'}</small></li>`;
  }
  for (const { def, f } of results) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `${esc(f.properties[def.nameField])}<small>${esc(f.properties.County)} County · ${esc(def.name)}</small>`;
    li.onclick = () => {
      ul.hidden = true;
      $('search').blur();
      map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 15, padding: [30, 30] });
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
let lastFix = null; // { latlng, accuracy, time } of the most recent GPS fix

function startLocating(follow = true) {
  if (!watching) {
    watching = true;
    map.locate({ watch: true, enableHighAccuracy: true, setView: false });
    toast('Finding your location…');
  }
  if (follow) following = true;
  updateLocateButton();
}

$('btn-locate').onclick = () => {
  if (!watching) {
    startLocating(true);
  } else if (!following) {
    following = true;
    if (locMarker) map.setView(locMarker.getLatLng(), Math.max(map.getZoom(), 15));
  } else if (typeof Hunt !== 'undefined' && Hunt.isRecording()) {
    following = false;
    toast('Location stays on while a track is recording');
  } else {
    // Third tap: stop tracking.
    map.stopLocate(); watching = false; following = false; lastFix = null;
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
  lastFix = { latlng: e.latlng, accuracy: e.accuracy, time: Date.now() };
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
// Offline maps panel
// ------------------------------------------------------------------
const areaOutlines = L.featureGroup();
let downloadCtrl = null;

function selectedSources() {
  return [$('dl-usgs').checked && 'usgs', $('dl-topo').checked && 'topo'].filter(Boolean);
}
const selectedMaxZoom = () => ($('dl-low').checked ? 15 : 16);
function viewBounds() {
  const b = map.getBounds();
  return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
}

function updateEstimate() {
  if ($('offline-panel').hidden || downloadCtrl) return;
  const sources = selectedSources();
  const btn = $('dl-go');
  if (!sources.length) {
    $('dl-estimate').textContent = 'Pick at least one map type.';
    btn.disabled = true; return;
  }
  const est = Offline.estimate(viewBounds(), sources, selectedMaxZoom());
  if (est.tooBig) {
    $('dl-estimate').innerHTML = `The area on screen is too big (${est.tiles.toLocaleString()} map tiles). <b>Zoom in</b> to the area you'll hunt, or pick "Smaller download".`;
    btn.disabled = true;
  } else {
    $('dl-estimate').textContent = `Area on screen: about ${est.tiles.toLocaleString()} map tiles (~${Math.max(1, est.mb)} MB) plus parcels.`;
    btn.disabled = false;
  }
}
['dl-usgs', 'dl-topo', 'dl-low'].forEach(id => $(id).addEventListener('change', updateEstimate));
map.on('moveend', updateEstimate);

function onOfflinePanelToggle() {
  const open = !$('offline-panel').hidden;
  setOnMap(areaOutlines, open);
  if (open) { renderOfflinePanel(); updateEstimate(); }
}

function drawAreaOutlines() {
  areaOutlines.clearLayers();
  for (const a of savedAreas) {
    L.rectangle(a.bounds, { pane: 'highlight', color: '#1a73e8', weight: 2, dashArray: '6 6', fill: false, interactive: false })
      .addTo(areaOutlines);
  }
}

async function renderOfflinePanel() {
  drawAreaOutlines();
  const ul = $('area-list');
  ul.innerHTML = savedAreas.length ? '' : '<li class="fine">No saved areas yet.</li>';
  for (const a of savedAreas) {
    const li = document.createElement('li');
    const maps = a.sources.map(s => (s === 'usgs' ? 'imagery' : 'topo')).join(' + ');
    const warn = [a.failedTiles ? `${a.failedTiles} tiles missing` : '', a.parcelError ? 'parcels not saved' : '']
      .filter(Boolean).join(', ');
    li.innerHTML = `<div><b>${esc(a.name)}</b><small>${fmtDate(a.savedAt)} · ${maps} · ${a.parcelCount.toLocaleString()} parcels
      ${warn ? `<br><span class="warn-text">${esc(warn)}. Download again to fill in.</span>` : ''}</small></div>
      <button class="btn small secondary" data-act="go">View</button>
      <button class="btn small danger" data-act="del">Delete</button>`;
    li.querySelector('[data-act=go]').onclick = () => map.fitBounds(a.bounds);
    li.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`Delete saved area "${a.name}"? You can download it again later.`)) return;
      await Offline.deleteArea(a.id);
      await loadSavedAreas();
      renderOfflinePanel();
      toast('Area deleted');
    };
    ul.appendChild(li);
  }

  $('access-status').textContent = offlineAccess
    ? `Saved ${fmtDate(offlineAccess.savedAt)}. All Atlas layers for the whole state work offline.`
    : 'Not saved yet. It is saved automatically with your first area.';
  $('access-update').textContent = offlineAccess ? 'Update access data' : 'Save access data now';

  const info = await Offline.storageInfo();
  $('storage-status').textContent = info
    ? `Storage used on this device: ${info.usedMb} MB${info.persisted ? '' : ' (install the app to your home screen so your phone keeps the saved maps)'}`
    : '';
}

function setDownloading(on) {
  $('dl-go').hidden = on;
  $('dl-progress').hidden = !on;
  $('access-update').disabled = on;
}
function progress(text, frac) {
  $('dl-status').textContent = text;
  $('dl-bar').style.width = Math.round((frac || 0) * 100) + '%';
}

const accessDefs = () => ACCESS_LAYERS.map(d => ({ id: d.id, url: d.url, where: d.where }));

async function saveAccessData(signal) {
  offlineAccess = await Offline.downloadAccess(accessDefs(), signal,
    (i, n) => progress(`Saving public access data (${i + 1} of ${n})…`, i / n));
  refreshAccessLayers();
}

$('dl-go').onclick = async () => {
  const sources = selectedSources();
  if (!sources.length) return;
  const bounds = viewBounds();
  const name = $('dl-name').value.trim() || `Area saved ${fmtDate(Date.now())}`;
  downloadCtrl = new AbortController();
  const signal = downloadCtrl.signal;
  setDownloading(true);
  Offline.requestPersist();
  try {
    if (!offlineAccess) await saveAccessData(signal);
    progress('Saving parcels…', 0);
    const area = await Offline.downloadArea({
      name, bounds, sources, maxZoom: selectedMaxZoom(), parcelsUrl: PARCELS_URL, parcelFields: PARCEL_FIELDS, signal,
      onProgress: (s) => {
        if (s.stage === 'parcels') progress(`Saving parcels… ${s.done.toLocaleString()}`, 0.02);
        else progress(`Saving map tiles… ${s.done.toLocaleString()} of ${s.total.toLocaleString()}`, s.done / s.total);
      },
    });
    await loadSavedAreas();
    $('dl-name').value = '';
    toast(area.failedTiles || area.parcelError
      ? 'Saved, but some pieces failed. Download again to fill in.'
      : `Saved "${area.name}". Use USGS imagery or Topo when you have no signal.`, 5000);
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Download cancelled' : 'Download failed: ' + (e.message || e), 5000);
  } finally {
    downloadCtrl = null;
    setDownloading(false);
    renderOfflinePanel();
    updateEstimate();
  }
};
$('dl-cancel').onclick = () => downloadCtrl && downloadCtrl.abort();

$('access-update').onclick = async () => {
  downloadCtrl = new AbortController();
  setDownloading(true);
  try {
    await saveAccessData(downloadCtrl.signal);
    toast('Public access data saved');
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Cancelled' : 'Could not save access data: ' + (e.message || e), 5000);
  } finally {
    downloadCtrl = null;
    setDownloading(false);
    renderOfflinePanel();
    updateEstimate();
  }
};

async function loadSavedAreas() {
  savedAreas = (await Offline.listAreas()).sort((a, b) => b.savedAt - a.savedAt);
  rebuildLocalParcels();
  drawAreaOutlines();
}

// ------------------------------------------------------------------
// Connection changes
// ------------------------------------------------------------------
window.addEventListener('offline', () => {
  toast('No signal: using saved maps and data');
  ensureOfflineBasemap();
  updateParcelLayer();
});
window.addEventListener('online', () => { toast('Back online'); updateParcelLayer(); });

// ------------------------------------------------------------------
// Startup
// ------------------------------------------------------------------
(async function start() {
  try {
    offlineAccess = (await Offline.getAccess()) || null;
    await loadSavedAreas();
  } catch (e) {
    console.warn('Offline data unavailable', e);
  }
  refreshAccessLayers();
  ensureOfflineBasemap();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
