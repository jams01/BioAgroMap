"""Lectura de AOI vectorial (GeoJSON, shapefile ZIP) con geopandas."""

from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union


def geometry_wkt_from_vector_path(path: Path) -> tuple[str, dict]:
    """
    Lee un vectorial, reproyecta a EPSG:4326, unifica geometrías y devuelve WKT + bbox [minx,miny,maxx,maxy].
    """
    import geopandas as gpd

    p = path.resolve()
    if not p.exists():
        raise ValueError("El archivo vectorial no existe")

    read_path: str | Path = p
    tmp_dir: tempfile.TemporaryDirectory[str] | None = None
    try:
        ext = p.suffix.lower()
        if ext == ".zip":
            with zipfile.ZipFile(p) as zf:
                shp_names = [n for n in zf.namelist() if n.lower().endswith(".shp")]
                if shp_names:
                    tmp_dir = tempfile.TemporaryDirectory()
                    zf.extractall(tmp_dir.name)
                    read_path = str(Path(tmp_dir.name) / shp_names[0])
                else:
                    read_path = f"zip://{p}"

        gdf = gpd.read_file(read_path)
        if gdf.empty:
            raise ValueError("El archivo vectorial no contiene entidades")

        if gdf.crs is None:
            gdf = gdf.set_crs(4326)
        else:
            gdf = gdf.to_crs(4326)

        geom = unary_union(gdf.geometry.dropna().tolist())
        if geom.is_empty:
            raise ValueError("Geometría vacía")
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty:
            raise ValueError("Geometría inválida tras corrección")

        wkt = geom.wkt
        b = geom.bounds
        meta = {
            "bounds_wgs84": [float(b[0]), float(b[1]), float(b[2]), float(b[3])],
            "geojson": mapping(geom),
        }
        return wkt, meta
    finally:
        if tmp_dir is not None:
            tmp_dir.cleanup()
