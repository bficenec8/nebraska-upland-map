# Nebraska Upland Map

A web app (works on phone and laptop) for finding public upland bird hunting
access in Nebraska and identifying land parcels.

## Features
- Satellite / USGS topo / street base maps
- **Lidar** (USGS 3DEP 1 m elevation): 2 / 5 / 10 ft contours and
  multidirectional shaded relief, drawn on demand by the USGS server
  (10–20 s per view, online only)
- **Land use & cover**: UNL CALMIT / NE DNR 2005 Nebraska Land Use (25 classes,
  irrigated vs. dryland; converted to tiles in `tiles/landuse2005`, tap to
  identify, can be saved offline), Nebraska GAP land cover (UNL CALMIT,
  1991–93 Landsat, 20 classes incl. native prairie/woodland/wetland types;
  `tiles/gap`, same features; built with `tools/make_gap_tiles.py`), UNL CSD
  Native Vegetation of Nebraska (1993, pre-settlement vegetation; vector
  `data/native_vegetation.geojson` from `tools/make_native_veg.py`, always
  available offline), and the USDA NASS Cropland Data Layer
  (latest year, live WMS). Opacity slider and legend in the Layers panel.
- Public access layers from the NGPC Public Access Atlas data:
  - Game & Parks lands (WMAs, state parks and recreation areas)
  - Open Fields & Waters walk-in tracts (2026–27)
  - Federal & other public lands (WPAs, national forest, etc.)
  - Conservation partner lands (NRDs, etc.)
- "Upland focus" filter
- Statewide parcel boundaries (zoom in), with acres, legal description,
  section/township/range
- Tap anywhere to see whether it's public access and which parcel it is
- **Owner lookup**: "Look up owner" copies the parcel ID and opens that
  county's official assessor search (all 93 counties; owner names aren't in any
  free statewide dataset). "Owner notes" saves owner name, phone, permission
  status and notes per parcel — shown on the card, outlined on the map by
  status, works offline, included in GPX backups.
- Search public areas by name
- GPS location (tap the blue dot to identify where you're standing)
- Installable to your home screen / desktop
- **Hunt log**: mark rooster/hen flushes, coveys, grouse, harvests, truck,
  good cover or notes (at your GPS spot, the map center, or long-press any
  spot); record GPS tracks with distance and time (keeps the screen awake);
  everything is stored on the device and works offline; GPX export/import for
  backup and moving data between phone and laptop.
- **Offline maps**: save the area on screen (USGS imagery and/or topo tiles,
  zoom 10–16, plus that area's parcels). Statewide public access data is saved
  too, so identify and search work with no signal. Esri satellite and OSM
  streets stay online-only (their terms don't allow bulk saving).

## Run it locally
From `C:\Python`:

    powershell -ExecutionPolicy Bypass -File nebraska-upland-map\serve.ps1

Then open http://localhost:8080

## Data sources
- Nebraska Game & Parks Commission open data (services5.arcgis.com/IOshH1zLrIieqrNk)
- Nebraska OCIO Statewide Parcels (giscat.ne.gov) — county data, not authoritative;
  no owner names (look those up with the county assessor)

Always confirm access rules in the official Public Access Atlas and posted signs.

## Files
- `index.html` – page layout
- `style.css` – look and feel
- `app.js` – all map logic (layers, identify, search, GPS)
- `hunt.js` – hunt log: marks, track recording, GPX export/import
- `offline.js` – saving/deleting offline areas, tile math, offline identify
- `sw.js`, `manifest.webmanifest`, `icon.svg` – installable app; serves saved tiles offline
- `serve.ps1` – tiny local web server for testing
