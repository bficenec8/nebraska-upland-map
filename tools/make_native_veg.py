"""Convert UNL CSD "Native Vegetation of Nebraska" (1993, 1:1,000,000) shapefiles
into one small GeoJSON (WGS84) for the app.

Inputs (UTM zone 14, from native_utm.zip): Native_veg_utm.shp (main map) and
Native_poly_utm.shp (red cedar / salt marsh overlay, drawn on top).
Each feature gets property "c" = class code (must match NATIVE_CLASSES in app.js).

Usage: python make_native_veg.py <Native_veg_utm.shp> <Native_poly_utm.shp> <out.geojson>
"""
import json
import sys

import fiona
from fiona.transform import transform_geom
from shapely.geometry import mapping, shape

VEG, POLY, OUT = sys.argv[1:4]
SIMPLIFY_M = 60          # the source map is 1:1,000,000, so 60 m loses nothing visible

CODES = {
    "Lowland Tallgrass Prairie": 1, "Upland Tallgrass Prairie": 2, "Loess Mixed-grass Prairie": 3,
    "Sand Hills Mixed-grass Prairie": 4, "Sand Hills Borders Mixed-grass Prairie": 5,
    "Gravelly Mixed-grass Prairie": 6, "Shale Mixed-grass Prairie": 7, "Sandsage Mixed-grass Prairie": 8,
    "Mosaic of Mixed-grass/Shortgrass Prairie": 9, "Upland Deciduous Forests": 10,
    "Riparian Deciduous Forests": 11, "Ponderosa Pine Forests and Savannas": 12,
    "Red Cedar Forest and Savanna": 13, "Salt Marsh and Flats": 14, "Salt Marches and Flats": 14,
}


def rnd(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], 5), round(obj[1], 5)]
        return [rnd(o) for o in obj]
    return obj


features, skipped = [], {}
for path, overlay in ((VEG, False), (POLY, True)):
    with fiona.open(path) as src:
        for f in src:
            name = f["properties"]["DESCRIPTIO"]
            if name not in CODES:
                skipped[name] = skipped.get(name, 0) + 1
                continue
            geom = shape(f["geometry"]).simplify(SIMPLIFY_M, preserve_topology=True)
            if geom.is_empty:
                continue
            g = transform_geom(src.crs, "EPSG:4326", mapping(geom))
            features.append({"type": "Feature", "properties": {"c": CODES[name], "o": 1 if overlay else 0},
                             "geometry": {"type": g["type"], "coordinates": rnd(g["coordinates"])}})

with open(OUT, "w") as fh:
    json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"))
print(f"{len(features)} features written to {OUT}; skipped: {skipped}")
