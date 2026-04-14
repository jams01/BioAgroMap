from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

output = Path("data/sample/agri_sample.tif")
output.parent.mkdir(parents=True, exist_ok=True)

width = 256
height = 256
data = (np.random.rand(height, width) * 255).astype("uint8")
transform = from_origin(-74.2, 4.8, 0.0005, 0.0005)

with rasterio.open(
    output,
    "w",
    driver="GTiff",
    height=height,
    width=width,
    count=1,
    dtype=data.dtype,
    crs="EPSG:4326",
    transform=transform,
) as dst:
    dst.write(data, 1)

print(f"Sample raster generated at {output}")
