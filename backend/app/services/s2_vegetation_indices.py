"""
Índices de vegetación a partir de GeoTIFF Sentinel-2 L2A de 6 bandas (orden B02,B03,B04,B05,B08,B11).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Bandas 1..6 en el recorte L2A del proyecto
S2_BAND_ORDER = ("B02", "B03", "B04", "B05", "B08", "B11")

EPS = 1e-9


def normalize_requested_indices(raw: list[str]) -> list[tuple[str, str]]:
    """
    Lista desde API/UI → pares (nombre carpeta / prefijo archivo, nombre para compute_index_arrays).
    Si la lista contiene «TODOS», equivale a los cinco índices.
    """
    if raw and any(str(s).strip().upper() == "TODOS" for s in raw):
        raw = ["NDVI", "EVI", "NDWI", "CIre", "MCARI"]
    out: list[tuple[str, str]] = []
    for s in raw:
        if not s or not str(s).strip():
            continue
        u = str(s).strip().upper()
        if u == "TODOS":
            continue
        if u == "NDVI":
            out.append(("NDVI", "NDVI"))
        elif u == "EVI":
            out.append(("EVI", "EVI"))
        elif u == "NDWI":
            out.append(("NDWI", "NDWI"))
        elif u == "CIRE":
            out.append(("CIre", "CIRE"))
        elif u == "MCARI":
            out.append(("MCARI", "MCARI"))
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for folder, calc in out:
        if folder not in seen:
            seen.add(folder)
            uniq.append((folder, calc))
    return uniq


def _safe_div(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    out = np.full_like(num, np.nan, dtype=np.float32)
    ok = np.isfinite(num) & np.isfinite(den) & (np.abs(den) > EPS)
    np.divide(num, den, out=out, where=ok)
    return out


def _evi_offset_den(b4: np.ndarray) -> float:
    """EVI: denominador +L; L=10000 típico en reflectancia Sentinel DN, L=1 si ya está ~0–1."""
    m = np.nanmedian(np.abs(b4[np.isfinite(b4)])) if np.any(np.isfinite(b4)) else 0.0
    return 10000.0 if m > 2.0 else 1.0


def compute_index_arrays(
    bands: dict[str, np.ndarray],
    index_name: str,
) -> np.ndarray:
    """Calcula un índice; claves B02,B03,B04,B05,B08,B11 (float32)."""
    b2 = bands["B02"]
    b3 = bands["B03"]
    b4 = bands["B04"]
    b5 = bands["B05"]
    b8 = bands["B08"]
    b11 = bands["B11"]
    name = index_name.upper()
    if name == "NDVI":
        return _safe_div(b8 - b4, b8 + b4).astype(np.float32)
    if name == "EVI":
        L = _evi_offset_den(b4)
        den = b8 + 6.0 * b4 - 7.5 * b2 + L
        return _safe_div(2.5 * (b8 - b4), den).astype(np.float32)
    if name == "NDWI":
        return _safe_div(b8 - b11, b8 + b11).astype(np.float32)
    if name == "CIRE":  # CIre
        return (b8 / (b5 + EPS) - 1.0).astype(np.float32)
    if name == "MCARI":
        t1 = (b5 - b4) - 0.2 * (b5 - b3)
        t2 = b5 / (b4 + EPS)
        return (t1 * t2).astype(np.float32)
    raise ValueError(f"Índice no soportado: {index_name}")


def _resample_to_match(
    src_arr: np.ndarray,
    src_transform: Any,
    src_crs: Any,
    ref_height: int,
    ref_width: int,
    dst_transform: Any,
    dst_crs: Any,
) -> np.ndarray:
    dest = np.empty((ref_height, ref_width), dtype=np.float32)
    reproject(
        source=src_arr.astype(np.float32),
        destination=dest,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        resampling=Resampling.bilinear,
    )
    return dest


def read_six_bands_aligned(tif_path: Path) -> tuple[dict[str, np.ndarray], dict]:
    """
    Lee 6 bandas alineadas a la rejilla de B02 (remuestrea si el archivo tiene tamaños distintos).
    """
    with rasterio.open(tif_path) as src:
        if src.count < 6:
            raise ValueError(f"Se requieren 6 bandas en {tif_path}, hay {src.count}")
        ref_h, ref_w = src.height, src.width
        ref_transform = src.transform
        ref_crs = src.crs
        out: dict[str, np.ndarray] = {}
        ref_band = src.read(1).astype(np.float32)
        out["B02"] = ref_band
        for i, name in enumerate(S2_BAND_ORDER[1:], start=2):
            arr = src.read(i).astype(np.float32)
            if arr.shape == ref_band.shape:
                out[name] = arr
            else:
                logger.warning(
                    "Remuestreando %s a rejilla B02 en %s: shape %s → (%s,%s)",
                    name,
                    tif_path.name,
                    arr.shape,
                    ref_h,
                    ref_w,
                )
                out[name] = _resample_to_match(
                    arr,
                    src.transform,
                    src.crs,
                    ref_h,
                    ref_w,
                    ref_transform,
                    ref_crs,
                )
        profile = src.profile.copy()
        profile.update(count=6, dtype="float32")
        return out, profile


def process_scene_index(
    tif_path: Path,
    index_name: str,
) -> np.ndarray:
    bands, _ = read_six_bands_aligned(tif_path)
    return compute_index_arrays(bands, index_name)


def write_multiband_stack(
    out_path: Path,
    bands_data: list[np.ndarray],
    base_profile: dict,
    index_name: str,
    scene_dates: list[str],
) -> None:
    """Escribe GeoTIFF multibanda; banda i = escena i (orden cronológico)."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n = len(bands_data)
    if n == 0:
        raise ValueError("Sin bandas para escribir")
    h, w = bands_data[0].shape
    profile = base_profile.copy()
    profile.update(
        driver="GTiff",
        dtype="float32",
        count=n,
        height=h,
        width=w,
        compress="lzw",
        tiled=True,
        blockxsize=256,
        blockysize=256,
    )
    dates_compact = [d.replace("-", "") for d in scene_dates]
    meta = {
        "INDEX_NAME": index_name,
        "BAND_DATES_JSON": json.dumps(scene_dates),
        "BAND_DATES_COMPACT": ",".join(dates_compact),
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.update_tags(**meta)
        for i, (arr, d, dc) in enumerate(zip(bands_data, scene_dates, dates_compact), start=1):
            dst.write(arr.astype(np.float32), i)
            dst.set_band_description(i, f"{index_name}_{dc}")


_STEM_DATE = re.compile(r"_(20\d{2})(\d{2})(\d{2})T")


def sort_key_from_path_or_meta(path: Path, metadata: dict | None) -> str | None:
    if metadata and metadata.get("s2_sort_key"):
        return str(metadata["s2_sort_key"])
    stem = path.stem
    m = _STEM_DATE.search(stem)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return None


def sort_key_from_raster_layer(r: Any) -> str | None:
    """Fecha de escena desde metadatos, nombre o fecha de creación de la capa."""
    meta = r.raster_metadata or {}
    fp = Path(r.file_path)
    sk = sort_key_from_path_or_meta(fp, meta)
    if sk:
        return sk
    dl = meta.get("s2_date_label")
    if isinstance(dl, str) and dl.count("/") == 2:
        parts = [p.strip() for p in dl.split("/")]
        if len(parts) == 3:
            dd, mm, yyyy = parts[0], parts[1], parts[2]
            if len(yyyy) == 4:
                return f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}"
    if getattr(r, "created_at", None):
        return r.created_at.date().isoformat()
    return f"layer-{r.id}"


