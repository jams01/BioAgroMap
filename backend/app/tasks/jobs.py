import json
import logging
import re
import shutil
import uuid
from datetime import date
from pathlib import Path

import numpy as np
import rasterio

from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


def _merge_raster_metadata(db_url: str, raster_layer_id: int, extra: dict) -> None:
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.orm.attributes import flag_modified

        from app.models.models import RasterLayer

        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        db = Session()
        raster = db.query(RasterLayer).filter(RasterLayer.id == raster_layer_id).first()
        if raster:
            raster.raster_metadata = {**(raster.raster_metadata or {}), **extra}
            flag_modified(raster, "raster_metadata")
            db.commit()
        db.close()
    except Exception:
        logger.exception("Error updating raster metadata (process_raster)")


def _update_raster_sentinel_status(db_url: str, raster_layer_id: int, extra: dict) -> None:
    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.orm.attributes import flag_modified

        from app.models.models import RasterLayer

        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        db = Session()
        raster = db.query(RasterLayer).filter(RasterLayer.id == raster_layer_id).first()
        if raster:
            raster.raster_metadata = {**(raster.raster_metadata or {}), **extra}
            flag_modified(raster, "raster_metadata")
            db.commit()
        db.close()
    except Exception:
        logger.exception("Error updating raster metadata (sentinel status)")


def apply_raster_cog(file_path: str, output_path: str, raster_layer_id: int | None = None) -> dict:
    """
    Copia el GeoTIFF fuente a COG LZW tiled y actualiza metadatos en BD.
    Debe llamarse en el mismo proceso que escribe los TIF fuente (no encolar otra tarea Celery).
    """
    from app.core.config import settings
    from app.services.raster_geo import bounds_wgs84_from_path

    src_path = Path(file_path)
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        profile.update({"driver": "GTiff", "compress": "lzw", "tiled": True})
        data = src.read()
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(data)

    meta_update: dict = {"status": "ready", "cog_ready": True}
    b = bounds_wgs84_from_path(out_path)
    if b:
        meta_update["bounds_wgs84"] = list(b)
    else:
        meta_update["status"] = "no_georef"
        meta_update["bounds_error"] = "El archivo no tiene CRS geográfico; no se puede calcular extensión ni vista previa."

    if raster_layer_id is not None:
        _merge_raster_metadata(settings.database_url, raster_layer_id, meta_update)

    return {"status": "done", "cog_path": str(out_path), "bounds_wgs84": meta_update.get("bounds_wgs84")}


@celery_app.task(name="tasks.process_raster")
def process_raster(file_path: str, output_path: str, raster_layer_id: int | None = None) -> dict:
    return apply_raster_cog(file_path, output_path, raster_layer_id)


@celery_app.task(name="tasks.process_s2_zip_layers")
def process_s2_zip_layers(
    band_paths: dict[str, str],
    stack_path: str,
    rgb_src: str,
    nir_src: str,
    rgb_cog: str,
    nir_cog: str,
    rgb_layer_id: int,
    nir_layer_id: int,
) -> dict:
    """
    Stack B04,B03,B02,B08; vistas RGB y NIR desde ese stack; COG síncrono (apply_raster_cog).
    """
    from app.core.config import settings
    from app.services.s2_composites import build_s2_stack_and_composites

    bf = {k: Path(v) for k, v in band_paths.items()}
    try:
        build_s2_stack_and_composites(bf, Path(stack_path), Path(rgb_src), Path(nir_src))
        apply_raster_cog(str(rgb_src), str(rgb_cog), rgb_layer_id)
        apply_raster_cog(str(nir_src), str(nir_cog), nir_layer_id)
    except Exception:
        logger.exception("S2 zip composites failed")
        err = {"status": "failed", "cog_ready": False, "error": "Error al fusionar bandas Sentinel-2"}
        _merge_raster_metadata(settings.database_url, rgb_layer_id, err)
        _merge_raster_metadata(settings.database_url, nir_layer_id, err)
        raise
    return {"status": "done"}


