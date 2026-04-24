import json
import io
import logging
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
import rasterio
from PIL import Image
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sklearn.cluster import KMeans
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
from app.services.preprocess_pipeline_variant import (
    indices_dir_name,
    is_planetscope_ps_recorte_filename,
    normalize_pipeline_variant,
    recortes_dir_name,
)
from app.services.ps_spatiotemporal_cluster import (
    cluster_map_to_png,
    get_preset,
    load_meta,
    run_ps_spatiotemporal_cluster,
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
    RoiSelectionNormalized,
    S1GrdRecorteRequest,
    S1SarIndexStacksRequest,
    S1SarTimeSeriesRequest,
    PsPlanetZipExtractRequest,
    PsSpatiotemporalClusterRequest,
    S2IndexStacksRequest,
    S2L2aRecorteRequest,
    StackRequest,
    VegetationTimeSeriesRequest,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _pipeline_variant_query(pipeline_variant: str = Query("s2", description='s2 → recortes/indices; ps → recortesPS/indecesPS')) -> str:
    return normalize_pipeline_variant(pipeline_variant)


def _norm_iso_date(raw: str) -> str:
    s = str(raw or "").strip()
    return s[:10] if len(s) >= 10 else s


def _collect_dates_from_index_stacks(tenant_id: int, project_id: int, pipeline_variant: str) -> list[str]:
    """Fechas únicas YYYY-MM-DD desde BAND_DATES_JSON en stacks bajo indices/ o indecesPS/."""
    root = _tenant_storage(tenant_id, project_id, indices_dir_name(pipeline_variant))
    if not root.is_dir():
        return []
    dates: set[str] = set()
    for p in root.rglob("*.tif"):
        if "_cog" in p.name.lower() or not p.is_file():
            continue
        rel = _safe_relative_under(root, p)
        if rel is None:
            continue
        parts = Path(rel).parts
        if len(parts) < 2:
            continue
        if _canonical_index_dir_name(parts[0]) is None:
            continue
        try:
            with rasterio.open(p) as src:
                tags = src.tags()
        except Exception:
            continue
        jd = tags.get("BAND_DATES_JSON")
        if not isinstance(jd, str) or not jd.strip():
            continue
        try:
            arr = json.loads(jd)
        except json.JSONDecodeError:
            continue
        if not isinstance(arr, list):
            continue
        for d in arr:
            nd = _norm_iso_date(str(d))
            if re.match(r"^\d{4}-\d{2}-\d{2}$", nd):
                dates.add(nd)
    return sorted(dates)


def _collect_dates_from_s1_sar_stacks(tenant_id: int, project_id: int) -> list[str]:
    """Fechas únicas YYYY-MM-DD desde BAND_DATES_JSON en stacks SAR bajo s1indices/."""
    from app.services.s1_sar_indices import S1_SAR_STACKS_ROOT_NAME

    root = _tenant_storage(tenant_id, project_id, S1_SAR_STACKS_ROOT_NAME)
    if not root.is_dir():
        return []
    dates: set[str] = set()
    for p in root.rglob("*.tif"):
        if "_cog" in p.name.lower() or not p.is_file():
            continue
        rel = _safe_relative_under(root, p)
        if rel is None:
            continue
        parts = Path(rel).parts
        if len(parts) < 2:
            continue
        if _canonical_s1_sar_index_dir_name(parts[0]) is None:
            continue
        try:
            with rasterio.open(p) as src:
                tags = src.tags()
        except Exception:
            continue
        jd = tags.get("BAND_DATES_JSON")
        if not isinstance(jd, str) or not jd.strip():
            continue
        try:
            arr = json.loads(jd)
        except json.JSONDecodeError:
            continue
        if not isinstance(arr, list):
            continue
        for d in arr:
            nd = _norm_iso_date(str(d))
            if re.match(r"^\d{4}-\d{2}-\d{2}$", nd):
                dates.add(nd)
    return sorted(dates)


def _open_meteo_daily(lat: float, lon: float, start_date: str, end_date: str) -> list[dict]:
    """Serie diaria (Open-Meteo archive) en unidades nativas."""
    params = {
        "latitude": f"{lat:.8f}",
        "longitude": f"{lon:.8f}",
        "start_date": start_date,
        "end_date": end_date,
        "timezone": "auto",
        "daily": "temperature_2m_mean,relative_humidity_2m_mean,precipitation_sum,shortwave_radiation_sum",
    }
    url = f"https://archive-api.open-meteo.com/v1/archive?{urlencode(params)}"
    try:
        with urlopen(url, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo consultar Open-Meteo: {exc!s}") from exc

    daily = payload.get("daily") or {}
    times = daily.get("time") or []
    t2m = daily.get("temperature_2m_mean") or []
    rh = daily.get("relative_humidity_2m_mean") or []
    pr = daily.get("precipitation_sum") or []
    sw = daily.get("shortwave_radiation_sum") or []
    n = min(len(times), len(t2m), len(rh), len(pr), len(sw))
    out: list[dict] = []
    for i in range(n):
        d = _norm_iso_date(times[i])
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            continue
        out.append(
            {
                "date": d,
                "temp": float(t2m[i]) if t2m[i] is not None else None,
                "humidity": float(rh[i]) if rh[i] is not None else None,
                "precip": float(pr[i]) if pr[i] is not None else None,
                "radiation": float(sw[i]) if sw[i] is not None else None,
            }
        )
    return out


def _monthly_means_from_daily(rows: list[dict]) -> dict[str, dict]:
    buckets: dict[str, dict[str, list[float]]] = {}
    for r in rows:
        m = str(r.get("date") or "")[:7]
        if not re.match(r"^\d{4}-\d{2}$", m):
            continue
        b = buckets.setdefault(m, {"precip": [], "temp": [], "humidity": [], "radiation": []})
        for k in ("precip", "temp", "humidity", "radiation"):
            v = r.get(k)
            if v is None or not np.isfinite(v):
                continue
            b[k].append(float(v))
    out: dict[str, dict] = {}
    for m, b in buckets.items():
        out[m] = {
            "precip": float(np.mean(b["precip"])) if b["precip"] else None,
            "temp": float(np.mean(b["temp"])) if b["temp"] else None,
            "humidity": float(np.mean(b["humidity"])) if b["humidity"] else None,
            "radiation": float(np.mean(b["radiation"])) if b["radiation"] else None,
        }
    return out


def _series_from_scene_dates(scene_dates: list[str], monthly_means: dict[str, dict]) -> list[dict]:
    out: list[dict] = []
    for d in scene_dates:
        nd = _norm_iso_date(d)
        month = nd[:7]
        row = monthly_means.get(month) or {}
        out.append(
            {
                "date": nd,
                "month": month,
                "precip": row.get("precip"),
                "temp": row.get("temp"),
                "humidity": row.get("humidity"),
                "radiation": row.get("radiation"),
            }
        )
    return out


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


# Fecha de adquisición en nombres GRD IW: ...S1A_IW_GRDH_1SDV_20250111T102623...
_S1_IW_GRDH_SCENE_DATE = re.compile(r"S1[A-Z]_IW_GRDH_1SDV_(\d{8})T", re.IGNORECASE)

# Nombre de colormap matplotlib (clave API → nombre en colormaps)
_S1_PREP_VV_PREVIEW_PALETTES: dict[str, str] = {
    "spectral": "Spectral",
    "jet": "jet",
    "turbo": "turbo",
}

# ENVI/SNAP sigma0 en dB bajo s1prepoceso/
_S1_PREP_SIGMA0_IMG: dict[str, str] = {
    "vv": "Sigma0_VV_db.img",
    "vh": "Sigma0_VH_db.img",
}


def _s1_prepoceso_sort_key_from_path(path: Path) -> str:
    """Clave YYYY-MM-DD para ordenar; prioriza la fecha en el nombre de carpeta GRD."""
    text = "/".join(path.parts)
    m = _S1_IW_GRDH_SCENE_DATE.search(text)
    if m:
        ymd = m.group(1)
        return f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()
    except OSError:
        return "1900-01-01"


@router.get("/preprocess/s1-prepoceso-sigma0-vv-inventory/{project_id}")
def get_s1_prepoceso_sigma0_vv_inventory(
    project_id: int,
    pol: str = Query(
        "vv",
        description="Polarización: vv → Sigma0_VV_db.img, vh → Sigma0_VH_db.img",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Lista ``Sigma0_VV_db.img`` o ``Sigma0_VH_db.img`` bajo ``s1prepoceso/`` (SNAP/ENVI).
    ``sort_key`` en formato ISO (YYYY-MM-DD) extraído de ``..._S1?_IW_GRDH_1SDV_YYYYMMDDTh...`` en la ruta.
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    p = str(pol or "vv").strip().lower()
    if p not in _S1_PREP_SIGMA0_IMG:
        raise HTTPException(status_code=400, detail="pol debe ser vv o vh")
    basename = _S1_PREP_SIGMA0_IMG[p]

    root = _tenant_storage(tenant_id, project_id, "s1prepoceso")
    if not root.is_dir():
        return {"items": [], "root_exists": False, "pol": p}

    items: list[dict] = []
    for path in sorted(root.rglob(basename)):
        if not path.is_file() or path.name != basename:
            continue
        rel = _safe_relative_under(root, path)
        if rel is None:
            continue
        sk = _s1_prepoceso_sort_key_from_path(path)
        items.append(
            {
                "basename": path.name,
                "relative_path": rel,
                "sort_key": sk,
            }
        )
    items.sort(key=lambda x: (x["sort_key"], x["relative_path"]))
    return {"items": items, "root_exists": True, "pol": p}


@router.get("/preprocess/s1-prepoceso-sigma0-vv-preview/{project_id}")
def get_s1_prepoceso_sigma0_vv_preview(
    project_id: int,
    img_relpath: str | None = Query(
        None,
        alias="path",
        description="Ruta relativa dentro de s1prepoceso/ hasta Sigma0_VV_db.img o Sigma0_VH_db.img",
    ),
    pol: str = Query(
        "vv",
        description="Debe coincidir con el archivo: vv → Sigma0_VV_db.img, vh → Sigma0_VH_db.img",
    ),
    palette: str = Query(
        "spectral",
        description="Paleta tipo JET/Spectral (matplotlib): spectral | jet | turbo",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """PNG de una banda (sigma0 VV o VH en dB) desde ENVI en ``s1prepoceso/`` (paleta científica)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    p = str(pol or "vv").strip().lower()
    if p not in _S1_PREP_SIGMA0_IMG:
        raise HTTPException(status_code=400, detail="pol debe ser vv o vh")
    expected_name = _S1_PREP_SIGMA0_IMG[p]

    if img_relpath is None or not str(img_relpath).strip():
        raise HTTPException(status_code=400, detail="Indica path")

    root = _tenant_storage(tenant_id, project_id, "s1prepoceso").resolve()
    rel = Path(str(img_relpath).strip().replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="Ruta relativa no válida")
    img_path = (root / rel).resolve()
    if not img_path.is_file() or not img_path.is_relative_to(root):
        raise HTTPException(status_code=404, detail=f"{expected_name} no encontrado")
    if img_path.name != expected_name:
        raise HTTPException(
            status_code=400,
            detail=f"El archivo debe ser {expected_name} para pol={p}",
        )

    cmap_key = _S1_PREP_VV_PREVIEW_PALETTES.get(str(palette or "spectral").strip().lower())
    if cmap_key is None:
        allowed = ", ".join(sorted(_S1_PREP_VV_PREVIEW_PALETTES))
        raise HTTPException(status_code=400, detail=f"palette inválida; use: {allowed}")

    meta = {"preview_rgb_bands": [1, 1, 1], "index_preview_cmap": cmap_key}
    try:
        png = render_raster_preview_png(
            img_path,
            layer_metadata=meta,
            index_palette_request=True,
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


@router.get("/preprocess/s1-prepoceso-sar-scenes-inventory/{project_id}")
def get_s1_prep_sar_scenes_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Escenas con par ``Sigma0_VV_db.img`` + ``Sigma0_VH_db.img`` en ``s1prepoceso/`` (misma carpeta ``.data``).
    Orden cronológico por fecha GRD en la ruta.
    """
    from app.services.s1_sar_indices import discover_s1_prep_sar_scenes

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _tenant_storage(tenant_id, project_id, "s1prepoceso")
    items = discover_s1_prep_sar_scenes(tenant_id, project_id)
    return {"items": items, "root_exists": root.is_dir()}


@router.post("/preprocess/s1-sar-index-stacks")
def preprocess_s1_sar_index_stacks(
    payload: S1SarIndexStacksRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Encola generación de stacks multibanda (una banda por escena, orden cronológico) por cada índice SAR.
    Salida **solo** en ``s1indices/<INDICE>/`` del proyecto (no usa ``indices/`` de Sentinel-2).
    """
    from app.tasks.jobs import s1_sar_index_stacks_pipeline

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    paths = [str(p).strip().replace("\\", "/") for p in payload.scene_vv_relpaths if str(p).strip()]
    paths = list(dict.fromkeys(paths))
    if not paths:
        raise HTTPException(status_code=400, detail="Indica al menos una escena (ruta a Sigma0_VV_db.img)")

    try:
        async_result = s1_sar_index_stacks_pipeline.delay(
            tenant_id,
            payload.project_id,
            payload.indices,
            paths,
            settings.database_url,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo encolar la tarea de índices SAR. ¿Redis y worker activos? {exc!s}",
        ) from exc
    return {"status": "queued", "task_id": async_result.id}


@router.get("/preprocess/recortes-inventory/{project_id}")
def get_recortes_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_pipeline_variant_query),
):
    """
    Lista GeoTIFF bajo ``recortes/`` o ``recortesPS/`` (incl. subcarpetas) con ≥6 bandas, sin depender de capas en BD.
    ``relative_path`` identifica el archivo para preview y tareas; ``basename`` es solo el nombre final.
    ``raster_layer_id`` si una capa apunta al mismo path resuelto, al mismo basename, o a ``metadata.source_name`` con ese basename (p. ej. TIF en ``rasters/`` copiado desde ``recortesPS/``).
    """
    from app.services.s2_vegetation_indices import sort_key_from_path_or_meta

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    rec_kind = recortes_dir_name(pipeline_variant)
    recortes_root = _tenant_storage(tenant_id, project_id, rec_kind)
    if not recortes_root.is_dir():
        return {"items": [], "recortes_dir": rec_kind, "pipeline_variant": normalize_pipeline_variant(pipeline_variant)}

    resolved_to_rid: dict[Path, int] = {}
    name_to_rid: dict[str, int] = {}
    # Capa en ``rasters/`` suele tener otro path que el TIF en ``recortesPS/``; enlazar por ``source_name`` original.
    source_basename_to_rid: dict[str, int] = {}
    for r in (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    ):
        om = r.raster_metadata or {}
        sn = (om.get("source_name") or "").strip()
        if sn:
            sb = Path(sn).name
            if sb.lower().endswith(".tif") and "_cog" not in sb.lower():
                source_basename_to_rid.setdefault(sb, r.id)
        nm = (r.name or "").strip()
        if nm and is_planetscope_ps_recorte_filename(nm):
            source_basename_to_rid.setdefault(Path(nm).name, r.id)
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

    pv = normalize_pipeline_variant(pipeline_variant)
    items: list[dict] = []
    for p in sorted(recortes_root.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        if pv == "ps" and not is_planetscope_ps_recorte_filename(p.name):
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
        if rid is None:
            rid = source_basename_to_rid.get(p.name)
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
    return {
        "items": items,
        "recortes_dir": rec_kind,
        "pipeline_variant": normalize_pipeline_variant(pipeline_variant),
    }


def _load_soilplus_dem_band1(project_id: int, tenant_id: int) -> tuple[Path, np.ndarray, np.ndarray]:
    dem_path = _tenant_storage(tenant_id, project_id, "dem") / "band_1.img"
    if not dem_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"No existe imagen DEM de entrada para Soil+: {dem_path}",
        )
    try:
        with rasterio.open(dem_path) as src:
            arr = src.read(1).astype(np.float64)
            nd = src.nodatavals[0] if src.nodatavals else None
            if nd is not None and np.isfinite(nd):
                arr = np.where(arr == float(nd), np.nan, arr)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo leer DEM de entrada: {exc}") from exc
    arr = np.where(np.isfinite(arr), arr, np.nan)
    arr = np.where(arr < 0, 0.0, arr)
    mask = np.isfinite(arr) & (arr > 0)
    if int(np.count_nonzero(mask)) <= 0:
        raise HTTPException(status_code=400, detail="DEM sin píxeles válidos (>0).")
    return dem_path, arr, mask


def _soilplus_box_sum(arr2d: np.ndarray, radius: int) -> np.ndarray:
    pad = np.pad(arr2d, ((radius, radius), (radius, radius)), mode="constant", constant_values=0.0)
    integ = np.pad(pad, ((1, 0), (1, 0)), mode="constant", constant_values=0.0).cumsum(axis=0).cumsum(axis=1)
    k = 2 * radius + 1
    return integ[k:, k:] - integ[:-k, k:] - integ[k:, :-k] + integ[:-k, :-k]


def _soilplus_compute_cv(arr: np.ndarray, mask: np.ndarray, window_size: int) -> tuple[np.ndarray, np.ndarray, int]:
    ws = int(window_size)
    if ws % 2 == 0:
        ws += 1
    r = ws // 2
    valid = np.isfinite(arr)
    filled = np.where(valid, arr, 0.0)
    sum_w = _soilplus_box_sum(filled, r)
    cnt_w = _soilplus_box_sum(valid.astype(np.float64), r)
    sumsq_w = _soilplus_box_sum(filled * filled, r)
    mean_w = np.divide(sum_w, cnt_w, out=np.zeros_like(sum_w), where=cnt_w > 0)
    var_w = np.divide(sumsq_w, cnt_w, out=np.zeros_like(sumsq_w), where=cnt_w > 0) - (mean_w * mean_w)
    var_w = np.maximum(var_w, 0.0)
    std_w = np.sqrt(var_w)
    cv_w = np.divide(std_w, mean_w, out=np.zeros_like(std_w), where=mean_w > 1e-9)
    cv_w = np.where(mask, cv_w, np.nan)
    return cv_w, cv_w[mask], ws


def _soilplus_png_from_array(arr: np.ndarray, mask: np.ndarray) -> bytes:
    vals = arr[mask]
    if vals.size <= 0:
        raise HTTPException(status_code=400, detail="No hay píxeles válidos para render.")
    lo = float(np.nanmin(vals))
    hi = float(np.nanmax(vals))
    den = max(hi - lo, 1e-12)
    norm = np.clip((arr - lo) / den, 0.0, 1.0)
    u8 = np.where(mask, (norm * 255.0).astype(np.uint8), 0)
    rgb = np.stack([u8, u8, u8], axis=-1)
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _soilplus_cluster_png(labels: np.ndarray, mask: np.ndarray, n_clusters: int) -> bytes:
    palette = np.array(
        [
            [228, 26, 28],
            [55, 126, 184],
            [77, 175, 74],
            [152, 78, 163],
            [255, 127, 0],
            [255, 255, 51],
            [166, 86, 40],
            [247, 129, 191],
            [141, 211, 199],
            [179, 222, 105],
            [128, 177, 211],
            [253, 180, 98],
        ],
        dtype=np.uint8,
    )
    rgb = np.zeros((labels.shape[0], labels.shape[1], 3), dtype=np.uint8)
    rgb[:] = (255, 255, 255)
    valid_labels = np.where(mask, labels, -1)
    for k in range(int(n_clusters)):
        color = palette[k % len(palette)]
        rgb[valid_labels == k] = color
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@router.get("/preprocess/ps-soilplus-f1/{project_id}")
def get_ps_soilplus_f1_exact(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Calcula f1 exacto para Soil+ desde PlanetScope real:
    media global de la banda 8 en todos los GeoTIFF válidos de ``recortesPS/``.
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    rec_root = _tenant_storage(tenant_id, project_id, recortes_dir_name("ps"))
    if not rec_root.is_dir():
        raise HTTPException(status_code=404, detail="No existe recortesPS/ para este proyecto.")

    total_sum = 0.0
    total_count = 0
    used_files = 0
    skipped_non_ps_name = 0
    skipped_not_8band = 0
    skipped_open_error = 0

    for p in sorted(rec_root.rglob("*.tif")):
        if "_cog" in p.name.lower() or not p.is_file():
            continue
        if not is_planetscope_ps_recorte_filename(p.name):
            skipped_non_ps_name += 1
            continue
        try:
            with rasterio.open(p) as src:
                if int(src.count) < 8:
                    skipped_not_8band += 1
                    continue
                band8 = src.read(8).astype(np.float64)
                nd = src.nodatavals[7] if src.nodatavals and len(src.nodatavals) >= 8 else None
                if nd is not None and np.isfinite(nd):
                    band8 = np.where(band8 == float(nd), np.nan, band8)
                band8 = np.where(np.isfinite(band8), band8, np.nan)
                valid = np.isfinite(band8)
                n_valid = int(np.count_nonzero(valid))
                if n_valid <= 0:
                    continue
                total_sum += float(np.nansum(band8))
                total_count += n_valid
                used_files += 1
        except Exception:
            skipped_open_error += 1
            continue

    if total_count <= 0:
        raise HTTPException(
            status_code=404,
            detail="No se encontraron píxeles válidos de banda 8 en recortesPS/.",
        )

    return {
        "project_id": int(project_id),
        "f1_band8_mean": total_sum / total_count,
        "valid_pixel_count": total_count,
        "files_used": used_files,
        "files_skipped": {
            "non_ps_filename": skipped_non_ps_name,
            "less_than_8_bands": skipped_not_8band,
            "open_error": skipped_open_error,
        },
        "source_dir": "recortesPS",
        "method": "global_mean_of_band_8_across_all_valid_pixels",
    }


@router.get("/preprocess/soilplus-dem-input/{project_id}")
def get_soilplus_dem_input_stats(
    project_id: int,
    window_size: int = Query(13, ge=3, le=101, description="Tamaño de ventana para métrica CV local (impar recomendado)."),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Fuente de entrada fija para Soil+:
    data/storage/tenant_{tenant}/project_{project}/dem/band_1.img
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        dem_path, arr, mask = _load_soilplus_dem_band1(project_id, tenant_id)
        n_valid = int(np.count_nonzero(mask))
        vals = arr[mask]
        cv_w, cv_vals, ws = _soilplus_compute_cv(arr, mask, window_size)
        return {
            "project_id": int(project_id),
            "input_image_path": str(dem_path),
            "window_size": ws,
            "width": int(arr.shape[1]),
            "height": int(arr.shape[0]),
            "valid_pixel_count": n_valid,
            "dem_mean": float(np.mean(vals)),
            "dem_std": float(np.std(vals)),
            "dem_min": float(np.min(vals)),
            "dem_max": float(np.max(vals)),
            "cv_mean": float(np.mean(cv_vals)) if cv_vals.size else 0.0,
            "cv_var": float(np.var(cv_vals)) if cv_vals.size else 0.0,
            "method": "band1_dem_values_cleaned_negatives_to_zero_mask_gt_zero",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo leer DEM de entrada: {exc}") from exc


@router.get("/preprocess/soilplus-dem-preview/{project_id}")
def get_soilplus_dem_preview(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    dem_path, arr, mask = _load_soilplus_dem_band1(project_id, tenant_id)
    _ = dem_path
    png = _soilplus_png_from_array(arr, mask)
    return Response(content=png, media_type="image/png")


@router.get("/preprocess/soilplus-cv-preview/{project_id}")
def get_soilplus_cv_preview(
    project_id: int,
    window_size: int = Query(13, ge=3, le=101),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _, arr, mask = _load_soilplus_dem_band1(project_id, tenant_id)
    cv_w, _, _ws = _soilplus_compute_cv(arr, mask, window_size)
    png = _soilplus_png_from_array(cv_w, mask)
    return Response(content=png, media_type="image/png")


@router.get("/preprocess/soilplus-elbow/{project_id}")
def get_soilplus_elbow(
    project_id: int,
    k_min: int = Query(2, ge=2, le=20),
    k_max: int = Query(10, ge=2, le=30),
    sample_max: int = Query(20000, ge=2000, le=120000),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if k_max < k_min:
        raise HTTPException(status_code=400, detail="k_max debe ser >= k_min")
    _, arr, mask = _load_soilplus_dem_band1(project_id, tenant_id)
    x = arr[mask].reshape(-1, 1).astype(np.float64)
    n = x.shape[0]
    if n > sample_max:
        rng = np.random.default_rng(42)
        idx = rng.choice(n, size=int(sample_max), replace=False)
        x = x[idx]
    ks: list[int] = []
    wcss: list[float] = []
    for k in range(int(k_min), int(k_max) + 1):
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        km.fit(x)
        ks.append(k)
        wcss.append(float(km.inertia_))
    # heurística simple de codo: máxima distancia a recta (primer-último punto)
    elbow_k = ks[0]
    if len(ks) >= 3:
        x0, y0 = ks[0], wcss[0]
        x1, y1 = ks[-1], wcss[-1]
        den = ((y1 - y0) ** 2 + (x1 - x0) ** 2) ** 0.5
        if den > 0:
            dmax = -1.0
            for k, y in zip(ks[1:-1], wcss[1:-1]):
                d = abs((y1 - y0) * k - (x1 - x0) * y + x1 * y0 - y1 * x0) / den
                if d > dmax:
                    dmax = d
                    elbow_k = k
    return {
        "project_id": int(project_id),
        "source": "dem/band_1.img",
        "ks": ks,
        "wcss": wcss,
        "elbow_k": elbow_k,
        "sample_size": int(x.shape[0]),
    }


@router.get("/preprocess/soilplus-cluster-preview/{project_id}")
def get_soilplus_cluster_preview(
    project_id: int,
    n_clusters: int = Query(4, ge=2, le=30),
    sample_max: int = Query(20000, ge=2000, le=120000),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    _, arr, mask = _load_soilplus_dem_band1(project_id, tenant_id)
    x = arr[mask].reshape(-1, 1).astype(np.float64)
    n = x.shape[0]
    if n > sample_max:
        rng = np.random.default_rng(42)
        idx = rng.choice(n, size=int(sample_max), replace=False)
        x_fit = x[idx]
    else:
        x_fit = x
    km = KMeans(n_clusters=int(n_clusters), random_state=42, n_init=10)
    km.fit(x_fit)
    # Etiquetar todos los píxeles válidos con el modelo ajustado.
    all_labels = km.predict(x).astype(np.int16)
    lab_map = np.full(arr.shape, -1, dtype=np.int16)
    lab_map[mask] = all_labels
    png = _soilplus_cluster_png(lab_map, mask, int(n_clusters))
    return Response(content=png, media_type="image/png")


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
    pipeline_variant: str = Depends(_pipeline_variant_query),
):
    """Vista RGB desde GeoTIFF en ``recortes/`` o ``recortesPS/``: S2 típico B04,B03,B02 → 3,2,1; Planet PS (≥6 bandas) → 6,4,2."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _tenant_storage(tenant_id, project_id, recortes_dir_name(pipeline_variant)).resolve()

    tif_path: Path
    basename: str
    if recorte_relpath is not None and str(recorte_relpath).strip():
        rel = Path(str(recorte_relpath).strip().replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts:
            raise HTTPException(status_code=400, detail="Ruta relativa no válida")
        full_path = (root / rel).resolve()
        if not full_path.is_file() or not full_path.is_relative_to(root):
            raise HTTPException(status_code=404, detail="GeoTIFF no encontrado en la carpeta de recortes del variant")
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
            raise HTTPException(status_code=404, detail="GeoTIFF no encontrado en la carpeta de recortes del variant")
    else:
        raise HTTPException(status_code=400, detail="Indica path o name")

    if "_cog" in basename.lower():
        raise HTTPException(status_code=400, detail="Usa el GeoTIFF fuente, no el COG")

    if normalize_pipeline_variant(pipeline_variant) == "ps" and not is_planetscope_ps_recorte_filename(basename):
        raise HTTPException(
            status_code=400,
            detail="Solo se admiten GeoTIFF con nombre PS_dd-mm-yy.tif (p. ej. PS_23-03-26.tif).",
        )

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
    # COG en ``rasters/`` suele tener otro nombre; enlazar por ``source_name`` o nombre de capa PS_*.tif.
    if layer_match is None:
        for r in layers_q:
            om = r.raster_metadata or {}
            sn = (om.get("source_name") or "").strip()
            if sn and Path(sn).name == basename:
                layer_match = r
                break
    if layer_match is None:
        for r in layers_q:
            nm = (r.name or "").strip()
            if nm and Path(nm).name == basename and is_planetscope_ps_recorte_filename(nm):
                layer_match = r
                break

    if layer_match is not None:
        meta = layer_match.raster_metadata or {}
    else:
        meta = {"preview_rgb_bands": [3, 2, 1], "s2_l2a_recorte": True}

    render_path = tif_path
    if normalize_pipeline_variant(pipeline_variant) == "ps":
        if layer_match is not None:
            try:
                rp = _existing_raster_path(layer_match)
                if rp.is_file():
                    render_path = rp
            except HTTPException:
                pass
        try:
            with rasterio.open(render_path) as _chk:
                n_ps = int(_chk.count)
        except Exception:
            n_ps = 0
        if n_ps >= 6:
            # Metadatos mínimos (evita ``s2_index_stack`` u otros flags heredados que alteran la RGB).
            # Mismo archivo que el mapa cuando hay capa: COG en ``rasters/`` vía ``_existing_raster_path``.
            meta = {
                "preview_rgb_bands": [6, 4, 2],
                "planetscope_composite": True,
                "source_name": basename,
            }

    try:
        png = render_raster_preview_png(render_path, layer_metadata=meta)
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


_S1_SAR_INDEX_DIR_KEYS = frozenset({"RVI", "RFDI", "VV_VH", "VH_VV", "NRPB"})


def _canonical_s1_sar_index_dir_name(raw: str) -> str | None:
    """Carpeta bajo s1indices/ (índices SAR). Acepta capitalización distinta."""
    u = raw.strip().upper().replace("/", "_")
    return u if u in _S1_SAR_INDEX_DIR_KEYS else None


# Carpetas bajo indices/ (S2) o indecesPS/ (Planet); debe coincidir con normalize_requested_indices.
_PS_INDEX_DIR_NAMES = frozenset({"MSAVI2", "MTVI2", "VARI", "TGI", "KNDVI", "GIYI"})


def _canonical_index_dir_name(raw: str) -> str | None:
    """Carpeta bajo indices/ o indecesPS/ → clave estable (mismo criterio que el pipeline)."""
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
    if u == "NDRE":
        return "NDRE"
    if u == "RSTRUCTURE":
        return "RSTRUCTURE"
    if u in _PS_INDEX_DIR_NAMES:
        return u
    return None


@router.get("/preprocess/index-stacks-inventory/{project_id}")
def get_index_stacks_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_pipeline_variant_query),
):
    """Lista GeoTIFF multibanda en ``indices/`` o ``indecesPS/`` (salida del pipeline de estimación, sin capas en BD)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    idx_kind = indices_dir_name(pipeline_variant)
    indices_root = _tenant_storage(tenant_id, project_id, idx_kind)
    if not indices_root.is_dir():
        return {"items": [], "indices_dir": idx_kind, "pipeline_variant": normalize_pipeline_variant(pipeline_variant)}

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
    return {
        "items": items,
        "indices_dir": idx_kind,
        "pipeline_variant": normalize_pipeline_variant(pipeline_variant),
    }


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
    pipeline_variant: str = Depends(_pipeline_variant_query),
):
    """PNG de una banda de un stack de índices en disco (no requiere RasterLayer)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if stack_relpath is None or not str(stack_relpath).strip():
        raise HTTPException(status_code=400, detail="Indica path")

    root = _tenant_storage(tenant_id, project_id, indices_dir_name(pipeline_variant)).resolve()
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


@router.get("/preprocess/s1-sar-index-stacks-inventory/{project_id}")
def get_s1_sar_index_stacks_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Lista GeoTIFF multibanda en ``s1indices/<INDICE>/`` (stacks SAR por escena)."""
    from app.services.s1_sar_indices import S1_SAR_STACKS_ROOT_NAME

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    root = _tenant_storage(tenant_id, project_id, S1_SAR_STACKS_ROOT_NAME)
    if not root.is_dir():
        return {"items": []}

    items: list[dict] = []
    seen_rel: set[str] = set()
    for p in sorted(root.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        rel = _safe_relative_under(root, p)
        if rel is None or rel in seen_rel:
            continue
        parts = Path(rel).parts
        if len(parts) < 2:
            continue
        key = _canonical_s1_sar_index_dir_name(parts[0])
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


@router.get("/preprocess/s1-sar-index-stacks-preview/{project_id}")
def get_s1_sar_index_stack_preview_disk(
    project_id: int,
    stack_relpath: str | None = Query(
        None,
        alias="path",
        description="Ruta relativa bajo s1indices/ (p. ej. RVI/RVI_20250111_20251225.tif)",
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
        description="1 = paleta RdYlGn (galería «Visual índices SAR»).",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """PNG de una banda de un stack de índices SAR en ``s1indices/``."""
    from app.services.s1_sar_indices import S1_SAR_STACKS_ROOT_NAME

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if stack_relpath is None or not str(stack_relpath).strip():
        raise HTTPException(status_code=400, detail="Indica path")

    root = _tenant_storage(tenant_id, project_id, S1_SAR_STACKS_ROOT_NAME).resolve()
    rel = Path(str(stack_relpath).strip().replace("\\", "/"))
    if rel.is_absolute() or ".." in rel.parts:
        raise HTTPException(status_code=400, detail="Ruta relativa no válida")
    tif_path = (root / rel).resolve()
    if not tif_path.is_file() or not tif_path.is_relative_to(root):
        raise HTTPException(status_code=404, detail="Stack SAR no encontrado")
    if "_cog" in tif_path.name.lower():
        raise HTTPException(status_code=400, detail="Usa el GeoTIFF fuente del stack")

    first_seg = rel.parts[0] if rel.parts else ""
    index_key = _canonical_s1_sar_index_dir_name(first_seg) or first_seg
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
    Genera stacks multibanda (una banda por escena/fecha) por índice en ``indices/<INDICE>/`` o ``indecesPS/``.
    Requiere GeoTIFF de recorte L2A de 6 bandas en ``recortes/`` o ``recortesPS/``.
    """
    from app.services.s2_vegetation_indices import normalize_requested_indices
    from app.tasks.jobs import s2_index_stacks_pipeline

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    pairs = normalize_requested_indices(
        payload.indices, pipeline_variant=normalize_pipeline_variant(payload.pipeline_variant)
    )
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
            normalize_pipeline_variant(payload.pipeline_variant),
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
    roi_selection: RoiSelectionNormalized | None = None,
) -> tuple[dict[str, list[list[float]]], int, int]:
    """
    Píxeles válidos en **todas** las fechas y **todos** los índices; muestreo aleatorio sin reemplazo.
    Retorna (series_by_index, n_sampled, n_valid_pixels).
    """
    first = stacked[index_list[0]]
    t, h, w = first.shape
    mask = np.ones((h, w), dtype=bool)
    if roi_selection is not None:
        mask &= _roi_mask_from_selection(roi_selection, h, w)
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


def _roi_mask_for_polygon(points: list, h: int, w: int) -> np.ndarray:
    if len(points) < 3:
        return np.zeros((h, w), dtype=bool)
    px = np.array([float(p.x) for p in points], dtype=np.float64)
    py = np.array([float(p.y) for p in points], dtype=np.float64)
    cols = (np.arange(w, dtype=np.float64) + 0.5) / max(w, 1)
    rows = (np.arange(h, dtype=np.float64) + 0.5) / max(h, 1)
    xg, yg = np.meshgrid(cols, rows)
    inside = np.zeros((h, w), dtype=bool)
    j = len(points) - 1
    eps = 1e-12
    for i in range(len(points)):
        xi, yi = px[i], py[i]
        xj, yj = px[j], py[j]
        dy = yj - yi
        denom = dy if abs(dy) > eps else eps
        cross = xi + ((yg - yi) * (xj - xi) / denom)
        intersects = ((yi > yg) != (yj > yg)) & (xg < cross)
        inside ^= intersects
        j = i
    return inside


def _roi_mask_from_selection(roi_selection: RoiSelectionNormalized, h: int, w: int) -> np.ndarray:
    if roi_selection.polygon_points:
        return _roi_mask_for_polygon(roi_selection.polygon_points, h, w)
    c0 = int(np.floor(float(roi_selection.x1) * w))
    c1 = int(np.ceil(float(roi_selection.x2) * w))
    r0 = int(np.floor(float(roi_selection.y1) * h))
    r1 = int(np.ceil(float(roi_selection.y2) * h))
    c0 = min(max(c0, 0), w - 1)
    c1 = min(max(c1, c0 + 1), w)
    r0 = min(max(r0, 0), h - 1)
    r1 = min(max(r1, r0 + 1), h)
    roi_mask = np.zeros((h, w), dtype=bool)
    roi_mask[r0:r1, c0:c1] = True
    return roi_mask


@router.post("/preprocess/vegetation-time-series")
def preprocess_vegetation_time_series(
    payload: VegetationTimeSeriesRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Por cada escena L2A (6 bandas) o PlanetScope (8 bandas): índices normalizados min-max por escena,
    apilados en el tiempo. Devuelve **series por píxel** (muestreadas) y agregados por escena en ``points``.
    """
    from pathlib import Path

    from app.services.s2_vegetation_indices import (
        build_normalized_index_volumes_for_paths,
        is_eight_band_ps_stack_file,
        is_six_band_s2_stack_file,
        sort_key_from_path_or_meta,
        sort_key_from_raster_layer,
    )

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    pv = normalize_pipeline_variant(payload.pipeline_variant)
    index_list_s2 = ("NDVI", "EVI", "NDWI", "CIre", "MCARI")
    index_list_ps = (
        "NDVI",
        "NDWI",
        "MSAVI2",
        "MTVI2",
        "VARI",
        "TGI",
        "KNDVI",
        "GIYI",
        "MCARI",
        "NDRE",
        "RSTRUCTURE",
    )
    index_list = index_list_ps if pv == "ps" else index_list_s2
    rec_label = recortes_dir_name(pv)

    def _valid_scene_file(path: Path, meta: dict | None) -> bool:
        if pv == "ps":
            return is_eight_band_ps_stack_file(path, meta)
        return is_six_band_s2_stack_file(path, meta)

    by_path_key: dict[str, tuple[str, Path, int | None]] = {}
    rec_root = _tenant_storage(tenant_id, payload.project_id, rec_label)

    for rel in sorted({str(x).strip().replace("\\", "/") for x in (payload.recorte_relative_paths or []) if x}):
        if not rel or ".." in rel:
            raise HTTPException(status_code=400, detail=f"Ruta de recorte no válida: {rel}")
        p = (rec_root / rel).resolve()
        if _safe_relative_under(rec_root, p) is None:
            raise HTTPException(status_code=400, detail=f"Ruta fuera de {rec_label}/: {rel}")
        if not p.is_file():
            raise HTTPException(status_code=400, detail=f"No existe el recorte en {rec_label}/: {rel}")
        if not _valid_scene_file(p, None):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"El archivo no es válido para series (PlanetScope 8 bandas en {rec_label}/)"
                    if pv == "ps"
                    else f"El archivo no es válido para series (L2A 6 bandas en {rec_label}/): {rel}"
                ),
            )
        sk = sort_key_from_path_or_meta(p, None) or ""
        by_path_key[str(p.resolve())] = (sk, p, None)

    for rid in sorted(set(payload.raster_layer_ids or [])):
        r = _get_project_raster(db, tenant_id, payload.project_id, rid)
        path = Path(_existing_raster_path(r))
        meta = r.raster_metadata or {}
        if not _valid_scene_file(path, meta):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"La capa {rid} no es un recorte válido para series (PlanetScope 8 bandas)."
                    if pv == "ps"
                    else f"La capa {rid} no es un recorte L2A de 6 bandas (índices sobre el mismo GeoTIFF)."
                ),
            )
        sk = sort_key_from_raster_layer(r)
        key = str(path.resolve())
        prev = by_path_key.get(key)
        if prev:
            by_path_key[key] = (prev[0], path, rid)
        else:
            by_path_key[key] = (sk or "", path, rid)

    if not by_path_key:
        raise HTTPException(status_code=400, detail="No hay escenas válidas seleccionadas.")

    scenes = sorted(by_path_key.values(), key=lambda x: (str(x[0]), x[2] if x[2] is not None else -1))
    paths = [p for _, p, _ in scenes]

    try:
        stacked, _ref = build_normalized_index_volumes_for_paths(paths, index_list, pipeline_variant=pv)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudieron alinear índices en el tiempo: {exc!s}") from exc

    points: list[dict] = []
    first = stacked[index_list[0]]
    _, h, w = first.shape
    roi_mask = np.ones((h, w), dtype=bool)
    if payload.roi_selection is not None:
        roi_mask = _roi_mask_from_selection(payload.roi_selection, h, w)

    for t, (date, _path, rid) in enumerate(scenes):
        row: dict = {"date": date, "raster_layer_id": rid if rid is not None else 0, "by_index": {}}
        for ix in index_list:
            plane = stacked[ix][t]
            fin = plane[np.isfinite(plane) & roi_mask]
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
    for ix in index_list:
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
        index_list,
        payload.max_pixel_series,
        payload.random_seed,
        payload.roi_selection,
    )

    agg_desc = (
        "Índice por escena normalizado min-max en toda la imagen; series por píxel en valores [0,1]. "
        "Muestreo aleatorio de píxeles válidos en todas las fechas."
    )
    if pv == "ps":
        agg_desc = (
            "PlanetScope (8 bandas): mismos índices que el catálogo PS; normalización min-max por escena; "
            "series por píxel en [0,1]. Muestreo aleatorio de píxeles válidos en todas las fechas."
        )
    if payload.roi_selection is not None:
        agg_desc = f"{agg_desc} Filtrado espacial por ROI normalizado."

    return {
        "project_id": payload.project_id,
        "pipeline_variant": pv,
        "roi_selection": payload.roi_selection.model_dump() if payload.roi_selection is not None else None,
        "dates": [d for d, _, _ in scenes],
        "indices": list(index_list),
        "points": points,
        "temporal_stats": temporal_stats,
        "spatial_aggregation": {
            "method": "all_valid_pixels",
            "description": agg_desc,
        },
        "per_pixel": {
            "n_sampled": n_sampled,
            "n_valid_pixels": n_valid,
            "max_requested": payload.max_pixel_series,
            "random_seed": payload.random_seed,
            "series_by_index": series_by_index,
        },
    }


@router.post("/preprocess/s1-sar-time-series")
def preprocess_s1_sar_time_series(
    payload: S1SarTimeSeriesRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Medias espaciales y series por píxel (muestreadas) desde los stacks en ``s1indices/``,
    misma forma de respuesta que ``/preprocess/vegetation-time-series`` (campo adicional ``source``).
    """
    from app.services.s1_sar_indices import S1_SAR_INDEX_KEYS
    from app.services.s1_sar_time_series import (
        build_normalized_sar_volumes_for_dates,
        discover_primary_s1_sar_stacks,
        intersection_sorted_dates,
        sample_pixel_series_from_stacks,
    )

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    stacks = discover_primary_s1_sar_stacks(tenant_id, payload.project_id)
    if len(stacks) < len(S1_SAR_INDEX_KEYS):
        raise HTTPException(
            status_code=400,
            detail="No hay stacks completos para los cinco índices SAR en s1indices/. Ejecuta «Estimar índices SAR».",
        )

    available = set(intersection_sorted_dates(stacks))
    if not available:
        raise HTTPException(
            status_code=400,
            detail="No hay fechas comunes entre todos los stacks en s1indices/.",
        )

    wanted_sorted: list[str] = []
    seen: set[str] = set()
    for d in payload.dates:
        raw = str(d).strip()
        nd = raw[:10] if len(raw) >= 10 else raw
        if nd not in available:
            raise HTTPException(
                status_code=400,
                detail=f"La fecha {nd} no está en la intersección de fechas de todos los índices SAR (s1indices/).",
            )
        if nd not in seen:
            seen.add(nd)
            wanted_sorted.append(nd)
    wanted_sorted.sort()

    INDEX_LIST = tuple(S1_SAR_INDEX_KEYS)

    try:
        stacked, _ref = build_normalized_sar_volumes_for_dates(stacks, wanted_sorted, INDEX_LIST)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudieron leer los stacks SAR: {exc!s}") from exc

    points: list[dict] = []
    first = stacked[INDEX_LIST[0]]
    _, h, w = first.shape
    roi_mask = np.ones((h, w), dtype=bool)
    if payload.roi_selection is not None:
        roi_mask = _roi_mask_from_selection(payload.roi_selection, h, w)

    for t, date in enumerate(wanted_sorted):
        row: dict = {"date": date, "raster_layer_id": t + 1, "by_index": {}}
        for ix in INDEX_LIST:
            plane = stacked[ix][t]
            fin = plane[np.isfinite(plane) & roi_mask]
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

    series_by_index, n_sampled, n_valid = sample_pixel_series_from_stacks(
        stacked,
        INDEX_LIST,
        payload.max_pixel_series,
        payload.random_seed,
        payload.roi_selection.model_dump() if payload.roi_selection is not None else None,
    )

    return {
        "source": "s1_sar",
        "project_id": payload.project_id,
        "roi_selection": payload.roi_selection.model_dump() if payload.roi_selection is not None else None,
        "dates": wanted_sorted,
        "indices": list(INDEX_LIST),
        "points": points,
        "temporal_stats": temporal_stats,
        "spatial_aggregation": {
            "method": "all_valid_pixels_in_roi" if payload.roi_selection is not None else "all_valid_pixels",
            "description": (
                "Índices SAR por fecha desde s1indices/; normalización min-max por fecha en cada índice. "
                "Muestreo aleatorio de píxeles válidos en todas las fechas e índices."
                + (" Filtrado espacial por ROI normalizado." if payload.roi_selection is not None else "")
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


@router.get("/preprocess/agroclimate-series")
def preprocess_agroclimate_series(
    project_id: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Serie agroclimática por sensor para el dashboard multisensor.
    - Centroide: geometría unión del proyecto (WGS84).
    - Rango: min/max de fechas disponibles entre stacks S1/S2/PS.
    - Valor por escena: promedio mensual del mes al que pertenece cada fecha del timelapse.
    """
    from shapely import wkt as shapely_wkt

    from app.services.project_geometry import wkt_union_from_project_layers

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    wkt = wkt_union_from_project_layers(db, project_id, tenant_id, None)
    if not wkt:
        return {
            "project_id": project_id,
            "source": "open-meteo",
            "centroid": None,
            "date_range": None,
            "by_sensor": {"s1": [], "s2": [], "ps": []},
            "monthly_source_dates": [],
        }

    try:
        geom = shapely_wkt.loads(wkt)
        c = geom.centroid
        lon = float(c.x)
        lat = float(c.y)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo calcular centroide del AOI: {exc!s}") from exc

    s1_dates = _collect_dates_from_s1_sar_stacks(tenant_id, project_id)
    s2_dates = _collect_dates_from_index_stacks(tenant_id, project_id, "s2")
    ps_dates = _collect_dates_from_index_stacks(tenant_id, project_id, "ps")
    all_dates = sorted({*s1_dates, *s2_dates, *ps_dates})
    if not all_dates:
        return {
            "project_id": project_id,
            "source": "open-meteo",
            "centroid": {"lat": lat, "lon": lon},
            "date_range": None,
            "by_sensor": {"s1": [], "s2": [], "ps": []},
            "monthly_source_dates": [],
        }

    start_date = all_dates[0]
    end_date = all_dates[-1]
    daily_rows = _open_meteo_daily(lat, lon, start_date, end_date)
    monthly_means = _monthly_means_from_daily(daily_rows)

    return {
        "project_id": project_id,
        "source": "open-meteo",
        "centroid": {"lat": lat, "lon": lon},
        "date_range": {"start": start_date, "end": end_date},
        "by_sensor": {
            "s1": _series_from_scene_dates(s1_dates, monthly_means),
            "s2": _series_from_scene_dates(s2_dates, monthly_means),
            "ps": _series_from_scene_dates(ps_dates, monthly_means),
        },
        "monthly_source_dates": sorted(monthly_means.keys()),
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


@router.post("/preprocess/ps-planetscope-zip-extract")
def preprocess_ps_planetscope_zip_extract(
    payload: PsPlanetZipExtractRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Por cada ``*.zip`` en ``rasterPS/`` del proyecto: extrae ``composite.tif`` y metadatos (XML, JSON,
    ``composite_udm2.tif``) a ``recortesPS/``; el composite se renombra a ``PS_dd-mm-yy.tif`` usando
    ``YYYYMMDD_`` del nombre de un XML en la misma carpeta interna.
    """
    from app.tasks.jobs import ps_planet_zip_extract_pipeline

    project = db.query(Project).filter(Project.id == payload.project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        async_result = ps_planet_zip_extract_pipeline.delay(tenant_id, payload.project_id)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"No se pudo encolar la extracción PS. ¿Redis y worker Celery? {exc!s}",
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
            normalize_pipeline_variant(payload.pipeline_variant),
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


@router.post("/preprocess/ps-spatiotemporal-cluster/{project_id}")
def ps_spatiotemporal_cluster_run(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    preset: str = Query(
        "smart1",
        description=(
            "smart1 → ps_st_cluster/; smart2 → ps_st_cluster_smart2/; smart3 → ps_st_cluster_smart3/ "
            "(ver documentación del preset)."
        ),
    ),
    body: PsSpatiotemporalClusterRequest | None = None,
):
    """
    Pipeline resumido: cuatro stacks en ``indecesPS/`` → 7 features por píxel → KMeans.
    ``preset=smart1``: NDVI (mean/std/min), NDRE_mean, NDWI_mean/std, VARI_mean.
    ``preset=smart2``: EVI (mean/std/min), NDRE_mean, NDWI_mean/std, VARI_mean.
    ``preset=smart3``: KNDVI (mean/std/min), MCARI_mean, NDWI_mean/std, VARI_mean.
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        pr = get_preset(preset)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    opts = body or PsSpatiotemporalClusterRequest()
    index_root = _tenant_storage(tenant_id, project_id, indices_dir_name("ps"))
    out_dir = _tenant_storage(tenant_id, project_id, pr.output_subdir)
    try:
        meta = run_ps_spatiotemporal_cluster(
            index_root,
            out_dir,
            preset_id=pr.id,
            n_clusters=opts.n_clusters,
            random_state=opts.random_state,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("ps_spatiotemporal_cluster failed")
        raise HTTPException(status_code=500, detail=f"Error en pipeline: {exc!s}") from exc
    return {"status": "ok", "meta": meta}


@router.get("/preprocess/ps-spatiotemporal-cluster-status/{project_id}")
def ps_spatiotemporal_cluster_status(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    preset: str = Query("smart1", description="smart1, smart2 o smart3"),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        pr = get_preset(preset)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    out_dir = _tenant_storage(tenant_id, project_id, pr.output_subdir)
    map_path = out_dir / "final_cluster_map.tif"
    return {
        "ready": map_path.is_file(),
        "preset": pr.id,
        "meta": load_meta(out_dir),
    }


@router.get("/preprocess/ps-spatiotemporal-cluster-preview/{project_id}")
def ps_spatiotemporal_cluster_preview(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    preset: str = Query("smart1", description="smart1, smart2 o smart3"),
):
    """PNG del mapa de clusters (colores discretos)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        pr = get_preset(preset)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    map_path = _tenant_storage(tenant_id, project_id, pr.output_subdir) / "final_cluster_map.tif"
    if not map_path.is_file():
        raise HTTPException(status_code=404, detail="Aún no hay mapa de cluster. Ejecuta POST ps-spatiotemporal-cluster.")
    try:
        png = cluster_map_to_png(map_path.resolve())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo generar la vista previa: {exc!s}") from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )
