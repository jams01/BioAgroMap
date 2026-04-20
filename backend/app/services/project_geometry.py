"""Geometría del proyecto (capas vectoriales) para AOI / recorte."""

from __future__ import annotations

import json
import logging
import re
import zipfile
from pathlib import Path

logger = logging.getLogger(__name__)

from sqlalchemy.orm import Session

from app.models.models import Layer


def _kml_to_geojson(xml_text: str) -> dict | None:
    from app.api.v1.layers import _kml_to_geojson as kml_conv

    return kml_conv(xml_text)


def _safe_zip_name(name: str) -> bool:
    return ".." not in name and not name.startswith("/")


def layer_to_geojson(layer: Layer) -> dict | None:
    """Convierte el archivo de capa a GeoJSON dict."""
    fp = Path(layer.file_path)
    if not fp.exists():
        return None

    ext = fp.suffix.lower()
    try:
        if ext in {".geojson", ".json"}:
            return json.loads(fp.read_text(encoding="utf-8"))
        if ext == ".kml":
            return _kml_to_geojson(fp.read_text(encoding="utf-8"))
        if ext == ".kmz":
            with zipfile.ZipFile(fp) as zf:
                for name in zf.namelist():
                    if not _safe_zip_name(name):
                        continue
                    if name.lower().endswith(".kml"):
                        result = _kml_to_geojson(zf.read(name).decode("utf-8"))
                        if result:
                            return result
        if ext == ".zip":
            with zipfile.ZipFile(fp) as zf:
                for name in zf.namelist():
                    if not _safe_zip_name(name):
                        continue
                    if name.lower().endswith((".geojson", ".json")):
                        return json.loads(zf.read(name).decode("utf-8"))
                    if name.lower().endswith(".kml"):
                        result = _kml_to_geojson(zf.read(name).decode("utf-8"))
                        if result:
                            return result
    except Exception:
        pass
    return None


def _epsg_from_geojson_crs(geo: dict) -> int | None:
    """EPSG numérico desde propiedad legacy ``crs`` de GeoJSON (RFC antiguo)."""
    crs = geo.get("crs")
    if not crs or not isinstance(crs, dict):
        return None
    if crs.get("type") != "name":
        return None
    name = str(crs.get("properties", {}).get("name", ""))
    m = re.search(r"(?:EPSG|epsg)[\s:]*([0-9]{4,5})", name, re.I)
    if m:
        return int(m.group(1))
    m = re.search(r"urn:ogc:def:crs:EPSG::([0-9]{4,5})", name, re.I)
    if m:
        return int(m.group(1))
    return None


def _geometries_wgs84_from_geojson(geojson_data: dict) -> list:
    """
    Extrae geometrías Shapely en **EPSG:4326**.

    Si el GeoJSON declara ``crs`` (p. ej. UTM), reproyecta con GeoPandas. Sin ``crs``, se asume WGS84
    (KML/KMZ y GeoJSON RFC 7946).
    """
    import geopandas as gpd
    from shapely.geometry import shape

    epsg = _epsg_from_geojson_crs(geojson_data)
    raw = geojson_data.get("features")
    if not raw:
        g = geojson_data.get("geometry")
        if isinstance(g, dict) and g.get("type"):
            raw = [{"type": "Feature", "geometry": g, "properties": {}}]
        else:
            raw = []
    geoms = []
    for f in raw:
        if not isinstance(f, dict):
            continue
        geom_dict = f.get("geometry") or f
        if not isinstance(geom_dict, dict) or not geom_dict.get("type"):
            continue
        try:
            geoms.append(shape(geom_dict))
        except Exception:
            continue
    if not geoms:
        return []
    init = epsg if epsg is not None else 4326
    try:
        gdf = gpd.GeoDataFrame(geometry=geoms, crs=f"EPSG:{init}")
        if epsg is not None and epsg != 4326:
            gdf = gdf.to_crs(4326)
        return list(gdf.geometry)
    except Exception as exc:
        logger.warning("No se pudo normalizar CRS del GeoJSON (se asume WGS84): %s", exc)
        return geoms


def wkt_union_from_project_layers(
    db: Session,
    project_id: int,
    tenant_id: int,
    layer_id: int | None = None,
) -> str | None:
    """WKT del polígono (unión) en EPSG:4326 desde capas vectoriales del proyecto."""
    if layer_id:
        layer = db.query(Layer).filter(
            Layer.id == layer_id, Layer.project_id == project_id, Layer.tenant_id == tenant_id
        ).first()
        layers = [layer] if layer else []
    else:
        layers = db.query(Layer).filter(Layer.project_id == project_id, Layer.tenant_id == tenant_id).all()

    if not layers:
        return None

    from shapely.ops import unary_union

    all_geoms = []
    for layer in layers:
        geojson_data = layer_to_geojson(layer)
        if not geojson_data:
            continue
        for gm in _geometries_wgs84_from_geojson(geojson_data):
            all_geoms.append(gm)

    if not all_geoms:
        return None

    union = unary_union(all_geoms)
    if not union.is_valid:
        union = union.buffer(0)
    if union.geom_type == "MultiPolygon" and len(union.geoms) == 1:
        union = union.geoms[0]
    return union.wkt
