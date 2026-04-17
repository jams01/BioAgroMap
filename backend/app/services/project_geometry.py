"""Geometría del proyecto (capas vectoriales) para AOI / recorte."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

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

    from shapely.geometry import shape
    from shapely.ops import unary_union

    all_geoms = []
    for layer in layers:
        geojson_data = layer_to_geojson(layer)
        if not geojson_data:
            continue
        features = geojson_data.get("features", [geojson_data])
        for f in features:
            geom_dict = f.get("geometry") or f
            if not geom_dict or not geom_dict.get("type"):
                continue
            try:
                all_geoms.append(shape(geom_dict))
            except Exception:
                continue

    if not all_geoms:
        return None

    union = unary_union(all_geoms)
    if union.geom_type == "MultiPolygon" and len(union.geoms) == 1:
        union = union.geoms[0]
    return union.wkt
