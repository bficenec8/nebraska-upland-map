"""Convert UNL/CALMIT 2005 Nebraska land use (statewide shapefile) into web map tiles.

The shapefile is UNL's raster turned into ~4 million polygons. A few of them
(e.g. Sandhills grassland) are gigantic, with huge numbers of vertices/holes,
and GDAL rasterizes those extremely slowly. So:
 1. Normal polygons are burned straight into a 93.48 ft grid (Nebraska State
    Plane, feet) in batches. Giant polygons are set aside, clipped into
    2048 x 2048 px blocks with shapely, and the pieces are burned block by block.
 2. The grid is reprojected to Web Mercator at zoom-12 resolution, aligned to
    the tile grid (nearest neighbour, so class codes are kept exactly).
 3. 256x256 paletted PNG tiles are cut for zooms 6..12 (index 0 = transparent).

Usage: python make_landuse_tiles.py <shapefile> <out_tiles_dir> <work_dir>
"""
import math
import os
import sys
import time

import fiona
import numpy as np
import rasterio
import shapely
from PIL import Image
from rasterio.crs import CRS
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds
from shapely.geometry import shape

SHP, OUT, WORK = sys.argv[1:4]
PIX_FT = 93.48
BIG_VERTICES = 20_000       # polygons with more vertices than this get clipped into blocks
BLOCK = 2048                # block size in pixels for clipping giant polygons
MAX_Z, MIN_Z = 12, 6
R = 6378137.0
WORLD = 2 * math.pi * R
ORIGIN = math.pi * R

# Hunter-friendly palette (index = class code). Must match LANDUSE_CLASSES in app.js.
PALETTE = {
    1: "e0a800", 2: "a0522d", 3: "2e7d32", 4: "c96a1f", 5: "8a5a34", 6: "8d6e63", 7: "9b59b6",
    8: "b8913e", 9: "c9d68a", 10: "9e9e9e", 11: "3b82f6", 12: "1b5e20", 13: "4dd0e1",
    14: "d7ccc8", 15: "e07a95", 16: "efe6d2", 17: "6d6d6d", 18: "f5d142", 19: "5aa54a",
    20: "e8873a", 21: "b07d52", 22: "c58fd6", 23: "d9b56a", 24: "f4a6b8", 25: "f5f5dc",
}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def vertex_count(geom):
    coords = geom["coordinates"]
    if geom["type"] == "Polygon":
        return sum(len(r) for r in coords)
    if geom["type"] == "MultiPolygon":
        return sum(len(r) for p in coords for r in p)
    return 0


os.makedirs(WORK, exist_ok=True)
native_tif = os.path.join(WORK, "landuse2005_native.tif")

