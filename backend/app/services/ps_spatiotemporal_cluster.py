"""
Clustering espacio-temporal resumido sobre stacks multibanda de índices PlanetScope (indecesPS/).

Flujo: estadísticas por píxel en el tiempo → stack de features → StandardScaler → KMeans → mapa de etiquetas.

Presets:
  smart1 — NDVI, NDRE, NDWI, VARI.
  smart2 — EVI, NDRE, NDWI, VARI.
  smart3 — KNDVI, MCARI, NDWI, VARI.
"""

from __future__ import annotations

import io
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

# Compat: subcarpeta del preset por defecto (smart1).
PS_ST_CLUSTER_SUBDIR = "ps_st_cluster"

# Límite orientativo para evitar OOM (T*H*W floats por stack × 4 stacks).
_MAX_STACK_FLOATS = 120_000_000

N_FEATURE_BANDS = 7


@dataclass(frozen=True)
class PsStClusterPreset:
    id: str
    output_subdir: str
    required_keys: tuple[str, ...]
    """Índice del que se calculan mean, std y min temporal."""
    primary_key: str
    """Índice del que solo se usa la media temporal (banda 3 del stack de features)."""
    secondary_key: str


PRESETS: dict[str, PsStClusterPreset] = {
    "smart1": PsStClusterPreset(
        id="smart1",
        output_subdir="ps_st_cluster",
        required_keys=("NDVI", "NDRE", "NDWI", "VARI"),
        primary_key="NDVI",
        secondary_key="NDRE",
    ),
    "smart2": PsStClusterPreset(
        id="smart2",
        output_subdir="ps_st_cluster_smart2",
        required_keys=("EVI", "NDRE", "NDWI", "VARI"),
        primary_key="EVI",
        secondary_key="NDRE",
    ),
    "smart3": PsStClusterPreset(
        id="smart3",
        output_subdir="ps_st_cluster_smart3",
        required_keys=("KNDVI", "MCARI", "NDWI", "VARI"),
        primary_key="KNDVI",
        secondary_key="MCARI",
    ),
}


def get_preset(name: str) -> PsStClusterPreset:
    k = (name or "smart1").strip().lower()
    if k not in PRESETS:
        allowed = ", ".join(sorted(PRESETS.keys()))
        raise ValueError(f"preset inválido: {name!r}. Usa uno de: {allowed}.")
    return PRESETS[k]


# Colores discretos para vista previa (hasta 16 clusters).
_PREVIEW_PALETTE: list[tuple[int, int, int]] = [
    (228, 26, 28),
    (55, 126, 184),
    (77, 175, 74),
    (152, 78, 163),
    (255, 127, 0),
    (255, 255, 51),
    (166, 86, 40),
    (247, 129, 191),
    (141, 211, 199),
    (255, 255, 179),
    (251, 128, 114),
    (128, 177, 211),
    (253, 180, 98),
    (179, 222, 105),
    (252, 205, 229),
    (217, 217, 217),
]


def _pick_best_stack_tif(index_root: Path, folder: str) -> Path | None:
    key_dir = index_root / folder
    if not key_dir.is_dir():
        return None
    best: Path | None = None
    best_b = -1
    for p in sorted(key_dir.rglob("*.tif")):
        if "_cog" in p.name.lower():
            continue
        if not p.is_file():
            continue
        try:
            with rasterio.open(p) as src:
                nb = int(src.count)
        except Exception:
            continue
        if nb > best_b:
            best_b = nb
            best = p
    return best


def discover_ps_index_stacks(index_root: Path, required_keys: tuple[str, ...]) -> dict[str, Path]:
    """Resuelve el mejor .tif multibanda por índice bajo indecesPS/<KEY>/."""
    out: dict[str, Path] = {}
    for key in required_keys:
        p = _pick_best_stack_tif(index_root, key)
        if p is not None:
            out[key] = p
    return out