def is_six_band_s2_stack_file(fp: Path, meta: dict | None) -> bool:
    """True si es candidato a stack L2A 6 bandas (no capas legacy JP2 por banda)."""
    from app.api.v1.helpers import is_legacy_s2_zip_band_raster

    if is_legacy_s2_zip_band_raster(meta):
        return False
    m = meta or {}
    if m.get("s2_six_band_stack") or m.get("s2_l2a_recorte"):
        return True
    if m.get("source") == "sentinel-2" and m.get("type") == "download":
        return False
    un = fp.name.upper()
    if "RECORTE" in un and "S2" in un and ("B02" in un or "B11" in un):
        return True
    try:
        with rasterio.open(fp) as src:
            return int(src.count) >= 6
    except Exception:
        return False


def yyyymmdd_range_str(dates_iso: list[str]) -> tuple[str, str]:
    """(YYYYMMDD_min, YYYYMMDD_max) desde fechas YYYY-MM-DD."""
    parts = sorted(d.replace("-", "") for d in dates_iso)
    if not parts:
        return ("", "")
    return (parts[0], parts[-1])


def discover_recorte_scenes(
    db: Session,
    project_id: int,
    tenant_id: int,
    recortes_root: Path,
    raster_layer_ids: list[int] | None = None,
) -> list[tuple[str, Path]]:
    """
    Escenas candidatas (fecha ISO sort_key, ruta TIF ≥6 bandas tipo L2A recorte). Sin duplicar rutas.
    Orden cronológico por sort_key.

    Si ``raster_layer_ids`` está definido, solo esas capas (p. ej. las cargadas en el mapa).
    """
    from app.models.models import RasterLayer

    by_path: dict[Path, tuple[str, Path]] = {}

    q = db.query(RasterLayer).filter(
        RasterLayer.project_id == project_id,
        RasterLayer.tenant_id == tenant_id,
    )
    if raster_layer_ids:
        q = q.filter(RasterLayer.id.in_(raster_layer_ids))

    for r in q.all():
        fp = Path(r.file_path)
        if fp.is_dir():
            continue
        if "_cog" in fp.name.lower():
            continue
        if not fp.is_file():
            continue
        meta = r.raster_metadata or {}
        if not is_six_band_s2_stack_file(fp, meta):
            logger.warning("Capa raster %s omitida (no es stack L2A 6+ bandas): %s", r.id, fp.name)
            continue
        sk = sort_key_from_raster_layer(r)
        if not sk:
            continue
        by_path[fp.resolve()] = (sk, fp)

    if not raster_layer_ids and recortes_root.is_dir():
        for p in sorted(recortes_root.glob("*.tif")):
            if "_cog" in p.name.lower():
                continue
            if not p.is_file():
                continue
            rp = p.resolve()
            if rp in by_path:
                continue
            if not is_six_band_s2_stack_file(p, None):
                continue
            sk = sort_key_from_path_or_meta(p, None)
            if not sk:
                try:
                    sk = datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()
                except OSError:
                    sk = "1900-01-01"
            by_path[rp] = (sk, p)

    return sorted(by_path.values(), key=lambda t: (t[0], str(t[1])))