# ---------------- 1. rasterize in native projection ----------------
with fiona.open(SHP) as src:
    crs = CRS.from_wkt(src.crs_wkt)
    xmin, ymin, xmax, ymax = src.bounds
    width = int(math.ceil((xmax - xmin) / PIX_FT))
    height = int(math.ceil((ymax - ymin) / PIX_FT))
    transform = from_origin(xmin, ymax, PIX_FT, PIX_FT)
    total = len(src)

    if not os.path.exists(native_tif):
        log(f"rasterizing {total:,} polygons into {width} x {height} grid")
        grid = np.zeros((height, width), dtype=np.uint8)
        batch, big, done, t_batch = [], [], 0, time.time()
        for feat in src:
            code = feat["properties"]["GRIDCODE"]
            geom = feat["geometry"]
            if geom is None or not code or not (0 < code < 255):
                continue
            gj = {"type": geom["type"], "coordinates": geom["coordinates"]}
            if vertex_count(gj) > BIG_VERTICES:
                big.append((shape(gj), int(code)))
                continue
            batch.append((gj, int(code)))
            if len(batch) >= 100_000:
                rasterize(batch, out=grid, transform=transform, dtype=np.uint8)
                done += len(batch)
                log(f"  {done:,} normal polygons ({time.time() - t_batch:.0f}s), {len(big)} giant set aside")
                batch, t_batch = [], time.time()
        if batch:
            rasterize(batch, out=grid, transform=transform, dtype=np.uint8)
            done += len(batch)
        log(f"  {done:,} normal polygons burned; {len(big)} giant polygons to clip")

        # Giant polygons: clip to blocks and burn the pieces.
        for i, (geom, code) in enumerate(big, 1):
            t0 = time.time()
            gx0, gy0, gx1, gy1 = geom.bounds
            c0 = max(0, int((gx0 - xmin) // (PIX_FT * BLOCK)))
            c1 = min((width - 1) // BLOCK, int((gx1 - xmin) // (PIX_FT * BLOCK)))
            r0 = max(0, int((ymax - gy1) // (PIX_FT * BLOCK)))
            r1 = min((height - 1) // BLOCK, int((ymax - gy0) // (PIX_FT * BLOCK)))
            shapely.prepare(geom)
            for br in range(r0, r1 + 1):
                for bc in range(c0, c1 + 1):
                    px0, py0 = bc * BLOCK, br * BLOCK
                    px1, py1 = min(px0 + BLOCK, width), min(py0 + BLOCK, height)
                    bx0, by1 = xmin + px0 * PIX_FT, ymax - py0 * PIX_FT
                    bx1, by0 = xmin + px1 * PIX_FT, ymax - py1 * PIX_FT
                    piece = shapely.clip_by_rect(geom, bx0, by0, bx1, by1)
                    if piece.is_empty:
                        continue
                    sub = grid[py0:py1, px0:px1]
                    rasterize([(piece, code)], out=sub, transform=from_origin(bx0, by1, PIX_FT, PIX_FT),
                              dtype=np.uint8)
            log(f"  giant {i}/{len(big)} (class {code}, {shapely.get_num_coordinates(geom):,} vertices) "
                f"in {time.time() - t0:.0f}s")

        with rasterio.open(native_tif, "w", driver="GTiff", width=width, height=height, count=1,
                           dtype="uint8", crs=crs, transform=transform, nodata=0,
                           compress="deflate", tiled=True) as dst:
            dst.write(grid, 1)
        del grid
    else:
        log("native grid already exists, reusing")

# ---------------- 2. reproject to Web Mercator (zoom-12 grid) ----------------
res = WORLD / (256 * 2 ** MAX_Z)
with rasterio.open(native_tif) as ds:
    west, south, east, north = transform_bounds(ds.crs, "EPSG:3857", *ds.bounds)
    tx0 = int(math.floor((west + ORIGIN) / (256 * res)))
    tx1 = int(math.ceil((east + ORIGIN) / (256 * res)))
    ty0 = int(math.floor((ORIGIN - north) / (256 * res)))
    ty1 = int(math.ceil((ORIGIN - south) / (256 * res)))
    W, H = (tx1 - tx0) * 256, (ty1 - ty0) * 256
    dst_transform = from_origin(tx0 * 256 * res - ORIGIN, ORIGIN - ty0 * 256 * res, res, res)
    log(f"reprojecting to Web Mercator: {W} x {H} px")
    merc = np.zeros((H, W), dtype=np.uint8)
    reproject(source=rasterio.band(ds, 1), destination=merc, dst_transform=dst_transform,
              dst_crs="EPSG:3857", resampling=Resampling.nearest, src_nodata=0, dst_nodata=0)

gx0, gy0 = tx0 * 256, ty0 * 256

pal = [0, 0, 0] * 256
for k, hexc in PALETTE.items():
    pal[k * 3:k * 3 + 3] = [int(hexc[i:i + 2], 16) for i in (0, 2, 4)]


def save_tile(arr, z, x, y):
    d = os.path.join(OUT, str(z), str(x))
    os.makedirs(d, exist_ok=True)
    img = Image.fromarray(arr, mode="P")
    img.putpalette(pal)
    img.save(os.path.join(d, f"{y}.png"), optimize=True, transparency=0)


# ---------------- 3. cut tiles ----------------
count = 0
for z in range(MAX_Z, MIN_Z - 1, -1):
    f = 2 ** (MAX_Z - z)
    span = 256 * f
    n_z = 0
    for x in range(gx0 // span, (gx0 + W - 1) // span + 1):
        for y in range(gy0 // span, (gy0 + H - 1) // span + 1):
            ax0, ay0 = x * span - gx0, y * span - gy0
            sx0, sy0 = max(ax0, 0), max(ay0, 0)
            sx1, sy1 = min(ax0 + span, W), min(ay0 + span, H)
            if sx1 <= sx0 or sy1 <= sy0:
                continue
            win = np.zeros((span, span), dtype=np.uint8)
            win[sy0 - ay0:sy1 - ay0, sx0 - ax0:sx1 - ax0] = merc[sy0:sy1, sx0:sx1]
            tile = win[::f, ::f] if f > 1 else win
            if not tile.any():
                continue
            save_tile(np.ascontiguousarray(tile), z, x, y)
            n_z += 1
    count += n_z
    log(f"zoom {z}: {n_z} tiles")

total_b = 0
for root, _, files in os.walk(OUT):
    total_b += sum(os.path.getsize(os.path.join(root, fn)) for fn in files)
log(f"done: {count} tiles, {total_b / 1048576:.1f} MB in {OUT}")
