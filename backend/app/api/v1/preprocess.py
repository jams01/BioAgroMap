import json
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

import numpy as np
import rasterio
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import (
    _existing_raster_path,
    _get_project_raster,
    _tenant_storage,
    is_legacy_s2_zip_band_raster,
    project_downloads_dir,
    validate_upload_size,
)
from app.services.raster_geo import render_raster_preview_png
from app.core.config import settings
from app.db.session import get_db
from app.models.models import Layer, Project, RasterLayer
from app.schemas.schemas import (
    ClusterRequest,
    CropRequest,
    DownloadRequest,
    IndicesRequest,
    S1GrdRecorteRequest,
    S2IndexStacksRequest,
    S2L2aRecorteRequest,
    StackRequest,
    VegetationTimeSeriesRequest,
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

        out_dir = project_downloads_dir(tenant_id, payload.project_id, project.name)
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


@router.post("/preprocess/sentinel1-download")
async def preprocess_sentinel1_download(
    project_id: int = Form(...),
    start_date: str = Form(...),
    end_date: str = Form(...),
    layer_id: str | None = Form(None),
    aoi_file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Descarga Sentinel-1 GRD IW (VV+VH) desde Copernicus (STAC + OData).
    AOI: capa vectorial del proyecto (layer_id) o archivo GeoJSON / ZIP shapefile (aoi_file).
    """
    from datetime import date as date_cls

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not settings.copernicus_user or not settings.copernicus_password:
        raise HTTPException(status_code=500, detail="Copernicus credentials not configured")

    lid = None
    if layer_id is not None and str(layer_id).strip() != "":
        try:
            lid = int(layer_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="layer_id inválido")
        if lid < 1:
            raise HTTPException(status_code=400, detail="layer_id inválido")

    has_aoi_upload = bool(aoi_file and getattr(aoi_file, "filename", None))
    if not has_aoi_upload and lid is None:
        raise HTTPException(
            status_code=400,
            detail="Indica una capa vectorial (paso 1) o sube un AOI (GeoJSON o ZIP shapefile).",
        )

    try:
        d0 = date_cls.fromisoformat(start_date.strip())
        d1 = date_cls.fromisoformat(end_date.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail="Fechas inválidas; use YYYY-MM-DD")

    if d1 < d0:
        raise HTTPException(status_code=400, detail="La fecha final debe ser >= fecha inicial")

    wkt: str | None = None
    if has_aoi_upload:
        await validate_upload_size(aoi_file)
        ext = Path(aoi_file.filename).suffix.lower()
        allowed = {".geojson", ".json", ".zip"}
        if ext not in allowed:
            raise HTTPException(status_code=400, detail="AOI: use .geojson, .json o .zip (shapefile)")

        raw = await aoi_file.read()
        with tempfile.NamedTemporaryFile(suffix=ext, prefix="aoi_s1_", delete=False) as tf:
            tf.write(raw)
            tmp_path = Path(tf.name)
        try:
            from app.services.aoi_vector import geometry_wkt_from_vector_path

            wkt, _meta = geometry_wkt_from_vector_path(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)

    if wkt is None and lid is not None:
        from app.services.project_geometry import wkt_union_from_project_layers

        wkt = wkt_union_from_project_layers(db, project_id, tenant_id, lid)
        if not wkt:
            raise HTTPException(status_code=400, detail="No se pudo obtener geometría desde la capa vectorial.")

    if not wkt:
        raise HTTPException(status_code=400, detail="AOI vacío o inválido.")

    out_dir = project_downloads_dir(tenant_id, project_id, project.name)
    out_dir.mkdir(parents=True, exist_ok=True)

    raster = RasterLayer(
        project_id=project_id,
        tenant_id=tenant_id,
        name=f"Sentinel-1 GRD IW ({start_date} a {end_date})",
        file_path=str(out_dir / "Sentinel1"),
        cog_path=None,
        raster_metadata={
            "source": "sentinel-1",
            "type": "download",
            "status": "downloading",
            "start_date": start_date,
            "end_date": end_date,
            "layer_id": lid,
        },
    )
    db.add(raster)
    db.commit()
    db.refresh(raster)

    from app.tasks.jobs import download_sentinel1

    async_result = download_sentinel1.delay(
        wkt,
        start_date.strip(),
        end_date.strip(),
        str(out_dir),
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
        "sentinel1_subdir": str(out_dir / "Sentinel1"),
    }


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
        done = {
            "ui_status": "completed",
            "progress": 100,
            "message": meta.get("progress_message") or "Descarga terminada",
            "total_downloaded": meta.get("total_downloaded"),
            "total_size_mb": meta.get("total_size_mb"),
        }
        if meta.get("source") == "sentinel-1":
            done["selected_relative_orbit"] = meta.get("selected_relative_orbit")
            done["selected_orbit_direction"] = meta.get("selected_orbit_direction")
            done["selected_pass_short"] = meta.get("selected_pass_short")
            done["date_range_start"] = meta.get("date_range_start")
            done["date_range_end"] = meta.get("date_range_end")
            done["csv_path"] = meta.get("csv_path")
        return done

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
            done = {
                "ui_status": "completed",
                "progress": 100,
                "message": meta.get("progress_message") or "Descarga terminada",
                "total_downloaded": meta.get("total_downloaded"),
                "total_size_mb": meta.get("total_size_mb"),
                "celery_state": celery_state,
            }
            if meta.get("source") == "sentinel-1":
                done["selected_relative_orbit"] = meta.get("selected_relative_orbit")
                done["selected_orbit_direction"] = meta.get("selected_orbit_direction")
                done["selected_pass_short"] = meta.get("selected_pass_short")
                done["date_range_start"] = meta.get("date_range_start")
                done["date_range_end"] = meta.get("date_range_end")
                done["csv_path"] = meta.get("csv_path")
            return done

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


def _safe_relative_under(root: Path, p: Path) -> str | None:
    """Ruta posix relativa a ``root`` o None si ``p`` no queda bajo ``root``."""
    try:
        root_r = root.resolve()
        pr = p.resolve()
        rel = pr.relative_to(root_r)
        return rel.as_posix()
    except ValueError:
        return None


@router.get("/preprocess/recortes-inventory/{project_id}")
def get_recortes_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Lista GeoTIFF bajo ``recortes/`` (incl. subcarpetas) con ≥6 bandas, sin depender de capas en BD.
    ``relative_path`` identifica el archivo para preview y tareas; ``basename`` es solo el nombre final.
    ``raster_layer_id`` si una capa apunta al mismo path resuelto o al mismo nombre en la raíz.
    """
    from app.services.s2_vegetation_indices import sort_key_from_path_or_meta

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    recortes_root = _tenant_storage(tenant_id, project_id, "recortes")
    if not recortes_root.is_dir():
        return {"items": []}

    resolved_to_rid: dict[Path, int] = {}
    name_to_rid: dict[str, int] = {}
    for r in (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    ):
        for attr in (r.file_path, r.cog_path):
            if not attr:
                continue
            fp = Path(attr)
            bn = fp.name
            if "_cog" in bn.lower():
                continue
            if not bn.lower().endswith(".tif"):
                continue
            if fp.is_file():
                try:
                    resolved_to_rid[fp.resolve()] = r.id
                except OSError:
                    pass
            if bn not in name_to_rid:
                name_to_rid[bn] = r.id

    items: list[dict] = []
    for p in sorted(recortes_root.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        rel = _safe_relative_under(recortes_root, p)
        if rel is None:
            continue
        try:
            with rasterio.open(p) as src:
                bands = int(src.count)
        except Exception:
            continue
        if bands < 6:
            continue
        sk = sort_key_from_path_or_meta(p, None)
        if not sk:
            try:
                sk = datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()
            except OSError:
                sk = "1900-01-01"
        rid = resolved_to_rid.get(p.resolve())
        if rid is None:
            rid = name_to_rid.get(p.name)
        items.append(
            {
                "basename": p.name,
                "relative_path": rel,
                "bands": bands,
                "sort_key": sk,
                "raster_layer_id": rid,
            }
        )
    items.sort(key=lambda x: (x["sort_key"], x["relative_path"]))
    return {"items": items}


@router.get("/preprocess/recortes-preview/{project_id}")
def get_recorte_preview_disk(
    project_id: int,
    recorte_relpath: str | None = Query(
        None,
        alias="path",
        description="Ruta relativa dentro de recortes/ (p. ej. sub/escena.tif). Preferido frente a name.",
    ),
    name: str | None = Query(
        None,
        min_length=1,
        description="Solo basename en la raíz de recortes/ (compatibilidad). Usar query path si hay subcarpetas.",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Vista RGB (B04,B03,B02) desde un archivo en ``recortes/`` sin capa en BD."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _tenant_storage(tenant_id, project_id, "recortes").resolve()

    tif_path: Path
    basename: str
    if recorte_relpath is not None and str(recorte_relpath).strip():
        rel = Path(str(recorte_relpath).strip().replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts:
            raise HTTPException(status_code=400, detail="Ruta relativa no válida")
        full_path = (root / rel).resolve()
        if not full_path.is_file() or not full_path.is_relative_to(root):
            raise HTTPException(status_code=404, detail="GeoTIFF no encontrado en recortes/")
        tif_path = full_path
        basename = tif_path.name
    elif name is not None and str(name).strip():
        raw = str(name).strip()
        if not raw or ".." in raw or "/" in raw or "\\" in raw:
            raise HTTPException(status_code=400, detail="Nombre de archivo no válido")
        basename = Path(raw).name
        if basename != raw:
            raise HTTPException(status_code=400, detail="Usa solo el nombre del archivo")
        tif_path = (root / basename).resolve()
        if not tif_path.is_file() or tif_path.parent != root:
            raise HTTPException(status_code=404, detail="GeoTIFF no encontrado en recortes/")
    else:
        raise HTTPException(status_code=400, detail="Indica path o name")

    if "_cog" in basename.lower():
        raise HTTPException(status_code=400, detail="Usa el GeoTIFF fuente, no el COG")

    meta: dict | None = None
    layer_match: RasterLayer | None = None
    layers_q = (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    )
    try:
        tif_r = tif_path.resolve()
    except OSError:
        tif_r = tif_path
    for r in layers_q:
        for attr in (r.file_path, r.cog_path):
            if not attr:
                continue
            ap = Path(attr)
            try:
                if ap.is_file() and ap.resolve() == tif_r:
                    layer_match = r
                    break
            except OSError:
                continue
        if layer_match is not None:
            break
    if layer_match is None:
        for r in layers_q:
            for attr in (r.file_path, r.cog_path):
                if attr and Path(attr).name == basename:
                    layer_match = r
                    break
            if layer_match is not None:
                break

    if layer_match is not None:
        meta = layer_match.raster_metadata or {}
    else:
        meta = {"preview_rgb_bands": [3, 2, 1], "s2_l2a_recorte": True}

    try:
        png = render_raster_preview_png(tif_path, layer_metadata=meta)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo generar la vista previa: {exc}") from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


def _canonical_index_dir_name(raw: str) -> str | None:
    """Carpeta bajo indices/ → clave estable (mismo criterio que el pipeline). Acepta cualquier capitalización."""
    u = raw.strip().upper()
    if u == "NDVI":
        return "NDVI"
    if u == "EVI":
        return "EVI"
    if u == "NDWI":
        return "NDWI"
    if u == "CIRE":
        return "CIre"
    if u == "MCARI":
        return "MCARI"
    return None


@router.get("/preprocess/index-stacks-inventory/{project_id}")
def get_index_stacks_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Lista GeoTIFF multibanda en ``indices/<INDICE>/`` (salida del pipeline de estimación, sin capas en BD)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    indices_root = _tenant_storage(tenant_id, project_id, "indices")
    if not indices_root.is_dir():
        return {"items": []}

    items: list[dict] = []
    seen_rel: set[str] = set()
    # rglob: encuentra stacks aunque la carpeta sea ndvi/NDVI o haya subcarpetas; evita depender del casing exacto.
    for p in sorted(indices_root.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        rel = _safe_relative_under(indices_root, p)
        if rel is None or rel in seen_rel:
            continue
        parts = Path(rel).parts
        if len(parts) < 2:
            continue
        key = _canonical_index_dir_name(parts[0])
        if key is None:
            continue
        seen_rel.add(rel)
        try:
            with rasterio.open(p) as src:
                bands = int(src.count)
                tags = src.tags()
        except Exception:
            continue
        dates: list[str] = []
        jd = tags.get("BAND_DATES_JSON")
        if isinstance(jd, str) and jd.strip():
            try:
                parsed = json.loads(jd)
                if isinstance(parsed, list):
                    dates = [str(x) for x in parsed]
            except json.JSONDecodeError:
                dates = []
        items.append(
            {
                "index_key": key,
                "relative_path": rel,
                "bands": bands,
                "band_dates": dates,
            }
        )
    items.sort(key=lambda x: (x["index_key"], x["relative_path"]))
    return {"items": items}


@router.get("/preprocess/index-stacks-preview/{project_id}")
def get_index_stack_preview_disk(
    project_id: int,
    stack_relpath: str | None = Query(
        None,
        alias="path",
        description="Ruta relativa bajo indices/ (p. ej. NDVI/NDVI_20240101_20241231.tif)",
    ),
    band: int | None = Query(
        None,
        ge=1,
        description="Banda (fecha) 1..N.",
    ),
    index_palette: int = Query(
        0,
        ge=0,
        le=1,
        description="1 = paleta RdYlGn (galería «Visual índices»).",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """PNG de una banda de un stack de índices en disco (no requiere RasterLayer)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if stack_relpath is None or not str(stack_relpath).strip():
        raise HTTPException(status_code=400, detail="Indica path")

    root = _tenant_storage(tenant_id, project_id, "indices").resolve()
    rel = Path(str(stack_relpath).strip().replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="Ruta relativa no válida")
    tif_path = (root / rel).resolve()
    if not tif_path.is_file() or not tif_path.is_relative_to(root):
        raise HTTPException(status_code=404, detail="Stack no encontrado")
    if "_cog" in tif_path.name.lower():
        raise HTTPException(status_code=400, detail="Usa el GeoTIFF fuente del stack")

    first_seg = rel.parts[0] if rel.parts else ""
    index_key = _canonical_index_dir_name(first_seg) or first_seg
    meta = {
        "s2_index_stack": True,
        "vegetation_index_key": index_key,
        "preview_rgb_bands": [1, 1, 1],
        "index_preview_cmap": "RdYlGn",
    }
    rgb_override = (band, band, band) if band is not None else None
    try:
        png = render_raster_preview_png(
            tif_path,
            layer_metadata=meta,
            rgb_bands_1based=rgb_override,
            index_palette_request=index_palette == 1,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo generar la vista previa: {exc}") from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


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
    fnames = payload.recorte_filenames
    if fnames is not None and len(fnames) == 0:
        fnames = None
    rids_eff = None if fnames else rids

    try:
        async_result = s2_index_stacks_pipeline.delay(
            tenant_id,
            payload.project_id,
            payload.indices,
            settings.database_url,
            rids_eff,
            fnames,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo encolar la tarea de índices. ¿Redis y worker activos? {exc!s}",
        ) from exc
    return {"status": "queued", "task_id": async_result.id}


def _sample_pixel_series_from_stacks(
    stacked: dict[str, np.ndarray],
    index_list: tuple[str, ...],
    max_pixel_series: int,
    random_seed: int,
) -> tuple[dict[str, list[list[float]]], int, int]:
    """
    Píxeles válidos en **todas** las fechas y **todos** los índices; muestreo aleatorio sin reemplazo.
    Retorna (series_by_index, n_sampled, n_valid_pixels).
    """
    first = stacked[index_list[0]]
    t, h, w = first.shape
    mask = np.ones((h, w), dtype=bool)
    for ix in index_list:
        mask &= np.isfinite(stacked[ix]).all(axis=0)
    flat_valid = np.flatnonzero(mask)
    n_valid = int(flat_valid.size)
    if n_valid == 0:
        return {ix: [] for ix in index_list}, 0, 0
    n_take = min(int(max_pixel_series), n_valid)
    rng = np.random.default_rng(int(random_seed))
    chosen = rng.choice(flat_valid, size=n_take, replace=False)
    series_by_index: dict[str, list[list[float]]] = {}
    for ix in index_list:
        vol = stacked[ix]
        lists: list[list[float]] = []
        for fk in chosen:
            r, c = np.unravel_index(int(fk), (h, w))
            lists.append(vol[:, r, c].astype(np.float64).tolist())
        series_by_index[ix] = lists
    return series_by_index, n_take, n_valid


@router.post("/preprocess/vegetation-time-series")
def preprocess_vegetation_time_series(
    payload: VegetationTimeSeriesRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Por cada escena L2A (6 bandas): índices normalizados min-max por escena, apilados en el tiempo.
    Devuelve **series por píxel** (muestreadas) y agregados por escena en ``points``.
    """
    from pathlib import Path

    from app.services.s2_vegetation_indices import (
        build_normalized_index_volumes_for_paths,
        is_six_band_s2_stack_file,
        sort_key_from_raster_layer,
    )

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    INDEX_LIST = ("NDVI", "EVI", "NDWI", "CIre", "MCARI")
    scenes: list[tuple[str, Path, int]] = []

    for rid in sorted(set(payload.raster_layer_ids)):
        r = _get_project_raster(db, tenant_id, payload.project_id, rid)
        path = Path(_existing_raster_path(r))
        meta = r.raster_metadata or {}
        if not is_six_band_s2_stack_file(path, meta):
            raise HTTPException(
                status_code=400,
                detail=f"La capa {rid} no es un recorte L2A de 6 bandas (índices sobre el mismo GeoTIFF).",
            )
        sk = sort_key_from_raster_layer(r)
        scenes.append((sk or "", path, rid))

    scenes.sort(key=lambda x: (str(x[0]), x[2]))
    paths = [p for _, p, _ in scenes]

    try:
        stacked, _ref = build_normalized_index_volumes_for_paths(paths, INDEX_LIST)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudieron alinear índices en el tiempo: {exc!s}") from exc

    points: list[dict] = []
    for t, (date, _path, rid) in enumerate(scenes):
        row: dict = {"date": date, "raster_layer_id": rid, "by_index": {}}
        for ix in INDEX_LIST:
            plane = stacked[ix][t]
            fin = plane[np.isfinite(plane)]
            if fin.size == 0:
                row["by_index"][ix] = {
                    "mean": None,
                    "std": None,
                    "n_pixels": 0,
                    "n_pixels_raw": 0,
                }
            else:
                npx = int(fin.size)
                row["by_index"][ix] = {
                    "mean": float(np.nanmean(plane)),
                    "std": float(np.nanstd(plane)),
                    "n_pixels": npx,
                    "n_pixels_raw": npx,
                }
        points.append(row)

    temporal_stats: dict = {}
    for ix in INDEX_LIST:
        vals = [p["by_index"][ix]["mean"] for p in points if p["by_index"][ix]["mean"] is not None]
        if not vals:
            temporal_stats[ix] = {"mean": None, "std": None}
        else:
            a = np.array(vals, dtype=np.float64)
            temporal_stats[ix] = {
                "mean": float(np.mean(a)),
                "std": float(np.std(a, ddof=1)) if len(vals) > 1 else 0.0,
            }

    series_by_index, n_sampled, n_valid = _sample_pixel_series_from_stacks(
        stacked,
        INDEX_LIST,
        payload.max_pixel_series,
        payload.random_seed,
    )

    return {
        "project_id": payload.project_id,
        "dates": [d for d, _, _ in scenes],
        "indices": list(INDEX_LIST),
        "points": points,
        "temporal_stats": temporal_stats,
        "spatial_aggregation": {
            "method": "all_valid_pixels",
            "description": (
                "Índice por escena normalizado min-max en toda la imagen; series por píxel en valores [0,1]. "
                "Muestreo aleatorio de píxeles válidos en todas las fechas."
            ),
        },
        "per_pixel": {
            "n_sampled": n_sampled,
            "n_valid_pixels": n_valid,
            "max_requested": payload.max_pixel_series,
            "random_seed": payload.random_seed,
            "series_by_index": series_by_index,
        },
    }


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


@router.post("/preprocess/sentinel1-recortes")
def preprocess_sentinel1_recortes(
    payload: S1GrdRecorteRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Por cada producto Sentinel-1 (.SAFE o .zip bajo ``Sentinel1/``): apila VV+VH, recorta al polígono
    (subset espacial equivalente a SNAP Raster/Subset/Polygon) y guarda GeoTIFF en ``recortes/S1/``.
    """
    from app.tasks.jobs import s1_grd_recortes_pipeline

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

    paths = [str(x).strip().replace("\\", "/") for x in (payload.product_paths or []) if str(x).strip()]
    if not paths:
        raise HTTPException(status_code=400, detail="Indica al menos un producto (ruta bajo Sentinel1/).")

    try:
        async_result = s1_grd_recortes_pipeline.delay(
            tenant_id,
            payload.project_id,
            project.name,
            payload.layer_id,
            settings.database_url,
            paths,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "No se pudo encolar el recorte Sentinel-1. Comprueba Redis y el worker Celery. "
                f"Detalle: {exc!s}"
            ),
        ) from exc
    return {"status": "queued", "task_id": async_result.id}


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
            payload.product_names,
            payload.source_subpath,
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