@celery_app.task(name="tasks.mock_inference")
def mock_inference(input_raster: str, output_json: str) -> dict:
    with rasterio.open(input_raster) as src:
        band = src.read(1)
        metrics = {
            "accuracy": float(np.clip(band.mean() / 255.0, 0.55, 0.95)),
            "iou": 0.71,
            "f1_score": 0.81,
        }
    Path(output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(output_json).write_text(json.dumps(metrics), encoding="utf-8")
    return metrics


@celery_app.task(name="tasks.download_sentinel2", bind=True)
def download_sentinel2(
    self,
    wkt: str,
    start_date_str: str,
    end_date_str: str,
    output_dir: str,
    raster_layer_id: int,
    db_url: str,
) -> dict:
    from app.services.sentinel2 import get_copernicus_credentials, search_and_download_monthly

    copernicus_user, copernicus_password = get_copernicus_credentials()

    def progress_cb(current: int, total: int, message: str) -> None:
        pct = int((current / max(total, 1)) * 100)
        self.update_state(
            state="PROGRESS",
            meta={"progress": pct, "message": message, "phase": "downloading"},
        )
        _update_raster_sentinel_status(
            db_url,
            raster_layer_id,
            {"progress": pct, "progress_message": message, "status": "downloading"},
        )

    self.update_state(state="PROGRESS", meta={"progress": 0, "message": "Iniciando...", "phase": "downloading"})
    start = date.fromisoformat(start_date_str)
    end = date.fromisoformat(end_date_str)

    try:
        result = search_and_download_monthly(
            wkt,
            start,
            end,
            output_dir,
            copernicus_user,
            copernicus_password,
            progress_callback=progress_cb,
        )
    except Exception as exc:
        logger.exception("Sentinel-2 download failed")
        _update_raster_sentinel_status(
            db_url,
            raster_layer_id,
            {
                "status": "failed",
                "error": str(exc),
                "progress": 0,
                "progress_message": f"Error: {exc}",
            },
        )
        raise

    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.orm.attributes import flag_modified

        from app.models.models import RasterLayer

        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        db = Session()
        raster = db.query(RasterLayer).filter(RasterLayer.id == raster_layer_id).first()
        if raster:
            meta = {
                **(raster.raster_metadata or {}),
                "status": "completed",
                "total_downloaded": result["total_downloaded"],
                "total_size_mb": result["total_size_mb"],
                "files": [str(f) for f in result["files"]],
                "skipped_low_coverage": result.get("skipped_low_coverage", 0),
                "progress": 100,
                "progress_message": "Descarga terminada",
            }
            if result["files"]:
                meta["primary_file"] = result["files"][0]
                raster.file_path = result["files"][0]
            raster.raster_metadata = meta
            flag_modified(raster, "raster_metadata")
            db.commit()
        db.close()
    except Exception:
        logger.exception("Error updating raster metadata after S2 download")

    self.update_state(state="SUCCESS", meta={"progress": 100, "message": "Terminado", "phase": "completed"})
    return result


@celery_app.task(name="tasks.download_sentinel1", bind=True)
def download_sentinel1(
    self,
    wkt: str,
    start_date_str: str,
    end_date_str: str,
    project_downloads_root: str,
    raster_layer_id: int,
    db_url: str,
) -> dict:
    from pathlib import Path

    from app.services.sentinel2 import get_copernicus_credentials
    from app.services.sentinel1 import search_filter_and_download

    copernicus_user, copernicus_password = get_copernicus_credentials()

    def progress_cb(current: int, total: int, message: str) -> None:
        pct = int((current / max(total, 1)) * 100)
        self.update_state(
            state="PROGRESS",
            meta={"progress": pct, "message": message, "phase": "downloading"},
        )
        _update_raster_sentinel_status(
            db_url,
            raster_layer_id,
            {"progress": pct, "progress_message": message, "status": "downloading"},
        )

    self.update_state(state="PROGRESS", meta={"progress": 0, "message": "Iniciando Sentinel-1…", "phase": "downloading"})
    start = date.fromisoformat(start_date_str)
    end = date.fromisoformat(end_date_str)

    try:
        result = search_filter_and_download(
            wkt,
            start,
            end,
            Path(project_downloads_root),
            copernicus_user,
            copernicus_password,
            progress_callback=progress_cb,
        )
    except Exception as exc:
        logger.exception("Sentinel-1 download failed")
        _update_raster_sentinel_status(
            db_url,
            raster_layer_id,
            {
                "status": "failed",
                "error": str(exc),
                "progress": 0,
                "progress_message": f"Error: {exc}",
            },
        )
        raise

    try:
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker
        from sqlalchemy.orm.attributes import flag_modified

        from app.models.models import RasterLayer

        engine = create_engine(db_url)
        Session = sessionmaker(bind=engine)
        db = Session()
        raster = db.query(RasterLayer).filter(RasterLayer.id == raster_layer_id).first()
        if raster:
            meta = {
                **(raster.raster_metadata or {}),
                "status": "completed",
                "total_downloaded": result["total_downloaded"],
                "total_size_mb": result["total_size_mb"],
                "progress": 100,
                "progress_message": result.get("summary_message") or "Descarga Sentinel-1 terminada",
                "selected_relative_orbit": result.get("selected_relative_orbit"),
                "selected_orbit_direction": result.get("selected_orbit_direction"),
                "selected_pass_short": result.get("selected_pass_short"),
                "date_range_start": result.get("date_range_start"),
                "date_range_end": result.get("date_range_end"),
                "csv_path": result.get("csv_path"),
                "sentinel1_root": result.get("sentinel1_root"),
                "product_paths": result.get("product_paths") or [],
            }
            if result.get("sentinel1_root"):
                raster.file_path = str(result["sentinel1_root"])
            raster.raster_metadata = meta
            flag_modified(raster, "raster_metadata")
            db.commit()
        db.close()
    except Exception:
        logger.exception("Error updating raster metadata after Sentinel-1 download")

    self.update_state(state="SUCCESS", meta={"progress": 100, "message": "Terminado", "phase": "completed"})
    return result


@celery_app.task(name="tasks.s2_l2a_recortes_pipeline")
def s2_l2a_recortes_pipeline(
    tenant_id: int,
    project_id: int,
    project_name: str,
    layer_id: int | None,
    db_url: str,
    product_names: list[str] | None = None,
    source_subpath: str | None = None,
) -> dict:
    """
    Por cada ZIP L2A o carpeta .SAFE: un GeoTIFF de 6 bandas (B02,B03,B04,B05@10m,B08,B11@10m),
    recorte al polígono, guardado en recortes/ (sin subcarpetas por día/mes). Una capa; vista previa R=B04,G=B03,B=B02.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api.v1.helpers import _tenant_storage, project_downloads_dir
    from app.models.models import RasterLayer
    from app.services.combine_s2_bands import (
        S2_RECORTE_SIX_BAND_ORDER,
        S2_TRUE_COLOR_RGB_BANDS_1BASED,
        combine_s2_recorte_six_band,
    )
    from app.services.project_geometry import wkt_union_from_project_layers
    from app.services.raster_clip import clip_raster_by_wkt_polygon
    from app.services.raster_geo import bounds_wgs84_from_path
    from app.services.s2_composites import s2_acquisition_date_label
    from app.services.sentinel_safe import (
        S2_BANDS_10M_ORDER,
        find_safe_ancestor,
        find_sentinel_r20_r60_band_files,
        find_sentinel_r10_band_files,
        safe_extract_zip,
    )

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        wkt = wkt_union_from_project_layers(db, project_id, tenant_id, layer_id)
        if not wkt:
            return {"ok": False, "error": "no_wkt", "message": "No hay polígono en el proyecto."}

        from app.core.config import settings as app_settings

        if source_subpath is None:
            downloads = project_downloads_dir(tenant_id, project_id, project_name)
        else:
            pr = (
                Path(app_settings.storage_path).resolve() / f"tenant_{tenant_id}" / f"project_{project_id}"
            ).resolve()
            rel = (source_subpath or "").strip().replace("\\", "/")
            parts = [x for x in rel.split("/") if x and x != "."]
            cur = pr
            for part in parts:
                if part == "..":
                    return {"ok": False, "error": "bad_path", "message": "Ruta inválida"}
                cur = (cur / part).resolve()
            try:
                cur.relative_to(pr)
            except ValueError:
                return {"ok": False, "error": "bad_path", "message": "Ruta fuera del proyecto"}
            downloads = cur
        if not downloads.is_dir():
            return {
                "ok": False,
                "error": "no_downloads",
                "message": f"No existe la carpeta de productos L2A: {downloads}",
            }

        candidates: list[tuple[str, Path]] = []
        try:
            for p in sorted(downloads.iterdir()):
                if p.is_file() and p.suffix.lower() == ".zip":
                    candidates.append(("zip", p))
                elif p.is_dir() and p.name.upper().endswith(".SAFE"):
                    candidates.append(("safe", p))
        except OSError as exc:
            return {"ok": False, "error": "list_failed", "message": str(exc)}

        if not candidates:
            return {
                "ok": False,
                "error": "no_l2a",
                "message": "No hay productos Sentinel-2 reconocibles (.zip o carpeta .SAFE) en la carpeta de descargas.",
            }

        if product_names:
            allowed = {Path(str(x).strip()).name for x in product_names if str(x).strip()}
            if not allowed:
                return {"ok": False, "error": "no_selection", "message": "Lista de productos vacía."}
            candidates = [(k, p) for k, p in candidates if p.name in allowed]
            if not candidates:
                return {
                    "ok": False,
                    "error": "no_match",
                    "message": "Ningún nombre coincide con productos L2A en la carpeta de descargas.",
                }

        rasters_dir = _tenant_storage(tenant_id, project_id, "rasters")
        recortes_root = _tenant_storage(tenant_id, project_id, "recortes")
        logger.info(
            "s2_l2a_recortes: recortes_root=%s (salida plana: <producto>_S2_B02-B11_recorte.tif)",
            recortes_root,
        )

        results: list[dict] = []
        errors: list[str] = []

        for kind, path in candidates:
            extract_dir: Path | None = None
            try:
                if kind == "zip":
                    pack_ex = uuid.uuid4().hex
                    extract_dir = rasters_dir / f"s2_recorte_{pack_ex}"
                    safe_extract_zip(path, extract_dir)
                    root = extract_dir
                else:
                    root = path

                band_files = find_sentinel_r10_band_files(root)
                missing = [b for b in S2_BANDS_10M_ORDER if b not in band_files]
                band_lr = find_sentinel_r20_r60_band_files(root, ("B05", "B11"))
                missing_lr = [b for b in ("B05", "B11") if b not in band_lr]
                if missing or missing_lr:
                    err_parts = []
                    if missing:
                        err_parts.append(f"10m {missing}")
                    if missing_lr:
                        err_parts.append(f"R20/R60 {missing_lr}")
                    errors.append(f"{path.name}: faltan bandas ({'; '.join(err_parts)})")
                    if extract_dir:
                        shutil.rmtree(extract_dir, ignore_errors=True)
                    continue

                first_jp2 = next(iter(band_files.values()))
                safe_anc = find_safe_ancestor(Path(first_jp2).resolve())
                stem = safe_anc.stem if safe_anc else path.stem

                m = re.search(r"_(20\d{2})(\d{2})(\d{2})T", stem)
                if m:
                    y, mo, dd = m.group(1), m.group(2), m.group(3)
                    s2_sort_key = f"{y}-{mo}-{dd}"
                else:
                    t = date.today()
                    y, mo, dd = str(t.year), f"{t.month:02d}", f"{t.day:02d}"
                    s2_sort_key = f"{y}-{mo}-{dd}"

                recortes_root.mkdir(parents=True, exist_ok=True)

                pack = uuid.uuid4().hex[:12]
                stack_tif = rasters_dir / f"{pack}_stack.tif"

                combine_s2_recorte_six_band(
                    band_files,
                    band_lr,
                    stack_tif,
                    crop_wkt=wkt,
                )

                safe_slug = re.sub(r"[^\w\-.]+", "_", stem)[:80]
                clip_out = recortes_root / f"{safe_slug}_S2_B02-B11_recorte.tif"
                logger.info("s2_l2a_recortes: escribiendo recorte 6 bandas en %s", clip_out)
                clip_raster_by_wkt_polygon(stack_tif, wkt, clip_out)

                clip_cog = clip_out.with_name(clip_out.stem + "_cog.tif")

                date_label = s2_acquisition_date_label(stem)
                name_layer = f"{dd}/{mo}/{y}_clip"

                meta = {
                    "source_name": path.name,
                    "status": "processing",
                    "cog_ready": False,
                    "s2_l2a_recorte": True,
                    "s2_six_band_stack": True,
                    "s2_four_band_stack": False,
                    "s2_band_order": ",".join(S2_RECORTE_SIX_BAND_ORDER),
                    "s2_sort_key": s2_sort_key,
                    "preview_rgb_bands": list(S2_TRUE_COLOR_RGB_BANDS_1BASED),
                    "bands_display_note": "Vista mapa: R=B04, G=B03, B=B02",
                    "recorte_rel_path": ".",
                    "recorte_storage_layout": "flat_root",
                    "from_zip": kind == "zip",
                    "s2_composite": True,
                    "composite_kind": "true_color",
                    "s2_date_label": date_label,
                    "s2_stack_path": str(clip_out),
                }
                bds = bounds_wgs84_from_path(clip_out)
                if bds:
                    meta["bounds_wgs84"] = list(bds)

                r_one = RasterLayer(
                    project_id=project_id,
                    tenant_id=tenant_id,
                    name=name_layer,
                    file_path=str(clip_out),
                    cog_path=str(clip_cog),
                    raster_metadata=meta,
                )
                db.add(r_one)
                db.commit()
                db.refresh(r_one)

                apply_raster_cog(str(clip_out), str(clip_cog), r_one.id)

                results.append(
                    {
                        "stem": stem,
                        "layer_id": r_one.id,
                        "recorte_dir": str(recortes_root),
                        "file": str(clip_out),
                    }
                )

                stack_tif.unlink(missing_ok=True)
                if extract_dir:
                    shutil.rmtree(extract_dir, ignore_errors=True)
                extract_dir = None

            except Exception as exc:
                logger.exception("s2_l2a_recortes item failed: %s", path)
                errors.append(f"{path.name}: {exc}")
                db.rollback()
                if extract_dir:
                    shutil.rmtree(extract_dir, ignore_errors=True)

        return {
            "ok": True,
            "processed": len(results),
            "results": results,
            "errors": errors,
            "pipeline": "s2_l2a",
        }
    finally:
        db.close()


@celery_app.task(name="tasks.s1_grd_recortes_pipeline")
def s1_grd_recortes_pipeline(
    tenant_id: int,
    project_id: int,
    project_name: str,
    layer_id: int | None,
    db_url: str,
    product_paths: list[str],
) -> dict:
    """
    Por cada producto Sentinel-1 (.SAFE o .zip bajo ``Sentinel1/``): apila VV+VH, recorte al polígono
    (subset espacial equivalente a SNAP), salida en ``recortes/S1/`` y capa raster.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api.v1.helpers import _tenant_storage, project_downloads_dir
    from app.models.models import Layer, RasterLayer
    from app.services.project_geometry import wkt_union_from_project_layers
    from app.services.raster_geo import bounds_wgs84_from_path
    from app.services.s2_composites import s2_acquisition_date_label
    from app.services.sentinel1_recorte import s1_safe_spatial_subset_to_recorte, s1_sort_key_from_safe_stem
    from app.services.sentinel_safe import safe_extract_zip

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        wkt = wkt_union_from_project_layers(db, project_id, tenant_id, layer_id)
        if not wkt:
            return {"ok": False, "error": "no_wkt", "message": "No hay polígono en el proyecto.", "pipeline": "s1_grd"}

        aoi_layer_name: str | None = None
        if layer_id is not None:
            lyr_aoi = (
                db.query(Layer)
                .filter(Layer.id == layer_id, Layer.project_id == project_id, Layer.tenant_id == tenant_id)
                .first()
            )
            if lyr_aoi:
                aoi_layer_name = lyr_aoi.name

        sentinel1_root = project_downloads_dir(tenant_id, project_id, project_name) / "Sentinel1"
        sentinel1_resolved = sentinel1_root.resolve()
        if not sentinel1_root.is_dir():
            return {
                "ok": False,
                "error": "no_sentinel1_dir",
                "message": f"No existe la carpeta Sentinel-1: {sentinel1_root}",
                "pipeline": "s1_grd",
            }

        raw_paths = [str(x).strip().replace("\\", "/") for x in (product_paths or []) if str(x).strip()]
        if not raw_paths:
            return {
                "ok": False,
                "error": "no_selection",
                "message": "No se indicaron productos (.SAFE o .zip) a recortar.",
                "pipeline": "s1_grd",
            }

        def _resolve_under_s1(rel: str) -> Path | None:
            if not rel or rel.startswith("/") or ".." in rel.split("/"):
                return None
            full = (sentinel1_root / rel).resolve()
            try:
                full.relative_to(sentinel1_resolved)
            except ValueError:
                return None
            return full

        rasters_dir = _tenant_storage(tenant_id, project_id, "rasters")
        recortes_root = _tenant_storage(tenant_id, project_id, "recortes") / "S1"
        results: list[dict] = []
        errors: list[str] = []

        for rel in raw_paths:
            path = _resolve_under_s1(rel)
            if path is None:
                errors.append(f"{rel}: ruta inválida o fuera de Sentinel1/")
                continue
            if not path.exists():
                errors.append(f"{rel}: no existe")
                continue

            extract_dir: Path | None = None
            safe_dir: Path | None = None
            try:
                if path.is_file() and path.suffix.lower() == ".zip":
                    pack_ex = uuid.uuid4().hex
                    extract_dir = rasters_dir / f"s1_recorte_{pack_ex}"
                    safe_extract_zip(path, extract_dir)
                    candidates = [
                        p
                        for p in extract_dir.rglob("*")
                        if p.is_dir() and p.name.upper().endswith(".SAFE")
                    ]
                    if not candidates:
                        errors.append(f"{path.name}: no se encontró carpeta .SAFE tras extraer")
                        continue
                    candidates.sort(key=lambda p: len(p.parts))
                    safe_dir = candidates[0]
                elif path.is_dir() and path.name.upper().endswith(".SAFE"):
                    safe_dir = path
                else:
                    errors.append(f"{rel}: no es .zip ni carpeta .SAFE")
                    continue

                assert safe_dir is not None
                work = rasters_dir / f"s1_work_{uuid.uuid4().hex[:12]}"
                clip_out, clip_diag = s1_safe_spatial_subset_to_recorte(safe_dir, wkt, recortes_root, work)
                shutil.rmtree(work, ignore_errors=True)

                stem = safe_dir.name
                if stem.upper().endswith(".SAFE"):
                    stem = stem[:-5]
                s1_sort_key = s1_sort_key_from_safe_stem(stem)
                date_label = s2_acquisition_date_label(stem)
                m = re.search(r"_(20\d{2})(\d{2})(\d{2})T", stem.upper())
                if m:
                    y, mo, dd = m.group(1), m.group(2), m.group(3)
                    name_layer = f"{dd}/{mo}/{y}_S1_clip"
                else:
                    name_layer = f"S1_clip_{stem[:24]}"

                clip_cog = clip_out.with_name(clip_out.stem + "_cog.tif")
                meta = {
                    "source_name": rel,
                    "status": "processing",
                    "cog_ready": False,
                    "s1_grd_recorte": True,
                    "s1_iw_grd_vv_vh": True,
                    "s1_sort_key": s1_sort_key,
                    "s1_date_label": date_label,
                    "composite_kind": "true_color",
                    "preview_rgb_bands": [1, 2, 2],
                    "bands_display_note": "Vista mapa: R=VV, G=VH, B=VH (backscatter)",
                    "subset_note": "Recorte espacial por polígono (SNAP Read→Subset→Terrain-Correction→Write → *_recorte_TC.tif si hay gpt; si no, rasterio → *_recorte.tif).",
                    "recorte_rel_path": "S1",
                    "recorte_storage_layout": "recortes/S1",
                    "from_zip": path.suffix.lower() == ".zip",
                    "s1_clip_engine": clip_diag.get("clip_engine"),
                    "snap_gpt_attempted": bool(clip_diag.get("snap_gpt_attempted")),
                    "snap_gpt_ok": bool(clip_diag.get("snap_ok")),
                    "aoi_layer_id": layer_id,
                    "aoi_layer_name": aoi_layer_name,
                    "aoi_mode": "single_vector_layer" if layer_id else "union_all_project_vectors",
                }
                se = clip_diag.get("snap_error")
                if se:
                    meta["snap_subset_error"] = str(se)[:800]
                bds = bounds_wgs84_from_path(clip_out)
                if bds:
                    meta["bounds_wgs84"] = list(bds)

                r_one = RasterLayer(
                    project_id=project_id,
                    tenant_id=tenant_id,
                    name=name_layer,
                    file_path=str(clip_out),
                    cog_path=str(clip_cog),
                    raster_metadata=meta,
                )
                db.add(r_one)
                db.commit()
                db.refresh(r_one)
                apply_raster_cog(str(clip_out), str(clip_cog), r_one.id)
                results.append(
                    {
                        "stem": stem,
                        "layer_id": r_one.id,
                        "file": str(clip_out),
                        "clip_engine": clip_diag.get("clip_engine"),
                        "snap_ok": bool(clip_diag.get("snap_ok")),
                    }
                )
            except Exception as exc:
                logger.exception("s1_grd_recortes item failed: %s", rel)
                errors.append(f"{rel}: {exc}")
                db.rollback()
            finally:
                if extract_dir:
                    shutil.rmtree(extract_dir, ignore_errors=True)

        def _s1_err_polygon_outside_scene(msg: str) -> bool:
            low = (msg or "").lower()
            return any(
                k in low
                for k in (
                    "no intersecta la extensión",
                    "no intersecta la escena",
                    "ventana vacía",
                    "sin píxeles en el recorte",
                )
            )

        polygon_outside_scene = bool(errors) and any(_s1_err_polygon_outside_scene(e) for e in errors)
        if len(results) > 0:
            user_message = f"Listo: {len(results)} recorte(s) guardado(s) en recortes/S1/."
        elif polygon_outside_scene:
            user_message = (
                "El polígono del proyecto no está dentro de la imagen (o esa escena Sentinel-1 no cubre el lote) "
                "para uno o más productos. Prueba otra fecha/órbita o comprueba el vector y el CRS."
            )
        elif errors:
            user_message = "Proceso terminado sin recortes nuevos; revisa el detalle por producto."
        else:
            user_message = "No se procesó ningún producto (sin selección o rutas inválidas)."

        return {
            "ok": True,
            "processed": len(results),
            "results": results,
            "errors": errors,
            "pipeline": "s1_grd",
            "polygon_outside_scene": polygon_outside_scene,
            "user_message": user_message,
            "aoi": {
                "layer_id": layer_id,
                "layer_name": aoi_layer_name,
                "mode": "single_vector_layer" if layer_id else "union_all_project_vectors",
            },
        }
    finally:
        db.close()


@celery_app.task(name="tasks.s2_index_stacks_pipeline")
def s2_index_stacks_pipeline(
    tenant_id: int,
    project_id: int,
    indices: list[str],
    db_url: str,
    raster_layer_ids: list[int] | None = None,
    recorte_filenames: list[str] | None = None,
) -> dict:
    """
    Por cada índice seleccionado: stack multibanda (una banda por escena) desde recortes L2A 6 bandas.
    Salida en indices/<Nombre>/<Nombre>_<YYYYMMDDmin>_<YYYYMMDDmax>.tif
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.api.v1.helpers import _tenant_storage
    from app.models.models import RasterLayer
    from app.services.s2_vegetation_indices import (
        discover_recorte_scenes,
        discover_recorte_scenes_by_filenames,
        normalize_index_minmax_per_scene,
        normalize_requested_indices,
        process_scene_index,
        read_six_bands_aligned,
        write_multiband_stack,
        yyyymmdd_range_str,
    )

    engine = create_engine(db_url)
    Session = sessionmaker(bind=engine)
    db = Session()
    outputs: dict[str, str] = {}
    errors: list[dict[str, str]] = []
    try:
        recortes_root = _tenant_storage(tenant_id, project_id, "recortes")
        if recorte_filenames:
            scenes = discover_recorte_scenes_by_filenames(recortes_root, recorte_filenames)
        else:
            scenes = discover_recorte_scenes(
                db,
                project_id,
                tenant_id,
                recortes_root,
                raster_layer_ids=raster_layer_ids,
            )
        if not scenes:
            return {
                "ok": False,
                "error": "no_scenes",
                "message": "No hay escenas válidas: capas raster 6+ bandas en el mapa, o GeoTIFF en recortes/. Ejecuta el recorte L2A o revisa las capas seleccionadas.",
                "outputs": {},
                "errors": [],
            }

        pairs = normalize_requested_indices(indices)
        if not pairs:
            return {"ok": False, "error": "no_indices", "message": "Ningún índice válido.", "outputs": {}, "errors": []}

        indices_root = _tenant_storage(tenant_id, project_id, "indices")

        for folder_name, calc_name in pairs:
            bands_stack: list = []
            dates_used: list[str] = []

            logger.info("Índice %s (cálculo %s): %s escenas", folder_name, calc_name, len(scenes))

            for sort_key, tif_path in scenes:
                try:
                    arr = process_scene_index(tif_path, calc_name)
                    arr = normalize_index_minmax_per_scene(arr)
                    bands_stack.append(arr)
                    dates_used.append(sort_key)
                except Exception as exc:
                    logger.warning("Escena omitida %s [%s]: %s", tif_path.name, folder_name, exc)
                    errors.append({"scene": str(tif_path), "index": folder_name, "error": str(exc)})

            if not bands_stack:
                logger.error("Índice %s: sin bandas válidas", folder_name)
                continue

            dir_out = indices_root / folder_name
            dir_out.mkdir(parents=True, exist_ok=True)

            _, base_prof = read_six_bands_aligned(scenes[0][1])
            base_prof.update(count=1, dtype="float32")
            dmin, dmax = yyyymmdd_range_str(dates_used)
            out_path = dir_out / f"{folder_name}_{dmin}_{dmax}.tif"

            try:
                write_multiband_stack(out_path, bands_stack, base_prof, folder_name, dates_used)
                outputs[folder_name] = str(out_path)
                logger.info("Stack %s guardado: %s (%s bandas)", folder_name, out_path, len(bands_stack))

                # No registrar stacks como capas del mapa; limpiar filas legacy (versiones anteriores sí creaban capa).
                for old in (
                    db.query(RasterLayer)
                    .filter(
                        RasterLayer.project_id == project_id,
                        RasterLayer.tenant_id == tenant_id,
                    )
                    .all()
                ):
                    om = old.raster_metadata or {}
                    if om.get("s2_index_stack") and om.get("vegetation_index_key") == folder_name:
                        for p in (old.file_path, old.cog_path):
                            if p:
                                try:
                                    Path(p).unlink(missing_ok=True)
                                except OSError:
                                    pass
                        db.delete(old)
                db.commit()
            except Exception as exc:
                logger.exception("Fallo al escribir stack %s", folder_name)
                errors.append({"scene": "", "index": folder_name, "error": str(exc)})

        return {
            "ok": bool(outputs),
            "outputs": outputs,
            "errors": errors,
            "scene_count": len(scenes),
        }
    finally:
        db.close()
