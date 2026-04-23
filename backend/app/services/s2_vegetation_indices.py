"""
Índices de vegetación a partir de GeoTIFF Sentinel-2 L2A de 6 bandas (orden B02,B03,B04,B05,B08,B11)
o PlanetScope PS de 8 bandas (índices con equivalencias b,g,r,ir → PS2,4,6,8).
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

# PlanetScope 8 bandas (1-based). Para índices tabulados: b≈S2 B02, g≈S2 B03, r≈S2 B04, ir≈S2 B8a.
PS_INDEX_MIN_BANDS = 8
_PS_BGRI_BANDS_1BASED = {"b": 2, "g": 4, "r": 6, "ir": 8}


def normalize_requested_indices(
    raw: list[str],
    *,
    pipeline_variant: str = "s2",
) -> list[tuple[str, str]]:
    """
    Lista desde API/UI → pares (nombre carpeta / prefijo archivo, nombre para compute_*_index_arrays).

    ``pipeline_variant=ps``: NDVI, EVI, NDWI, MSAVI2, MTVI2, VARI, TGI, KNDVI, GIYI, MCARI, NDRE, RSTRUCTURE (NDRE/NDVI, estructura de dosel).
    ``pipeline_variant=s2``: NDVI, EVI, NDWI (NIR–SWIR), CIre, MCARI.
    """
    from app.services.preprocess_pipeline_variant import normalize_pipeline_variant

    if normalize_pipeline_variant(pipeline_variant) == "ps":
        return _normalize_requested_indices_ps(raw)
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


def _normalize_requested_indices_ps(raw: list[str]) -> list[tuple[str, str]]:
    if raw and any(str(s).strip().upper() == "TODOS" for s in raw):
        raw = [
            "NDVI",
            "EVI",
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
        ]
    key_map = {
        "NDVI": ("NDVI", "NDVI"),
        "EVI": ("EVI", "EVI"),
        "NDWI": ("NDWI", "NDWI"),
        "MSAVI2": ("MSAVI2", "MSAVI2"),
        "MTVI2": ("MTVI2", "MTVI2"),
        "VARI": ("VARI", "VARI"),
        "TGI": ("TGI", "TGI"),
        "KNDVI": ("KNDVI", "KNDVI"),
        "GIYI": ("GIYI", "GIYI"),
        "MCARI": ("MCARI", "MCARI"),
        "NDRE": ("NDRE", "NDRE"),
        "RSTRUCTURE": ("RSTRUCTURE", "RSTRUCTURE"),
    }
    out: list[tuple[str, str]] = []
    for s in raw:
        if not s or not str(s).strip():
            continue
        u = str(s).strip().upper()
        if u == "TODOS":
            continue
        if u in key_map:
            out.append(key_map[u])
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


def spatial_mean_std_iqr_filtered(
    values: np.ndarray,
    *,
    iqr_factor: float = 1.5,
) -> tuple[float | None, float | None, int, int, int]:
    """
    Media y desviación estándar espacial tras excluir valores atípicos (Tukey: fuera de
    [Q1 - k·IQR, Q3 + k·IQR]). Si el filtro deja muy pocos píxeles, se usan todos los válidos.

    Retorna: mean, std (ddof=1), n_raw, n_used, n_removed
    """
    arr = np.asarray(values, dtype=np.float64).ravel()
    arr = arr[np.isfinite(arr)]
    n_raw = int(arr.size)
    if n_raw == 0:
        return None, None, 0, 0, 0
    if n_raw < 4:
        m = float(np.mean(arr))
        s = float(np.std(arr, ddof=1)) if n_raw > 1 else 0.0
        return m, s, n_raw, n_raw, 0
    q1, q3 = np.percentile(arr, [25.0, 75.0])
    iqr = float(q3 - q1)
    if iqr <= 0:
        m = float(np.mean(arr))
        s = float(np.std(arr, ddof=1)) if n_raw > 1 else 0.0
        return m, s, n_raw, n_raw, 0
    lo = q1 - iqr_factor * iqr
    hi = q3 + iqr_factor * iqr
    mask = (arr >= lo) & (arr <= hi)
    trimmed = arr[mask]
    min_keep = max(1, int(max(50.0, 0.05 * n_raw)))
    if trimmed.size < min_keep or trimmed.size == 0:
        trimmed = arr
        n_removed = 0
        n_used = n_raw
    else:
        n_used = int(trimmed.size)
        n_removed = n_raw - n_used
    m = float(np.mean(trimmed))
    s = float(np.std(trimmed, ddof=1)) if trimmed.size > 1 else 0.0
    return m, s, n_raw, n_used, n_removed


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


def read_planet_eight_bands_bgri(tif_path: Path) -> tuple[dict[str, np.ndarray], dict]:
    """
    Lee bandas PS alineadas a la rejilla de la banda 2 (azul).

    Claves: ``b``, ``g``, ``r``, ``ir`` (PS2,4,6,8); ``green_i``, ``yellow`` (PS3, PS5); ``red_edge`` (PS7).
    """
    with rasterio.open(tif_path) as src:
        if int(src.count) < PS_INDEX_MIN_BANDS:
            raise ValueError(
                f"PlanetScope: se requieren {PS_INDEX_MIN_BANDS} bandas en {tif_path}, hay {src.count}"
            )
        ref_h, ref_w = src.height, src.width
        ref_transform = src.transform
        ref_crs = src.crs
        ref_band = src.read(_PS_BGRI_BANDS_1BASED["b"]).astype(np.float32)
        out: dict[str, np.ndarray] = {}
        for key in ("b", "g", "r", "ir"):
            bi = _PS_BGRI_BANDS_1BASED[key]
            arr = src.read(bi).astype(np.float32)
            if arr.shape == ref_band.shape:
                out[key] = arr
            else:
                logger.warning(
                    "Remuestreando PS banda %s a rejilla banda2 en %s: shape %s → (%s,%s)",
                    bi,
                    tif_path.name,
                    arr.shape,
                    ref_h,
                    ref_w,
                )
                out[key] = _resample_to_match(
                    arr,
                    src.transform,
                    src.crs,
                    ref_h,
                    ref_w,
                    ref_transform,
                    ref_crs,
                )
        for key, bi in (("green_i", 3), ("yellow", 5), ("red_edge", 7)):
            arr = src.read(bi).astype(np.float32)
            if arr.shape == ref_band.shape:
                out[key] = arr
            else:
                logger.warning(
                    "Remuestreando PS banda %s a rejilla banda2 en %s: shape %s → (%s,%s)",
                    bi,
                    tif_path.name,
                    arr.shape,
                    ref_h,
                    ref_w,
                )
                out[key] = _resample_to_match(
                    arr,
                    src.transform,
                    src.crs,
                    ref_h,
                    ref_w,
                    ref_transform,
                    ref_crs,
                )
        profile = src.profile.copy()
        profile.update(count=PS_INDEX_MIN_BANDS, dtype="float32")
        return out, profile


def compute_ps_index_arrays(bgri: dict[str, np.ndarray], index_name: str) -> np.ndarray:
    """
    Índices PS según tabla (ir=NIR PS8, r=Rojo PS6, g=Verde PS4, b=Azul PS2; equivalencias S2 B8a,B4,B3,B02).
    """
    b = bgri["b"]
    g = bgri["g"]
    r = bgri["r"]
    ir = bgri["ir"]
    name = index_name.upper()
    if name == "NDVI":
        return _safe_div(ir - r, ir + r).astype(np.float32)
    if name == "EVI":
        L = _evi_offset_den(r)
        den = ir + 6.0 * r - 7.5 * b + L
        return _safe_div(2.5 * (ir - r), den).astype(np.float32)
    if name == "NDRE":
        # (NIR − RedEdge) / (NIR + RedEdge); NIR=PS8, RedEdge=PS7.
        red_e = bgri["red_edge"]
        return _safe_div(ir - red_e, ir + red_e).astype(np.float32)
    if name == "RSTRUCTURE":
        # NDRE / NDVI (custom, estructura de dosel); NDRE y NDVI con las mismas bandas PS que arriba.
        red_e = bgri["red_edge"]
        ndre = _safe_div(ir - red_e, ir + red_e)
        ndvi = _safe_div(ir - r, ir + r)
        return _safe_div(ndre, ndvi).astype(np.float32)
    if name == "NDWI":
        # NDWI tipo McFeeters (verde − NIR) / (verde + NIR); no el NDWI NIR−SWIR de Sentinel.
        return _safe_div(g - ir, g + ir).astype(np.float32)
    if name == "MSAVI2":
        inner = (2.0 * ir + 1.0) ** 2 - 8.0 * (ir - r)
        sqrt_term = np.sqrt(np.maximum(inner, 0.0))
        return ((2.0 * ir + 1.0 - sqrt_term) / 2.0).astype(np.float32)
    if name == "MTVI2":
        num = 1.5 * (1.2 * (ir - g) - 2.5 * (r - g))
        sr = np.sqrt(np.maximum(r, 0.0))
        inner = (2.0 * ir + 1.0) ** 2 - (6.0 * ir - 5.0 * sr) - 0.5
        den = np.sqrt(np.maximum(inner, 0.0))
        return _safe_div(num, den).astype(np.float32)
    if name == "VARI":
        return _safe_div(g - r, g + r - b).astype(np.float32)
    if name == "TGI":
        return (((120.0 * (r - b)) - (190.0 * (r - g))) / 2.0).astype(np.float32)
    if name == "KNDVI":
        # EO Browser / Sentinel Hub: tanh(((nir-red)/(nir+red))^2)
        ndvi = _safe_div(ir - r, ir + r)
        return np.tanh(np.square(ndvi)).astype(np.float32)
    if name == "GIYI":
        # Green–Yellow (custom): (GreenI − Yellow) / (GreenI + Yellow); PS3=Green I, PS5=Yellow.
        green_i = bgri["green_i"]
        yel = bgri["yellow"]
        return _safe_div(green_i - yel, green_i + yel).astype(np.float32)
    if name == "MCARI":
        # [(RedEdge − Red) − 0.2(RedEdge − Green)] · (RedEdge / Red); PS7≈S2 B5, PS6≈B4, PS4≈B3.
        red_e = bgri["red_edge"]
        t1 = (red_e - r) - 0.2 * (red_e - g)
        t2 = red_e / (r + EPS)
        return (t1 * t2).astype(np.float32)
    raise ValueError(f"Índice PS no soportado: {index_name}")


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
    *,
    pipeline_variant: str = "s2",
) -> np.ndarray:
    from app.services.preprocess_pipeline_variant import normalize_pipeline_variant

    if normalize_pipeline_variant(pipeline_variant) == "ps":
        bgri, _ = read_planet_eight_bands_bgri(tif_path)
        return compute_ps_index_arrays(bgri, index_name)
    bands, _ = read_six_bands_aligned(tif_path)
    return compute_index_arrays(bands, index_name)


def build_normalized_index_volumes_for_paths(
    scene_paths: list[Path],
    index_list: tuple[str, ...],
    *,
    pipeline_variant: str = "s2",
) -> tuple[dict[str, np.ndarray], dict]:
    """
    Por cada escena: lee 6 bandas, calcula cada índice y normaliza min-max por escena.
    Apila en un volumen (T,H,W) por índice; remuestrea a la rejilla de la **primera** escena si hace falta.

    Retorna ``(stacked_by_index, ref_profile)`` con ``stacked_by_index[ix].shape == (T, H, W)``.
    """
    if not scene_paths:
        raise ValueError("scene_paths vacío")
    from app.services.preprocess_pipeline_variant import normalize_pipeline_variant

    vols: dict[str, list[np.ndarray]] = {ix: [] for ix in index_list}
    ref_profile: dict | None = None
    pv = normalize_pipeline_variant(pipeline_variant)

    for t, path in enumerate(scene_paths):
        if pv == "ps":
            _, profile = read_planet_eight_bands_bgri(path)
        else:
            _, profile = read_six_bands_aligned(path)
        if t == 0:
            ref_profile = profile
        assert ref_profile is not None
        rh = int(ref_profile["height"])
        rw = int(ref_profile["width"])
        for ix in index_list:
            raw = process_scene_index(path, ix, pipeline_variant=pipeline_variant)
            norm = normalize_index_minmax_per_scene(raw)
            if t > 0 and norm.shape != (rh, rw):
                norm = _resample_to_match(
                    norm,
                    profile["transform"],
                    profile["crs"],
                    rh,
                    rw,
                    ref_profile["transform"],
                    ref_profile["crs"],
                )
            vols[ix].append(norm.astype(np.float32))

    stacked = {ix: np.stack(vols[ix], axis=0) for ix in index_list}
    return stacked, ref_profile


def normalize_index_minmax_per_scene(arr: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    """
    Normalización min-max **por escena** (cada banda del stack se escala de forma independiente):

        index_norm = (index - index_min) / (index_max - index_min + eps)

    Solo se usan píxeles finitos para estimar min/max; el resto permanece NaN.
    """
    a = np.asarray(arr, dtype=np.float64)
    out = np.full(a.shape, np.nan, dtype=np.float64)
    mask = np.isfinite(a)
    if not np.any(mask):
        return out.astype(np.float32)
    vals = a[mask]
    vmin = float(np.min(vals))
    vmax = float(np.max(vals))
    denom = (vmax - vmin) + eps
    out[mask] = (a[mask] - vmin) / denom
    return out.astype(np.float32)


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
_PS_COMPOSITE_STEM = re.compile(r"^PS_(\d{2})-(\d{2})-(\d{2})(?:_(\d+))?$", re.IGNORECASE)


def sort_key_from_path_or_meta(path: Path, metadata: dict | None) -> str | None:
    if metadata and metadata.get("s2_sort_key"):
        return str(metadata["s2_sort_key"])
    stem = path.stem
    pm = _PS_COMPOSITE_STEM.match(stem)
    if pm:
        d, mo, yy = int(pm.group(1)), int(pm.group(2)), int(pm.group(3))
        yfull = 2000 + yy if yy < 80 else 1900 + yy
        base = f"{yfull:04d}-{mo:02d}-{d:02d}"
        suf = pm.group(4)
        if suf:
            return f"{base}-{int(suf):04d}"
        return base
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
    if m.get("planetscope_composite"):
        try:
            with rasterio.open(fp) as src:
                return int(src.count) >= PS_INDEX_MIN_BANDS
        except Exception:
            return False
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


def is_eight_band_ps_stack_file(fp: Path, meta: dict | None) -> bool:
    """Candidato a recorte PlanetScope para índices (8 bandas, convención PS o metadatos)."""
    from app.api.v1.helpers import is_legacy_s2_zip_band_raster
    from app.services.preprocess_pipeline_variant import is_planetscope_ps_recorte_filename

    if is_legacy_s2_zip_band_raster(meta):
        return False
    try:
        with rasterio.open(fp) as src:
            if int(src.count) < PS_INDEX_MIN_BANDS:
                return False
    except Exception:
        return False
    m = meta or {}
    if m.get("planetscope_composite"):
        return True
    return is_planetscope_ps_recorte_filename(fp.name)


def read_index_stack_base_profile(tif_path: Path, *, pipeline_variant: str = "s2") -> dict:
    """Perfil GeoTIFF (una banda float32) para escribir stacks de índices; mismo raster que el pipeline."""
    from app.services.preprocess_pipeline_variant import normalize_pipeline_variant

    if normalize_pipeline_variant(pipeline_variant) == "ps":
        _, prof = read_planet_eight_bands_bgri(tif_path)
    else:
        _, prof = read_six_bands_aligned(tif_path)
    prof = prof.copy()
    prof.update(count=1, dtype="float32")
    return prof


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
    *,
    min_bands: int = 6,
) -> list[tuple[str, Path]]:
    """
    Escenas candidatas (fecha ISO sort_key, ruta TIF ≥6 bandas tipo L2A recorte). Sin duplicar rutas.
    Orden cronológico por sort_key.

    Si ``raster_layer_ids`` está definido, solo esas capas en BD; si el ``file_path`` no existe
    en disco, se intenta ``recortes_root / nombre_archivo``. Si tras eso no hay ninguna escena
    válida, se escanean ``*.tif`` en ``recortes_root`` (útil si API y worker no comparten la misma
    ruta absoluta).
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
            alt = (recortes_root / fp.name) if recortes_root.is_dir() else None
            if alt and alt.is_file():
                fp = alt
                logger.info(
                    "discover_recorte_scenes: capa %s resuelta en recortes/ por nombre (ruta BD distinta al worker): %s",
                    r.id,
                    fp.name,
                )
            else:
                logger.warning(
                    "discover_recorte_scenes: capa %s omitida (archivo inexistente en BD ni en recortes/): %s",
                    r.id,
                    r.file_path,
                )
                continue
        meta = r.raster_metadata or {}
        try:
            with rasterio.open(fp) as _src:
                nbc = int(_src.count)
        except Exception:
            continue
        if nbc < min_bands:
            logger.warning(
                "Capa raster %s omitida (requiere ≥%s bandas, hay %s): %s",
                r.id,
                min_bands,
                nbc,
                fp.name,
            )
            continue
        if not is_six_band_s2_stack_file(fp, meta):
            logger.warning("Capa raster %s omitida (no es stack L2A 6+ bandas): %s", r.id, fp.name)
            continue
        sk = sort_key_from_raster_layer(r)
        if not sk:
            continue
        by_path[fp.resolve()] = (sk, fp)

    # Sin filtro de IDs: BD + *.tif sueltos en recortes/. Con filtro pero 0 escenas válidas:
    # escanear recortes/ (p. ej. rutas absolutas de la API no montadas igual en el worker Celery).
    scan_disk = recortes_root.is_dir() and (not raster_layer_ids or len(by_path) == 0)
    if scan_disk and raster_layer_ids and len(by_path) == 0:
        logger.warning(
            "discover_recorte_scenes: ninguna capa válida con raster_layer_ids=%s; usando *.tif en %s",
            raster_layer_ids,
            recortes_root,
        )
    if scan_disk:
        for p in sorted(recortes_root.glob("*.tif")):
            if "_cog" in p.name.lower():
                continue
            if not p.is_file():
                continue
            rp = p.resolve()
            if rp in by_path:
                continue
            try:
                with rasterio.open(p) as _src:
                    n_disk = int(_src.count)
            except Exception:
                continue
            if n_disk < min_bands:
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


