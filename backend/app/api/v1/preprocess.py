import json
import uuid

import numpy as np
import rasterio
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import _existing_raster_path, _get_project_raster, _tenant_storage
from app.db.session import get_db
from app.models.models import Project, RasterLayer
from app.schemas.schemas import (
    ClusterRequest,
    CropRequest,
    DownloadRequest,
    IndicesRequest,
    StackRequest,
)

router = APIRouter()


@router.post("/preprocess/download")
def preprocess_download(payload: DownloadRequest, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    out_dir = _tenant_storage(tenant_id, payload.project_id, "rasters")
    out_path = out_dir / f"download_{payload.source}_{uuid.uuid4().hex}.tif"

    width, height = 256, 256
    data = (np.random.rand(height, width) * 255).astype("uint8")
    transform = rasterio.transform.from_origin(-74.2, 4.9, 0.0005, 0.0005)
    with rasterio.open(
        out_path,
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

    raster = RasterLayer(
        project_id=payload.project_id,
        tenant_id=tenant_id,
        name=f"{payload.source}.tif",
        file_path=str(out_path),
        cog_path=str(out_path),
        raster_metadata={"source": payload.source, "type": "download"},
    )
    db.add(raster)
    db.commit()
    db.refresh(raster)
    return {"status": "ok", "raster_layer_id": raster.id}


@router.post("/preprocess/crop")
def preprocess_crop(payload: CropRequest, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    raster = _get_project_raster(db, tenant_id, payload.project_id, payload.raster_layer_id)
    src_path = _existing_raster_path(raster)
    out_path = _tenant_storage(tenant_id, payload.project_id, "preprocess") / f"crop_{uuid.uuid4().hex}.tif"

    ratio = max(0.2, min(1.0, payload.crop_ratio))
    with rasterio.open(src_path) as src:
        h = int(src.height * ratio)
        w = int(src.width * ratio)
        r0 = (src.height - h) // 2
        c0 = (src.width - w) // 2
        window = rasterio.windows.Window(c0, r0, w, h)
        data = src.read(window=window)
        profile = src.profile.copy()
        profile.update(height=h, width=w, transform=src.window_transform(window))
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(data)
    return {"status": "ok"}


@router.post("/preprocess/indices")
def preprocess_indices(
    payload: IndicesRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    raster = _get_project_raster(db, tenant_id, payload.project_id, payload.raster_layer_id)
    src_path = _existing_raster_path(raster)
    out_path = _tenant_storage(tenant_id, payload.project_id, "preprocess") / f"{payload.index_type.lower()}_{uuid.uuid4().hex}.tif"

    with rasterio.open(src_path) as src:
        band = src.read(1).astype("float32")
        nir = band
        red = np.clip(band * 0.7, 1, 255)
        green = np.clip(band * 0.5, 1, 255)
        if payload.index_type.upper() == "NDVI":
            idx = (nir - red) / (nir + red + 1e-6)
        elif payload.index_type.upper() == "EVI":
            idx = 2.5 * (nir - red) / (nir + 6 * red - 7.5 * green + 1)
        elif payload.index_type.upper() == "NDWI":
            idx = (green - nir) / (green + nir + 1e-6)
        else:
            raise HTTPException(status_code=400, detail="Unsupported index type")
        profile = src.profile.copy()
        profile.update(dtype="float32", count=1)
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(idx.astype("float32"), 1)
    return {"status": "ok", "index_type": payload.index_type.upper()}


@router.post("/preprocess/stack")
def preprocess_stack(payload: StackRequest, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    rasters = (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == payload.project_id, RasterLayer.tenant_id == tenant_id)
        .order_by(RasterLayer.id.desc())
        .all()
    )
    if not rasters:
        raise HTTPException(status_code=404, detail="No rasters available")
    if payload.mode.lower() == "visualizar":
        return {
            "status": "ok",
            "mode": "visualizar",
            "rasters": [{"id": r.id, "name": r.name} for r in rasters[:10]],
        }
    if payload.mode.lower() == "gif":
        out_path = _tenant_storage(tenant_id, payload.project_id, "preprocess") / f"stack_gif_manifest_{uuid.uuid4().hex}.json"
        out_path.write_text(
            json.dumps([{"id": r.id, "name": r.name} for r in rasters[:12]], indent=2),
            encoding="utf-8",
        )
        return {"status": "ok", "mode": "gif"}
    raise HTTPException(status_code=400, detail="Unsupported stack mode")


@router.post("/preprocess/cluster")
def preprocess_cluster(
    payload: ClusterRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    raster = _get_project_raster(db, tenant_id, payload.project_id, payload.raster_layer_id)
    src_path = _existing_raster_path(raster)
    out_path = _tenant_storage(tenant_id, payload.project_id, "preprocess") / f"cluster_{uuid.uuid4().hex}.tif"

    k = max(2, min(10, payload.clusters))
    with rasterio.open(src_path) as src:
        band = src.read(1).astype("float32")
        bins = np.quantile(band, np.linspace(0, 1, k + 1))
        classified = np.digitize(band, bins[1:-1]).astype("uint8")
        profile = src.profile.copy()
        profile.update(dtype="uint8", count=1)
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(classified, 1)
    return {"status": "ok", "clusters": k}