def _read_stack_thw(path: Path) -> tuple[np.ndarray, rasterio.profiles.Profile]:
    """Lee stack completo como (T, H, W) float32; NaN en nodata o no finitos."""
    with rasterio.open(path) as src:
        prof = src.profile
        t, h, w = int(src.count), int(src.height), int(src.width)
        if t * h * w > _MAX_STACK_FLOATS:
            raise ValueError(
                f"Stack demasiado grande ({t}×{h}×{w}). Reduce extensión o resolución del recorte."
            )
        arr = src.read().astype(np.float32)
        nodata = src.nodatavals
        for i in range(t):
            band = arr[i]
            nd = nodata[i] if nodata and i < len(nodata) else None
            if nd is not None and np.isfinite(nd):
                band = band.copy()
                band[band == float(nd)] = np.nan
                arr[i] = band
            arr[i] = np.where(np.isfinite(arr[i]), arr[i], np.nan)
    return arr, prof


def _validate_same_grid(
    paths: dict[str, Path],
    shapes: dict[str, tuple[int, int, int]],
    profiles: dict[str, Any],
    required_keys: tuple[str, ...],
) -> None:
    ref = None
    ref_crs = None
    for k in required_keys:
        if k not in paths:
            continue
        shp = shapes[k]
        if ref is None:
            ref = shp
            ref_crs = profiles[k]["crs"]
        else:
            if shp != ref:
                raise ValueError(
                    f"Dimensiones distintas: {k} {shp} vs referencia {ref}. "
                    "Todos los stacks deben tener las mismas bandas (fechas) y tamaño."
                )
            if profiles[k]["crs"] != ref_crs:
                raise ValueError(f"CRS distinto en {k} respecto al stack de referencia.")


def build_feature_stack(
    stacks: dict[str, np.ndarray],
    primary_key: str,
    secondary_key: str,
) -> tuple[np.ndarray, list[str]]:
    """
    (7, H, W): {primary}_mean/std/min, {secondary}_mean, NDWI_mean, VARI_mean, NDWI_std.
    """
    pri = stacks[primary_key]
    sec = stacks[secondary_key]
    ndwi = stacks["NDWI"]
    vari = stacks["VARI"]
    pk = primary_key
    sk = secondary_key
    f1 = np.nanmean(pri, axis=0)
    f2 = np.nanstd(pri, axis=0, ddof=0)
    f3 = np.nanmean(sec, axis=0)
    f4 = np.nanmean(ndwi, axis=0)
    f5 = np.nanmean(vari, axis=0)
    f6 = np.nanmin(pri, axis=0)
    f7 = np.nanstd(ndwi, axis=0, ddof=0)
    names = [
        f"{pk}_mean",
        f"{pk}_std",
        f"{sk}_mean",
        "NDWI_mean",
        "VARI_mean",
        f"{pk}_min",
        "NDWI_std",
    ]
    feat = np.stack([f1, f2, f3, f4, f5, f6, f7], axis=0).astype(np.float32)
    return feat, names


