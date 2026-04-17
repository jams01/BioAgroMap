import json
import re
import uuid

import numpy as np
import rasterio
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import (
    _existing_raster_path,
    _get_project_raster,
    _tenant_storage,
    is_legacy_s2_zip_band_raster,
)
from app.core.config import settings
from app.db.session import get_db
from app.models.models import Layer, Project, RasterLayer
from app.schemas.schemas import (
    ClusterRequest,
    CropRequest,
    DownloadRequest,
    IndicesRequest,
    S2IndexStacksRequest,
    S2L2aRecorteRequest,
    StackRequest,
)

router = APIRouter()


@router.post("/preprocess/download")
def preprocess_download(payload: DownloadRequest, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if payload.source == "sentinel-2":
        if not settings.copernicus_user or not settings.copernicus_password:
            raise HTTPException(status_code=500, detail="Copernicus credentials not configured")
        if not payload.start_date or not payload.end_date:
            raise HTTPException(status_code=400, detail="start_date and end_date are required for Sentinel-2")

        from app.services.project_geometry import wkt_union_from_project_layers

        wkt = wkt_union_from_project_layers(db, payload.project_id, tenant_id, payload.layer_id)
        if not wkt:
            raise HTTPException(status_code=400, detail="No vector layer found in project to define download area. Upload a lote first.")

        project_slug = project.name.replace(" ", "_").lower()
        out_dir = _tenant_storage(tenant_id, payload.project_id, "downloads") / project_slug
        out_dir.mkdir(parents=True, exist_ok=True)

        raster = RasterLayer(
            project_id=payload.project_id,
            tenant_id=tenant_id,
            name=f"Sentinel-2 ({payload.start_date} a {payload.end_date})",
            file_path=str(out_dir),
            cog_path=None,
            raster_metadata={
                "source": "sentinel-2",
                "type": "download",
                "status": "downloading",
                "start_date": payload.start_date,
                "end_date": payload.end_date,
            },
        )
        db.add(raster)
        db.commit()
        db.refresh(raster)

        from app.tasks.jobs import download_sentinel2

        async_result = download_sentinel2.delay(
            wkt,
            payload.start_date,
            payload.end_date,
            str(out_dir),
            settings.copernicus_user,
            settings.copernicus_password,
            raster.id,
            settings.database_url,
        )
        raster.raster_metadata = {
            **(raster.raster_metadata or {}),
            "celery_task_id": async_result.id,
        }
        db.commit()

        return {
            "status": "downloading",
            "raster_layer_id": raster.id,
            "task_id": async_result.id,
            "output_dir": str(out_dir),
        }

    out_dir = _tenant_storage(tenant_id, payload.project_id, "rasters")
    out_path = out_dir / f"download_{payload.source}_{uuid.uuid4().hex}.tif"

    width, height = 256, 256
    data = (np.random.rand(height, width) * 255).astype("uint8")
    transform = rasterio.transform.from_origin(-74.2, 4.9, 0.0005, 0.0005)
    with rasterio.open(
        out_path, "w", driver="GTiff", height=height, width=width,
        count=1, dtype=data.dtype, crs="EPSG:4326", transform=transform,
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


@router.get("/preprocess/sentinel-status/{project_id}/{raster_id}")
def sentinel_download_status(
    project_id: int,
    raster_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Poll Sentinel-2 download progress (Celery + DB metadata)."""
    from celery.result import AsyncResult

    from app.tasks.celery_app import celery_app

    raster = (
        db.query(RasterLayer)
        .filter(
            RasterLayer.id == raster_id,
            RasterLayer.project_id == project_id,
            RasterLayer.tenant_id == tenant_id,
        )
        .first()
    )
    if not raster:
        raise HTTPException(status_code=404, detail="Raster not found")

    meta = raster.raster_metadata or {}
    db_status = meta.get("status")
    progress = int(meta.get("progress", 0) or 0)
    message = meta.get("progress_message") or "Preparando descarga..."

    if db_status == "completed":
        return {
            "ui_status": "completed",
            "progress": 100,
            "message": meta.get("progress_message") or "Descarga terminada",
            "total_downloaded": meta.get("total_downloaded"),
            "total_size_mb": meta.get("total_size_mb"),
        }

    if db_status == "failed":
        return {
            "ui_status": "failed",
            "progress": 0,
            "message": meta.get("error") or meta.get("progress_message") or "Error en descarga",
        }

    task_id = meta.get("celery_task_id")
    celery_state = None
    if task_id:
        ar = AsyncResult(task_id, app=celery_app)
        celery_state = ar.state

        # Celery a menudo queda en STARTED mientras el worker actualiza la BD; la barra y el
        # mensaje deben salir sobre todo de raster_metadata (progress_callback).
        if celery_state == "PROGRESS" and isinstance(ar.info, dict):
            cp = int(ar.info.get("progress", 0) or 0)
            cm = ar.info.get("message")
            progress = max(progress, cp)
            if cm:
                message = str(cm)

        if celery_state == "SUCCESS" or (ar.ready() and ar.successful()):
            return {
                "ui_status": "completed",
                "progress": 100,
                "message": meta.get("progress_message") or "Descarga terminada",
                "total_downloaded": meta.get("total_downloaded"),
                "total_size_mb": meta.get("total_size_mb"),
                "celery_state": celery_state,
            }

        if celery_state == "FAILURE" or (ar.ready() and ar.failed()):
            err = str(ar.result) if ar.result else "Error en la tarea"
            return {
                "ui_status": "failed",
                "progress": 0,
                "message": err,
                "celery_state": celery_state,
            }

    return {
        "ui_status": "downloading",
        "progress": progress,
        "message": message,
        "celery_state": celery_state,
    }


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
    return {"status": "ok", "output_path": str(out_path)}


@router.post("/preprocess/s2-index-stacks")
def preprocess_s2_index_stacks(
    payload: S2IndexStacksRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Genera stacks multibanda (una banda por escena/fecha) por índice en ``indices/<INDICE>/``.
    Requiere GeoTIFF de recorte L2A de 6 bandas en ``recortes/``.
    """
    from app.services.s2_vegetation_indices import normalize_requested_indices
    from app.tasks.jobs import s2_index_stacks_pipeline

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    pairs = normalize_requested_indices(payload.indices)
    if not pairs:
        raise HTTPException(
            status_code=400,
            detail="Selecciona al menos un índice (o TODOS).",
        )

    rids = payload.raster_layer_ids
    if rids is not None and len(rids) == 0:
        rids = None

    try:
        async_result = s2_index_stacks_pipeline.delay(
            tenant_id,
            payload.project_id,
            payload.indices,
            settings.database_url,
            rids,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo encolar la tarea de índices. ¿Redis y worker activos? {exc!s}",
        ) from exc
    return {"status": "queued", "task_id": async_result.id}


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
    rasters = [r for r in rasters if not is_legacy_s2_zip_band_raster(r.raster_metadata)]
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


@router.post("/preprocess/s2-l2a-recortes")
def preprocess_s2_l2a_recortes(
    payload: S2L2aRecorteRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Por cada producto L2A (.zip o carpeta .SAFE) en la carpeta de descargas del proyecto:
    apila 6 bandas (B02,B03,B04,B08; B05 y B11 remuestreadas a la grilla 10 m de B02), recorta al
    polígono del lote, guarda en `recortes/` (GeoTIFF con nombre del producto) y registra la capa (vista RGB R=B04,G=B03,B=B02).
    """
    from app.services.project_geometry import wkt_union_from_project_layers
    from app.tasks.jobs import s2_l2a_recortes_pipeline

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if payload.layer_id is not None:
        found = (
            db.query(Layer)
            .filter(
                Layer.id == payload.layer_id,
                Layer.project_id == payload.project_id,
                Layer.tenant_id == tenant_id,
            )
            .first()
        )
        if not found:
            raise HTTPException(
                status_code=404,
                detail=f"No existe la capa vectorial {payload.layer_id} en este proyecto.",
            )

    wkt = wkt_union_from_project_layers(db, payload.project_id, tenant_id, payload.layer_id)
    if not wkt:
        if payload.layer_id is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"No se pudo leer geometría para la capa {payload.layer_id} "
                    "(archivo ausente o formato no soportado). Comprueba el lote o elige «Todos los lotes»."
                ),
            )
        raise HTTPException(
            status_code=400,
            detail="No hay polígono vectorial en el proyecto. Carga un lote antes.",
        )

    try:
        async_result = s2_l2a_recortes_pipeline.delay(
            tenant_id,
            payload.project_id,
            project.name,
            payload.layer_id,
            settings.database_url,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "No se pudo encolar la tarea de recorte. Comprueba que Redis esté en marcha "
                f"y el worker Celery activo. Detalle: {exc!s}"
            ),
        ) from exc
    return {"status": "queued", "task_id": async_result.id}


@router.get("/preprocess/task-status/{task_id}")
def preprocess_task_status(task_id: str):
    """Estado de una tarea Celery (p. ej. pipeline S2 L2A recortes)."""
    from celery.result import AsyncResult

    from app.tasks.celery_app import celery_app

    ar = AsyncResult(task_id, app=celery_app)
    if ar.state == "PENDING":
        return {"state": ar.state, "ready": False}
    if ar.state == "SUCCESS":
        return {"state": ar.state, "ready": True, "result": ar.result}
    if ar.state == "FAILURE":
        return {"state": ar.state, "ready": True, "error": str(ar.result) if ar.result else "failure"}
    return {"state": ar.state, "ready": ar.ready(), "info": ar.info}
