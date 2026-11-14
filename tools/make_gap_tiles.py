"""Convert the UNL/CALMIT Nebraska GAP land cover raster (ne_gap_landcover.img,
EPSG:5070, 30 m, 20 classes, 1991-93 Landsat) into web map tiles.

Reprojects to Web Mercator at zoom-12 resolution aligned to the tile grid
(nearest neighbour, so class codes are kept exactly), then cuts 256x256
paletted PNG tiles for zooms 6..12 (index 0 = transparent).

Usage: python make_gap_tiles.py <ne_gap_landcover.img> <out_tiles_dir>
"""
import math
import os
import sys
import time

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds

SRC, OUT = sys.argv[1:3]
MAX_Z, MIN_Z = 12, 6
R = 6378137.0
WORLD = 2 * math.pi * R
ORIGIN = math.pi * R

# Must match GAP_CLASSES in app.js.
PALETTE = {
    1: "2f5d3a", 2: "3f8f3f", 3: "4f6d4a", 4: "b7a77a", 5: "d8cf8f", 6: "8fbf6a", 7: "a9cf7a",
    8: "c7c27c", 9: "b9b88a", 10: "e2d6a6", 11: "f2eee0", 12: "e9b949", 13: "3b82f6", 14: "efe1b8",
    15: "2bb5c9", 16: "7fdbe6", 17: "6f9e5a", 18: "1b5e20", 19: "b0b0b0", 20: "707070",
}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


res = WORLD / (256 * 2 ** MAX_Z)
with rasterio.open(SRC) as ds:
    west, south, east, north = transform_bounds(ds.crs, "EPSG:3857", *ds.bounds)
    tx0 = int(math.floor((west + ORIGIN) / (256 * res)))
    tx1 = int(math.ceil((east + ORIGIN) / (256 * res)))
    ty0 = int(math.floor((ORIGIN - north) / (256 * res)))
    ty1 = int(math.ceil((ORIGIN - south) / (256 * res)))
    W, H = (tx1 - tx0) * 256, (ty1 - ty0) * 256
    dst_transform = from_origin(tx0 * 256 * res - ORIGIN, ORIGIN - ty0 * 256 * res, res, res)
    log(f"reprojecting {ds.width} x {ds.height} ({ds.crs}) to Web Mercator {W} x {H} px")
    src = ds.read(1)
    src[src > 20] = 0  # only the 20 documented classes
    merc = np.zeros((H, W), dtype=np.uint8)
    reproject(source=src, destination=merc, src_transform=ds.transform, src_crs=ds.crs,
              dst_transform=dst_transform, dst_crs="EPSG:3857",
              resampling=Resampling.nearest, src_nodata=0, dst_nodata=0)
    del src

gx0, gy0 = tx0 * 256, ty0 * 256
pal = [0, 0, 0] * 256
for k, hexc in PALETTE.items():
    pal[k * 3:k * 3 + 3] = [int(hexc[i:i + 2], 16) for i in (0, 2, 4)]

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
            d = os.path.join(OUT, str(z), str(x))
            os.makedirs(d, exist_ok=True)
            img = Image.fromarray(np.ascontiguousarray(tile), mode="P")
            img.putpalette(pal)
            img.save(os.path.join(d, f"{y}.png"), optimize=True, transparency=0)
            n_z += 1
    count += n_z
    log(f"zoom {z}: {n_z} tiles")

total = sum(os.path.getsize(os.path.join(r, fn)) for r, _, fs in os.walk(OUT) for fn in fs)
log(f"done: {count} tiles, {total / 1048576:.1f} MB in {OUT}")
