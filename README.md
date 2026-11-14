# Nebraska Upland Map

A web app (works on phone and laptop) for finding public upland bird hunting
access in Nebraska and identifying land parcels.

## Features
- Satellite / USGS topo / street base maps
- Public access layers from the NGPC Public Access Atlas data:
  - Game & Parks lands (WMAs, state parks and recreation areas)
  - Open Fields & Waters walk-in tracts (2026–27)
  - Federal & other public lands (WPAs, national forest, etc.)
  - Conservation partner lands (NRDs, etc.)
- "Upland focus" filter
- Statewide parcel boundaries (zoom in), with acres, legal description,
  section/township/range
- Tap anywhere to see whether it's public access and which parcel it is
- Search public areas by name
- GPS location (tap the blue dot to identify where you're standing)
- Installable to your home screen / desktop

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
- `sw.js`, `manifest.webmanifest`, `icon.svg` – make it installable as an app
- `serve.ps1` – tiny local web server for testing
