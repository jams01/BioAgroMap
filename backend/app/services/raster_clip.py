"""Recorte de GeoTIFF con polígono WGS84 (WKT), conservando georreferencia (rasterio.mask)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask
from rasterio.warp import transform_geom
from shapely import force_2d
from shapely.geometry import mapping, shape
from shapely.geometry.base import BaseGeometry


def clip_raster_by_wkt_polygon(
    raster_path: Path,
    wkt_polygon: str,
    out_path: Path,
) -> None:
    """
    Recorta `raster_path` al polígono en WKT (EPSG:4326). Salida GeoTIFF con CRS y transform del recorte.
    """
    from shapely import from_wkt

    geom_wgs: BaseGeometry = from_wkt(wkt_polygon)
    if not geom_wgs.is_valid:
        geom_wgs = geom_wgs.buffer(0)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(raster_path) as src:
        if src.crs is not None:
            geom_dict = mapping(geom_wgs)
            geom_dict = transform_geom("EPSG:4326", src.crs, geom_dict)
            geom_proj = shape(geom_dict)
        else:
            geom_proj = geom_wgs

        geoms = [mapping(force_2d(geom_proj))]
        out_image, out_transform = rio_mask(src, geoms, crop=True, nodata=np.nan)
        out_meta = src.meta.copy()
        out_meta.update(
            {
                "driver": "GTiff",
                "height": out_image.shape[1],
                "width": out_image.shape[2],
                "transform": out_transform,
                "compress": "lzw",
                "tiled": True,
                "blockxsize": 256,
                "blockysize": 256,
            }
        )
        if np.isnan(out_image).any():
            out_meta["dtype"] = "float32"
            out_image = out_image.astype(np.float32)
        else:
            out_meta["dtype"] = out_image.dtype

    with rasterio.open(out_path, "w", **out_meta) as dst:
        dst.write(out_image)
