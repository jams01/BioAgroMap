"""Índices SAR a partir de sigma0 VV/VH (dB) en ENVI bajo ``s1prepoceso/``.

Los stacks multibanda de salida se escriben solo bajo ``tenant_*/project_*/s1indices/``
(nunca en ``indices/``, reservado a índices Sentinel-2).
"""

from __future__ import annotations

# Subcarpeta de almacenamiento bajo el proyecto (hermana de ``recortes/``, ``s1prepoceso/``, ``indices/``).
S1_SAR_STACKS_ROOT_NAME = "s1indices"

import json
import re
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

from app.api.v1.helpers import _tenant_storage


def _safe_relative_under(root: Path, p: Path) -> str | None:
    try:
        root_r = root.resolve()
        pr = p.resolve()
        rel = pr.relative_to(root_r)
        return rel.as_posix()
    except ValueError:
        return None

_S1_IW_GRDH_SCENE_DATE = re.compile(r"S1[A-Z]_IW_GRDH_1SDV_(\d{8})T", re.IGNORECASE)

# ENVI/SNAP sigma0 en dB (misma carpeta ``*.data`` por escena)
VV_NAME = "Sigma0_VV_db.img"  # VV
VH_NAME = "Sigma0_VH_db.img"  # VH

# Claves de índice (carpeta y API) ↔ cálculo interno
S1_SAR_INDEX_KEYS: tuple[str, ...] = ("RVI", "RFDI", "VV_VH", "VH_VV", "NRPB")


def sort_key_from_s1_prep_path(path: Path) -> str:
    text = "/".join(path.parts)
    m = _S1_IW_GRDH_SCENE_DATE.search(text)
    if m:
        ymd = m.group(1)
        return f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
    return "1900-01-01"


def discover_s1_prep_sar_scenes(tenant_id: int, project_id: int) -> list[dict]:
    """
    Escenas con VV+VH en la misma carpeta ``*.data`` bajo ``s1prepoceso/``.
    Cada ítem: ``scene_vv_relpath``, ``scene_vh_relpath``, ``sort_key`` (ISO).
    """
    root = _tenant_storage(tenant_id, project_id, "s1prepoceso")
    if not root.is_dir():
        return []

    by_vv: dict[str, Path] = {}
    for p in root.rglob(VV_NAME):
        if not p.is_file():
            continue
        rel = _safe_relative_under(root, p)
        if rel:
            by_vv[rel] = p

    items: list[dict] = []
    for vv_rel, vv_path in sorted(by_vv.items()):
        vh_path = vv_path.parent / VH_NAME
        if not vh_path.is_file():
            continue
        vh_rel = _safe_relative_under(root, vh_path)
        if vh_rel is None:
            continue
        sk = sort_key_from_s1_prep_path(vv_path)
        items.append(
            {
                "scene_vv_relpath": vv_rel,
                "scene_vh_relpath": vh_rel,
                "sort_key": sk,
            }
        )
    items.sort(key=lambda x: (x["sort_key"], x["scene_vv_relpath"]))
    return items


def normalize_s1_sar_indices_requested(raw: list[str]) -> list[str]:
    """Expande TODOS; orden estable RVI, RFDI, VV_VH, VH_VV, NRPB."""
    out: list[str] = []
    for x in raw or []:
        u = str(x).strip().upper().replace("/", "_")
        if u == "TODOS":
            return list(S1_SAR_INDEX_KEYS)
        if u in S1_SAR_INDEX_KEYS and u not in out:
            out.append(u)
    return out


def _db_to_linear(db: np.ndarray) -> np.ndarray:
    x = db.astype(np.float64, copy=False)
    fin = np.isfinite(x)
    y = np.full_like(x, np.nan, dtype=np.float64)
    y[fin] = np.power(10.0, np.clip(x[fin], -50.0, 50.0) / 10.0)
    return y


def compute_sar_index_array(vv_lin: np.ndarray, vh_lin: np.ndarray, index_key: str) -> np.ndarray:
    """Índices en potencia lineal (sigma0)."""
    eps = 1e-20
    vv = np.nan_to_num(vv_lin, nan=0.0, posinf=0.0, neginf=0.0)
    vh = np.nan_to_num(vh_lin, nan=0.0, posinf=0.0, neginf=0.0)
    vv = np.maximum(vv, 0.0)
    vh = np.maximum(vh, 0.0)

    if index_key == "RVI":
        return (4.0 * vh / (vh + vv + eps)).astype(np.float32)
    if index_key == "RFDI":
        return ((vv - vh) / (vv + vh + eps)).astype(np.float32)
    if index_key == "VV_VH":
        return (vv / (vh + eps)).astype(np.float32)
    if index_key == "VH_VV":
        return (vh / (vv + eps)).astype(np.float32)
    if index_key == "NRPB":
        return ((vh - vv) / (vh + vv + eps)).astype(np.float32)
    raise ValueError(f"Índice SAR desconocido: {index_key}")


def read_vv_vh_pair_aligned(vv_path: Path, vh_path: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """
    Lee VV y VH en dB; alinea VH a la rejilla de VV si hace falta (reproyección vecino).
    Retorna (vv_lin, vh_lin, profile) con profile listo para una banda float32.
    """
    with rasterio.open(vv_path) as src_vv, rasterio.open(vh_path) as src_vh:
        vv_db = src_vv.read(1).astype(np.float64)
        prof = src_vv.profile.copy()
        transform = src_vv.transform
        crs = src_vv.crs
        h, w = src_vv.height, src_vv.width
        vh_db = src_vh.read(1).astype(np.float64)
        vh_h, vh_w = src_vh.height, src_vh.width
        vh_tf = src_vh.transform
        vh_crs = src_vh.crs

    if vh_db.shape == vv_db.shape == (h, w):
        vh_use = vh_db
    else:
        vh_use = np.empty((h, w), dtype=np.float64)
        vh_use.fill(np.nan)
        reproject(
            source=vh_db,
            destination=vh_use,
            src_transform=vh_tf,
            src_crs=vh_crs,
            dst_transform=transform,
            dst_crs=crs,
            resampling=Resampling.nearest,
        )

    vv_lin = _db_to_linear(vv_db)
    vh_lin = _db_to_linear(vh_use)
    prof.update(count=1, dtype="float32", nodata=None)
    return vv_lin, vh_lin, prof


def write_s1_sar_multiband_stack(
    out_path: Path,
    bands_data: list[np.ndarray],
    base_profile: dict,
    index_name: str,
    scene_dates: list[str],
) -> None:
    """Misma convención que stacks S2 (BAND_DATES_JSON, descripciones por banda)."""
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
        "s1_sar_index_stack": "1",
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.update_tags(**meta)
        for i, (arr, d, dc) in enumerate(zip(bands_data, scene_dates, dates_compact), start=1):
            dst.write(arr.astype(np.float32), i)
            dst.set_band_description(i, f"{index_name}_{dc}")
