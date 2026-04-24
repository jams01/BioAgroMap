"""Series temporales desde stacks multibanda en ``s1indices/`` (índices SAR)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio

from app.api.v1.helpers import _tenant_storage
from app.services.s1_sar_indices import S1_SAR_INDEX_KEYS, S1_SAR_STACKS_ROOT_NAME, _safe_relative_under
from app.services.s2_vegetation_indices import _resample_to_match, normalize_index_minmax_per_scene


def _norm_iso_date(s: str) -> str:
    t = str(s).strip()
    return t[:10] if len(t) >= 10 else t


def discover_primary_s1_sar_stacks(tenant_id: int, project_id: int) -> dict[str, tuple[Path, list[str]]]:
    """
    Por cada clave en ``S1_SAR_INDEX_KEYS``, elige el GeoTIFF con más bandas bajo ``s1indices/<CLAVE>/``.
    Retorna ``clave -> (path_absoluto, fechas_por_banda_en_orden)``.
    """
    root = _tenant_storage(tenant_id, project_id, S1_SAR_STACKS_ROOT_NAME)
    if not root.is_dir():
        return {}

    candidates: dict[str, list[tuple[Path, int, list[str]]]] = {k: [] for k in S1_SAR_INDEX_KEYS}

    for p in sorted(root.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        rel = _safe_relative_under(root, p)
        if rel is None:
            continue
        parts = Path(rel).parts
        if len(parts) < 2:
            continue
        key = parts[0].strip().upper().replace("/", "_")
        if key not in candidates:
            continue
        try:
            with rasterio.open(p) as src:
                n = int(src.count)
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
        if n < 1:
            continue
        candidates[key].append((p, n, dates))

    out: dict[str, tuple[Path, list[str]]] = {}
    for key in S1_SAR_INDEX_KEYS:
        cand = candidates[key]
        if not cand:
            continue
        path, n_bands, dates = max(cand, key=lambda x: x[1])
        out[key] = (path, dates)
    return out


def intersection_sorted_dates(stacks: dict[str, tuple[Path, list[str]]]) -> list[str]:
    """Fechas presentes en **todas** las listas de bandas (normalizadas ``YYYY-MM-DD``)."""
    if len(stacks) < len(S1_SAR_INDEX_KEYS):
        return []
    sets: list[set[str]] = []
    for key in S1_SAR_INDEX_KEYS:
        if key not in stacks:
            return []
        _path, dates = stacks[key]
        sets.append({_norm_iso_date(d) for d in dates if str(d).strip()})
    if not sets:
        return []
    inter = set.intersection(*sets)
    return sorted(inter)


def band_index_for_iso(dates_in_file: list[str], want: str) -> int | None:
    w = _norm_iso_date(want)
    for i, d in enumerate(dates_in_file):
        if _norm_iso_date(d) == w:
            return i + 1
    return None


def build_normalized_sar_volumes_for_dates(
    stacks: dict[str, tuple[Path, list[str]]],
    dates_ordered: list[str],
    index_order: tuple[str, ...],
) -> tuple[dict[str, np.ndarray], dict]:
    """
    Volumen ``(T, H, W)`` por índice; ``T`` = fechas en ``dates_ordered``.
    Cada corte temporal se normaliza min-max (misma idea que recortes S2).
    """
    if not dates_ordered:
        raise ValueError("dates_ordered vacío")

    stacked: dict[str, np.ndarray] = {}
    ref_profile: dict | None = None

    for ix in index_order:
        if ix not in stacks:
            raise ValueError(f"Falta stack para índice {ix}")
        path, dates_meta = stacks[ix]
        planes: list[np.ndarray] = []
        for d in dates_ordered:
            bi = band_index_for_iso(dates_meta, d)
            if bi is None:
                raise ValueError(f"La fecha {d} no está en el stack {ix} ({path.name})")
            with rasterio.open(path) as src:
                if bi < 1 or bi > int(src.count):
                    raise ValueError(f"Banda fuera de rango en {path}: {bi}")
                arr = src.read(bi).astype(np.float32)
                profile = src.profile.copy()
            norm = normalize_index_minmax_per_scene(arr)
            if ref_profile is None:
                ref_profile = profile
                rh = int(ref_profile["height"])
                rw = int(ref_profile["width"])
                planes.append(norm.astype(np.float32))
            else:
                rh = int(ref_profile["height"])
                rw = int(ref_profile["width"])
                if norm.shape != (rh, rw):
                    norm = _resample_to_match(
                        norm.astype(np.float32),
                        profile["transform"],
                        profile["crs"],
                        rh,
                        rw,
                        ref_profile["transform"],
                        ref_profile["crs"],
                    ).astype(np.float32)
                planes.append(norm)
        stacked[ix] = np.stack(planes, axis=0)

    assert ref_profile is not None
    return stacked, ref_profile


def sample_pixel_series_from_stacks(
    stacked: dict[str, np.ndarray],
    index_list: tuple[str, ...],
    max_pixel_series: int,
    random_seed: int,
    roi_selection: dict | None = None,
) -> tuple[dict[str, list[list[float]]], int, int]:
    """
    Píxeles válidos en **todas** las fechas y **todos** los índices; muestreo aleatorio sin reemplazo.
    Retorna (series_by_index, n_sampled, n_valid_pixels).
    """
    first = stacked[index_list[0]]
    t, h, w = first.shape
    mask = np.ones((h, w), dtype=bool)
    if roi_selection:
        try:
            mask &= _roi_mask_from_selection_dict(roi_selection, h, w)
        except Exception:
            # Si el ROI llega malformado, se ignora para mantener compatibilidad.
            pass
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


def _roi_mask_for_polygon_dict(points: list[dict], h: int, w: int) -> np.ndarray:
    if len(points) < 3:
        return np.zeros((h, w), dtype=bool)
    px = np.array([float(p.get("x", 0.0)) for p in points], dtype=np.float64)
    py = np.array([float(p.get("y", 0.0)) for p in points], dtype=np.float64)
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


def _roi_mask_from_selection_dict(roi_selection: dict, h: int, w: int) -> np.ndarray:
    points = roi_selection.get("polygon_points")
    if isinstance(points, list) and len(points) >= 3:
        return _roi_mask_for_polygon_dict(points, h, w)
    x1 = float(roi_selection.get("x1", 0.0))
    y1 = float(roi_selection.get("y1", 0.0))
    x2 = float(roi_selection.get("x2", 1.0))
    y2 = float(roi_selection.get("y2", 1.0))
    c0 = int(np.floor(x1 * w))
    c1 = int(np.ceil(x2 * w))
    r0 = int(np.floor(y1 * h))
    r1 = int(np.ceil(y2 * h))
    c0 = min(max(c0, 0), w - 1)
    c1 = min(max(c1, c0 + 1), w)
    r0 = min(max(r0, 0), h - 1)
    r1 = min(max(r1, r0 + 1), h)
    roi_mask = np.zeros((h, w), dtype=bool)
    roi_mask[r0:r1, c0:c1] = True
    return roi_mask
