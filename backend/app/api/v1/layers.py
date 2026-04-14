import json
import re
import shutil
import uuid
import zipfile
from pathlib import Path

from defusedxml.ElementTree import fromstring as safe_xml_parse
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import _tenant_storage, validate_upload_size
from app.db.session import get_db
from app.models.models import Layer, Project

router = APIRouter()


def _safe_zip_name(name: str) -> bool:
    return ".." not in name and not name.startswith("/") and not name.startswith("\\")


@router.post("/upload-shapefile")
async def upload_shapefile(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await validate_upload_size(file)
    out_dir = _tenant_storage(tenant_id, project_id, "vectors")
    ext = Path(file.filename).suffix.lower()
    if ext not in {".zip", ".shp", ".geojson", ".json", ".kml", ".kmz"}:
        raise HTTPException(status_code=400, detail="Unsupported vector format")
    destination = out_dir / f"{uuid.uuid4().hex}{ext}"
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    layer = Layer(
        project_id=project_id,
        tenant_id=tenant_id,
        name=file.filename,
        file_path=str(destination),
        geom_type="Vector",
        layer_metadata={"source_name": file.filename},
    )
    db.add(layer)
    db.commit()
    db.refresh(layer)
    return {"layer_id": layer.id}


@router.get("/layers/{project_id}")
def list_layers(project_id: int, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    layers = (
        db.query(Layer)
        .filter(Layer.project_id == project_id, Layer.tenant_id == tenant_id)
        .all()
    )
    return [
        {
            "id": l.id,
            "name": l.name,
            "geom_type": l.geom_type,
            "metadata": l.layer_metadata,
        }
        for l in layers
    ]


@router.delete("/layers/{project_id}/{layer_id}")
def delete_layer(
    project_id: int,
    layer_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    layer = (
        db.query(Layer)
        .filter(Layer.id == layer_id, Layer.project_id == project_id, Layer.tenant_id == tenant_id)
        .first()
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    fp = Path(layer.file_path)
    if fp.exists():
        fp.unlink(missing_ok=True)
    db.delete(layer)
    db.commit()
    return {"status": "ok", "deleted_layer_id": layer_id}


def _kml_to_geojson(kml_text: str) -> dict | None:
    root = safe_xml_parse(kml_text)
    ns = re.match(r"\{.*\}", root.tag)
    ns = ns.group(0) if ns else ""
    features = []
    for pm in root.iter(f"{ns}Placemark"):
        name_el = pm.find(f"{ns}name")
        name = name_el.text if name_el is not None else ""
        coords_el = pm.find(f".//{ns}coordinates")
        if coords_el is None or not coords_el.text:
            continue
        raw = coords_el.text.strip()
        points = []
        for s in raw.split():
            parts = s.split(",")
            if len(parts) >= 2:
                points.append([float(parts[0]), float(parts[1])])
        if not points:
            continue
        if len(points) == 1:
            geometry = {"type": "Point", "coordinates": points[0]}
        elif len(points) > 2 and points[0] == points[-1]:
            geometry = {"type": "Polygon", "coordinates": [points]}
        else:
            geometry = {"type": "LineString", "coordinates": points}
        features.append({"type": "Feature", "properties": {"name": name}, "geometry": geometry})
    if not features:
        return None
    return {"type": "FeatureCollection", "features": features}


@router.get("/layers/{project_id}/{layer_id}/geojson")
def get_layer_geojson(
    project_id: int,
    layer_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    layer = (
        db.query(Layer)
        .filter(Layer.id == layer_id, Layer.project_id == project_id, Layer.tenant_id == tenant_id)
        .first()
    )
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    fp = Path(layer.file_path)
    if not fp.exists():
        raise HTTPException(status_code=404, detail="Layer file not found on disk")
    ext = fp.suffix.lower()
    if ext in {".geojson", ".json"}:
        return JSONResponse(json.loads(fp.read_text(encoding="utf-8")))
    if ext == ".kml":
        result = _kml_to_geojson(fp.read_text(encoding="utf-8"))
        if result:
            return JSONResponse(result)
    if ext == ".kmz":
        try:
            with zipfile.ZipFile(fp) as zf:
                for name in zf.namelist():
                    if not _safe_zip_name(name):
                        continue
                    if name.lower().endswith(".kml"):
                        kml_text = zf.read(name).decode("utf-8")
                        result = _kml_to_geojson(kml_text)
                        if result:
                            return JSONResponse(result)
        except Exception:
            pass
    if ext == ".zip":
        try:
            with zipfile.ZipFile(fp) as zf:
                for name in zf.namelist():
                    if not _safe_zip_name(name):
                        continue
                    if name.lower().endswith((".geojson", ".json")):
                        return JSONResponse(json.loads(zf.read(name).decode("utf-8")))
                    if name.lower().endswith(".kml"):
                        result = _kml_to_geojson(zf.read(name).decode("utf-8"))
                        if result:
                            return JSONResponse(result)
        except Exception:
            pass
    raise HTTPException(status_code=422, detail="Cannot convert this layer to GeoJSON")