def run_ps_spatiotemporal_cluster(
    index_root: Path,
    out_dir: Path,
    *,
    preset_id: str = "smart1",
    n_clusters: int = 4,
    random_state: int = 42,
) -> dict[str, Any]:
    """
    Ejecuta pipeline completo. Escribe ``features_stack.tif``, ``final_cluster_map.tif`` y ``meta.json``.
    """
    preset = get_preset(preset_id)
    if n_clusters < 2 or n_clusters > 32:
        raise ValueError("n_clusters debe estar entre 2 y 32.")

    discovered = discover_ps_index_stacks(index_root, preset.required_keys)
    missing = [k for k in preset.required_keys if k not in discovered]
    if missing:
        raise ValueError(
            "Faltan stacks multibanda en indecesPS para: "
            + ", ".join(missing)
            + ". Ejecuta antes la estimación de índices PlanetScope (incl. "
            + ", ".join(missing)
            + ")."
        )

    paths = {k: discovered[k] for k in preset.required_keys}
    stacks_thw: dict[str, np.ndarray] = {}
    profiles: dict[str, Any] = {}
    shapes: dict[str, tuple[int, int, int]] = {}

    for key, p in paths.items():
        arr, prof = _read_stack_thw(p)
        stacks_thw[key] = arr
        profiles[key] = prof
        shapes[key] = (arr.shape[0], arr.shape[1], arr.shape[2])

    _validate_same_grid(paths, shapes, profiles, preset.required_keys)
    ref_key = preset.primary_key
    ref_prof = profiles[ref_key].copy()
    H, W = stacks_thw[ref_key].shape[1], stacks_thw[ref_key].shape[2]

    if preset.secondary_key == preset.primary_key:
        raise ValueError("secondary_key no puede coincidir con primary_key.")
    features, feature_names = build_feature_stack(
        stacks_thw,
        preset.primary_key,
        preset.secondary_key,
    )
    valid = np.all(np.isfinite(features), axis=0)
    n_valid = int(np.sum(valid))
    if n_valid < n_clusters * 50:
        raise ValueError(
            f"Muy pocos píxeles válidos ({n_valid}) para K={n_clusters}. Revisa nodata y solape de stacks."
        )

    X = features[:, valid].T.astype(np.float64)
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    km = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10)
    labels_flat = km.fit_predict(Xs)

    labels_map = np.full((H, W), 255, dtype=np.uint8)
    labels_map[valid] = labels_flat.astype(np.uint8)

    out_dir.mkdir(parents=True, exist_ok=True)

    feat_path = out_dir / "features_stack.tif"
    prof_f = ref_prof.copy()
    prof_f.update(count=N_FEATURE_BANDS, dtype=rasterio.float32, nodata=None, compress="deflate")
    with rasterio.open(feat_path, "w", **prof_f) as dst:
        for b in range(N_FEATURE_BANDS):
            dst.write(features[b], b + 1)
        dst.update_tags(
            DESCRIPTION=",".join(feature_names),
            PRESET=preset.id,
        )

    map_path = out_dir / "final_cluster_map.tif"
    prof_m = ref_prof.copy()
    prof_m.update(count=1, dtype=rasterio.uint8, nodata=255, compress="deflate")
    with rasterio.open(map_path, "w", **prof_m) as dst:
        dst.write(labels_map, 1)
        dst.update_tags(
            CLUSTER_N=str(n_clusters),
            N_VALID_PIXELS=str(n_valid),
            PRESET=preset.id,
        )

    meta = {
        "preset": preset.id,
        "n_clusters": n_clusters,
        "random_state": random_state,
        "n_features": N_FEATURE_BANDS,
        "feature_names": feature_names,
        "primary_index": preset.primary_key,
        "secondary_index": preset.secondary_key,
        "required_indices": list(preset.required_keys),
        "n_valid_pixels": n_valid,
        "height": H,
        "width": W,
        "n_time_steps": shapes[ref_key][0],
        "index_stack_rel": {k: str(paths[k].relative_to(index_root)) for k in paths},
        "features_stack": "features_stack.tif",
        "final_cluster_map": "final_cluster_map.tif",
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    logger.info(
        "ps_spatiotemporal_cluster OK preset=%s project_out=%s k=%s valid=%s",
        preset.id,
        out_dir,
        n_clusters,
        n_valid,
    )
    return meta


def cluster_map_to_png(tif_path: Path, max_dim: int = 1024) -> bytes:
    """PNG RGB con colores discretos por cluster; fondo y nodata (255) en blanco."""
    with rasterio.open(tif_path) as src:
        scale = min(1.0, float(max_dim) / max(src.height, src.width))
        h = max(1, int(round(src.height * scale)))
        w = max(1, int(round(src.width * scale)))
        lab = src.read(1, out_shape=(h, w), resampling=Resampling.nearest)
    u8 = lab.astype(np.uint8)
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    rgb[:] = (255, 255, 255)
    flat = u8.ravel()
    for v in np.unique(flat):
        if v == 255:
            continue
        c = _PREVIEW_PALETTE[int(v) % len(_PREVIEW_PALETTE)]
        mask = u8 == v
        rgb[mask] = c
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def load_meta(out_dir: Path) -> dict[str, Any] | None:
    p = out_dir / "meta.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