def discover_recorte_scenes_by_filenames(
    recortes_root: Path,
    filenames: list[str],
    *,
    min_bands: int = 6,
) -> list[tuple[str, Path]]:
    """
    Escenas por ruta relativa posix bajo ``recortes_root`` (p. ej. ``escena.tif`` o ``sub/a.tif``).
    Sin depender de capas en BD; requiere ``*.tif`` (no COG), ≥``min_bands`` (6 L2A, 8 Planet PS).
    """
    root = recortes_root.resolve()
    if not root.is_dir():
        return []
    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for raw in filenames:
        s = str(raw).strip().replace("\\", "/")
        if not s or ".." in s.split("/"):
            logger.warning("discover_recorte_scenes_by_filenames: ruta omitida: %s", raw)
            continue
        rel = Path(s)
        if rel.is_absolute():
            continue
        p = (root / rel).resolve()
        if not p.is_file() or not p.is_relative_to(root):
            logger.warning("discover_recorte_scenes_by_filenames: no existe o fuera de recortes/: %s", s)
            continue
        if "_cog" in p.name.lower():
            continue
        key = p.as_posix()
        if key in seen:
            continue
        seen.add(key)
        try:
            with rasterio.open(p) as src:
                if int(src.count) < min_bands:
                    logger.warning(
                        "discover_recorte_scenes_by_filenames: <%s bandas: %s", min_bands, s
                    )
                    continue
        except Exception:
            logger.warning("discover_recorte_scenes_by_filenames: no se pudo abrir: %s", s)
            continue
        sk = sort_key_from_path_or_meta(p, None)
        if not sk:
            try:
                sk = datetime.fromtimestamp(p.stat().st_mtime).date().isoformat()
            except OSError:
                sk = "1900-01-01"
        out.append((sk, p))
    return sorted(out, key=lambda t: (t[0], str(t[1])))
