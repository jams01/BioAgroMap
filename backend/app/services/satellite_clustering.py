"""
Clustering espacial (KMeans/codo, GMM) sobre stacks de índices y recortes multibanda Sentinel-2.
Diseñado para ejecutar un dataset a la vez y usar muestreo para imágenes grandes.
"""

from __future__ import annotations

import base64
import io
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
import rasterio
from rasterio.windows import Window
from sklearn.cluster import KMeans
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

logger = logging.getLogger(__name__)

INDEX_KEYS = ("NDVI", "EVI", "NDWI", "CIre", "MCARI")

# Predicción en una sola lectura si cabe en RAM (~180 MB float32 + trabajo).
_MAX_FULL_GRID_FLOATS = 45_000_000


def _safe_key_from_stem(stem: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_")
    return s[:100] if s else "recorte"


def clear_cluster_gmm_dir(out_dir: Path) -> tuple[int, str]:
    """
    Elimina todo el contenido de ``cluster_gmm/`` antes de una nueva corrida GMM.
    Devuelve ``(n_eliminados, ruta_absoluta)``.
    """
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    removed = 0
    for child in list(out_dir.iterdir()):
        try:
            if child.is_file():
                child.unlink()
                removed += 1
            elif child.is_dir():
                shutil.rmtree(child)
                removed += 1
        except OSError as exc:
            logger.warning("No se pudo eliminar %s: %s", child, exc)
    logger.info("cluster_gmm vaciado: %s elemento(s) eliminado(s) en %s", removed, out_dir)
    return removed, str(out_dir)


def _date_dd_mm_yyyy_for_multiband_output(path: Path) -> str:
    """
    Fecha para nombre de salida ``DD-MM-YYYY`` (seguro en nombres de archivo).
    Intenta extraerla del nombre del archivo (YYYYMMDD o ISO); si no, usa mtime.
    """
    s = path.stem
    m = re.search(r"(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    try:
        ts = path.stat().st_mtime
    except OSError:
        ts = 0.0
    return datetime.fromtimestamp(ts).strftime("%d-%m-%Y")


def multiband_gmm_output_filename(path: Path, k_used: int) -> str:
    """``DD-MM-YYYY_GMM_K{k}.tif`` para recortes de 6+ bandas (sin ``/`` en el nombre)."""
    d = _date_dd_mm_yyyy_for_multiband_output(path)
    return f"{d}_GMM_K{k_used}.tif"


def _unique_dest_path(out_dir: Path, filename: str) -> Path:
    """Si ya existe ``filename`` en ``out_dir``, añade ``_1``, ``_2``, … antes de ``.tif``."""
    dest = out_dir / filename
    if not dest.exists():
        return dest
    stem = Path(filename).stem
    suf = Path(filename).suffix
    n = 1
    while True:
        alt = out_dir / f"{stem}_{n}{suf}"
        if not alt.exists():
            return alt
        n += 1


def discover_cluster_datasets(recortes_root: Path, indices_root: Path) -> list[dict[str, Any]]:
    """
    Índices: un GeoTIFF reciente por carpeta (NDVI, EVI, …).
    Recortes: **todos** los ``.tif`` en ``recortes/`` con al menos 6 bandas (excluye COG auxiliares).
    Orden: primero índices, luego recortes por nombre de archivo.
    """
    out: list[dict[str, Any]] = []
    for name in INDEX_KEYS:
        d = indices_root / name
        if not d.is_dir():
            continue
        tifs = [p for p in d.glob("*.tif") if p.is_file()]
        if not tifs:
            continue
        best = max(tifs, key=lambda p: p.stat().st_mtime)
        out.append({"key": name, "kind": "index", "path": str(best), "label": f"Índice {name}"})

    if recortes_root.is_dir():
        seen_keys: set[str] = set()
        paths = sorted(recortes_root.glob("*.tif"), key=lambda p: p.name.lower())
        for p in paths:
            if "_cog" in p.name.lower():
                continue
            try:
                with rasterio.open(p) as src:
                    nband = int(src.count)
            except Exception as exc:
                logger.debug("Cluster: omitiendo %s (%s)", p.name, exc)
                continue
            if nband < 6:
                continue
            base = _safe_key_from_stem(p.stem)
            key = f"recorte_{base}"
            n = 0
            while key in seen_keys:
                n += 1
                key = f"recorte_{base}_{n}"
            seen_keys.add(key)
            out.append(
                {
                    "key": key,
                    "kind": "multiband",
                    "path": str(p.resolve()),
                    "label": f"Recorte 6 bandas · {p.name}",
                }
            )
        logger.info(
            "Cluster: %s dataset(s) índice + %s recorte(s) 6+ bandas en recortes/",
            len([x for x in out if x["kind"] == "index"]),
            len([x for x in out if x["kind"] == "multiband"]),
        )
    return out


def _read_array_nan_nodata(src: Any, window: Optional[Window] = None) -> np.ndarray:
    """Lee (C,H,W) float32; píxeles nodata de GDAL → NaN (coherente con stacks que ya usan NaN)."""
    if window is None:
        arr = src.read(masked=True)
    else:
        arr = src.read(masked=True, window=window)
    if isinstance(arr, np.ma.MaskedArray):
        return arr.filled(np.nan).astype(np.float32)
    return arr.astype(np.float32)


def _read_raster_features(path: Path) -> tuple[np.ndarray, dict[str, Any]]:
    """Lee todas las bandas como (C,H,W) float32."""
    with rasterio.open(path) as src:
        if src.count < 1:
            raise ValueError(f"Sin bandas: {path}")
        data = _read_array_nan_nodata(src)
        meta = {
            "transform": src.transform,
            "crs": src.crs,
            "width": src.width,
            "height": src.height,
            "count": src.count,
            "profile": src.profile.copy(),
        }
    return data, meta


def _per_band_nan_medians(data: np.ndarray) -> np.ndarray:
    """Mediana por banda (ignora NaN) para imputar huecos entre fechas / divisiones inválidas."""
    c = data.shape[0]
    flat = data.reshape(c, -1)
    med = np.zeros(c, dtype=np.float64)
    for i in range(c):
        col = flat[i]
        fin = col[np.isfinite(col)]
        med[i] = float(np.median(fin)) if fin.size > 0 else 0.0
    return med.astype(np.float32)


def _fill_flat_with_medians(
    flat: np.ndarray, medians: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """
    Imputa NaN/inf por ``medians`` (una por banda).
    Devuelve (flat_rellenado, máscara todo_inválido) donde todo_inválido = todas las bandas no finitas antes de rellenar.
    """
    c = flat.shape[1]
    if medians.shape[0] != c:
        raise ValueError("medians debe tener una entrada por banda")
    med_row = medians[np.newaxis, :]
    before_ok = np.isfinite(flat)
    all_bad = ~np.any(before_ok, axis=1)
    filled = np.where(before_ok, flat, med_row)
    filled = np.where(np.isfinite(filled), filled, med_row)
    return filled, all_bad


def prepare_training_matrix(
    path: Path,
    max_samples: int = 50_000,
    random_state: int = 42,
) -> tuple[np.ndarray, StandardScaler, np.ndarray, dict[str, Any]]:
    """
    Construye matriz (n_samples, n_features).
    Los NaN por escena (stacks multifecha) se imputan con la mediana por banda para no dejar
    casi sin píxeles la intersección ``todas las fechas válidas``.
    Solo se excluyen píxeles con **todas** las bandas no finitas.
    """
    data, meta = _read_raster_features(path)
    c, h, w = data.shape
    medians = _per_band_nan_medians(data)
    meta["band_fill_medians"] = medians
    flat = data.reshape(c, h * w).T  # (n_pix, n_features)
    flat_filled, all_bad = _fill_flat_with_medians(flat, medians)
    valid = ~all_bad
    X = flat_filled[valid]
    if X.size == 0:
        raise ValueError(f"Sin píxeles válidos (todas las bandas NaN/inf): {path}")

    n_pix_valid = int(valid.sum())
    n_pix = int(h * w)
    logger.info(
        "Muestra entrenamiento %s: píxeles usados %s / %s (%.2f%% tras imputación por banda)",
        path.name,
        n_pix_valid,
        n_pix,
        100.0 * n_pix_valid / max(n_pix, 1),
    )

    rng = np.random.default_rng(random_state)
    n = X.shape[0]
    if n > max_samples:
        idx = rng.choice(n, size=max_samples, replace=False)
        X = X[idx]
        logger.info("Submuestreo %s → %s píxeles para entrenamiento", n, max_samples)

    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)
    return Xs, scaler, valid, meta


def compute_elbow_inertias(
    X_scaled: np.ndarray,
    k_min: int,
    k_max: int,
    random_state: int = 42,
) -> tuple[list[int], list[float]]:
    """Inercia KMeans para K = k_min..k_max (inclusive)."""
    ks = list(range(max(1, k_min), min(k_max, 50) + 1))
    inertias: list[float] = []
    for k in ks:
        km = KMeans(n_clusters=k, random_state=random_state, n_init=5, max_iter=200)
        km.fit(X_scaled)
        inertias.append(float(km.inertia_))
    return ks, inertias


def suggest_k_elbow(ks: list[int], inertias: list[float]) -> int:
    """Codo automático: kneed si está disponible; si no, heurística por pendiente."""
    if len(ks) < 2:
        return ks[0] if ks else 3
    try:
        from kneed import KneeLocator

        kn = KneeLocator(
            ks,
            inertias,
            curve="convex",
            direction="decreasing",
        )
        e = kn.elbow
        if e is not None:
            return int(e)
    except Exception as exc:
        logger.warning("kneed no disponible o falló (%s); usando heurística", exc)

    # Segunda diferencia aproximada (máximo cambio de pendiente)
    y = np.array(inertias, dtype=np.float64)
    d1 = np.diff(y)
    d2 = np.diff(d1)
    if len(d2) == 0:
        return int(ks[len(ks) // 2])
    j = int(np.argmax(np.abs(d2))) + 1
    return int(ks[min(j + 1, len(ks) - 1)])


def plot_elbow_png(ks: list[int], inertias: list[float], title: str) -> str:
    """PNG base64 (matplotlib) del método del codo."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(5, 3.5), dpi=110)
    ax.plot(ks, inertias, "o-", color="#2d6cdf")
    ax.set_xlabel("Número de clusters (K)")
    ax.set_ylabel("Inercia (WCSS)")
    ax.set_title(title)
    ax.grid(True, alpha=0.3)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


def run_gmm_fit(
    X_scaled: np.ndarray,
    n_components: int,
    random_state: int = 42,
) -> GaussianMixture:
    gmm = GaussianMixture(
        n_components=n_components,
        covariance_type="full",
        random_state=random_state,
        max_iter=200,
        n_init=2,
    )
    gmm.fit(X_scaled)
    return gmm


def _labels_to_rgb_preview(labels_2d: np.ndarray, nodata: int = -1) -> np.ndarray:
    """Mapa de etiquetas → RGB uint8 (tab20; sin datos gris oscuro, no negro puro)."""
    h, w = labels_2d.shape
    uniq = np.unique(labels_2d[labels_2d >= 0])
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    cmap = plt.get_cmap("tab20")
    out = np.full((h, w, 3), 40, dtype=np.uint8)  # fondo nodata gris oscuro
    for u in uniq:
        mask = labels_2d == u
        rgba = cmap(int(u) % 20)
        out[mask] = (np.array(rgba[:3]) * 255).astype(np.uint8)
    if nodata < 0:
        out[labels_2d < 0] = (40, 40, 40)
    return out


def plot_cluster_map_png(labels: np.ndarray, title: str) -> str:
    """PNG base64 de mapa categórico (baja resolución si hace falta)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    h, w = labels.shape
    max_side = 900
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        from PIL import Image

        rgb = _labels_to_rgb_preview(labels)
        im = Image.fromarray(rgb)
        nh, nw = int(h * scale), int(w * scale)
        im = im.resize((nw, nh), Image.Resampling.NEAREST)
        rgb = np.array(im)
    else:
        rgb = _labels_to_rgb_preview(labels)

    fig, ax = plt.subplots(figsize=(6, 5), dpi=100, facecolor="#1a1a1a")
    ax.set_facecolor("#1a1a1a")
    ax.imshow(rgb)
    ax.set_title(title, color="w", fontsize=11)
    ax.axis("off")
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0.08, facecolor="#1a1a1a")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")


def predict_gmm_full_raster(
    path: Path,
    gmm: GaussianMixture,
    scaler: StandardScaler,
    meta: dict[str, Any],
    output_path: Path,
    block_size: int = 512,
) -> np.ndarray:
    """
    Predice etiquetas por píxel. Preferimos **una sola lectura** (igual que el entrenamiento)
    si el raster cabe en memoria; si no, **franjas horizontales de ancho completo** (evita
    errores de mosaico 2D). Usa ``meta['band_fill_medians']``.
    """
    h, w = int(meta["height"]), int(meta["width"])
    profile = meta["profile"].copy()
    profile.update(dtype="int16", count=1, nodata=-1, compress="lzw", tiled=True)
    labels_full = np.full((h, w), -1, dtype=np.int16)

    with rasterio.open(path) as src:
        if int(src.height) != h or int(src.width) != w:
            logger.warning(
                "Ajustando dimensiones meta (%s×%s) al raster (%s×%s)",
                w,
                h,
                src.width,
                src.height,
            )
            h, w = int(src.height), int(src.width)
            labels_full = np.full((h, w), -1, dtype=np.int16)

        raw_med = meta.get("band_fill_medians")
        medians = (
            np.asarray(raw_med, dtype=np.float32).reshape(-1)
            if raw_med is not None
            else np.array([], dtype=np.float32)
        )
        n_cells = h * w * int(src.count)
        if medians.size != src.count:
            if n_cells <= _MAX_FULL_GRID_FLOATS:
                logger.warning("Recalculando medianas desde raster completo: %s", path.name)
                data_once = _read_array_nan_nodata(src)
                medians = _per_band_nan_medians(data_once)
            else:
                logger.error(
                    "medianas por banda no coinciden con %s bandas y el raster es demasiado grande para releer; "
                    "re-ejecuta el codo/GMM.",
                    src.count,
                )
                medians = np.zeros(src.count, dtype=np.float32)

        def _apply_block(flat: np.ndarray) -> np.ndarray:
            flat_filled, all_bad = _fill_flat_with_medians(flat, medians)
            n = flat.shape[0]
            out = np.full(n, -1, dtype=np.int16)
            use = ~all_bad
            if np.any(use):
                out[use] = gmm.predict(scaler.transform(flat_filled[use])).astype(np.int16)
            return out

        if n_cells <= _MAX_FULL_GRID_FLOATS:
            logger.info(
                "GMM predict: lectura completa %s×%s × %s bandas (una pasada, coherente con entrenamiento)",
                h,
                w,
                src.count,
            )
            data = _read_array_nan_nodata(src)
            c = data.shape[0]
            flat = data.reshape(c, h * w).T
            labels_full = _apply_block(flat).reshape(h, w)
        else:
            logger.info(
                "GMM predict: franjas horizontales altura=%s (ancho completo %s) — sin mosaico 2D",
                block_size,
                w,
            )
            for row0 in range(0, h, block_size):
                bh = min(block_size, h - row0)
                win = Window(0, row0, w, bh)
                data = _read_array_nan_nodata(src, win)
                _, bh2, bw2 = data.shape
                if bh2 != bh or bw2 != w:
                    raise ValueError(
                        f"Ventana raster inesperada: esperaba ({bh},{w}), leí ({bh2},{bw2})"
                    )
                flat = data.reshape(data.shape[0], bh * w).T
                lab_row = _apply_block(flat).reshape(bh, w)
                labels_full[row0 : row0 + bh, :] = lab_row

    n_ok = int(np.sum(labels_full >= 0))
    frac = n_ok / max(h * w, 1)
    logger.info(
        "GMM salida: %s píxeles etiquetados / %s (%.2f %%)",
        n_ok,
        h * w,
        100.0 * frac,
    )
    if frac < 0.05:
        logger.warning(
            "Menos del 5%% del área tiene cluster; revisa NaN/nodata o que el raster sea el mismo que en el codo."
        )

    profile["height"] = h
    profile["width"] = w
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(output_path, "w", **profile) as dst:
        dst.write(labels_full.astype(np.int16), 1)
        try:
            dst.set_band_description(1, "cluster_id_gmm")
        except Exception:
            pass

    return labels_full


def run_elbow_for_dataset(
    path: Path,
    k_min: int,
    k_max: int,
    max_samples: int,
    random_state: int,
) -> dict[str, Any]:
    logger.info("Elbow: leyendo %s", path)
    Xs, scaler, _valid, meta = prepare_training_matrix(
        path, max_samples=max_samples, random_state=random_state
    )
    ks, inertias = compute_elbow_inertias(Xs, k_min, k_max, random_state=random_state)
    k_sug = suggest_k_elbow(ks, inertias)
    title = f"Codo — {path.parent.name} / {path.name}"
    png_b64 = plot_elbow_png(ks, inertias, title)
    return {
        "ks": ks,
        "inertias": inertias,
        "suggested_k": k_sug,
        "elbow_plot_png_base64": png_b64,
        "n_features": int(Xs.shape[1]),
        "n_train_pixels": int(Xs.shape[0]),
    }


def run_gmm_for_dataset(
    path: Path,
    n_components: int,
    max_samples: int,
    random_state: int,
    out_dir: Path,
    key: str,
    *,
    dataset_kind: str = "index",
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    Xs, scaler, _v, meta = prepare_training_matrix(
        path, max_samples=max_samples, random_state=random_state
    )
    n_comp = max(1, min(int(n_components), int(Xs.shape[0]), 30))
    if n_comp != n_components:
        logger.warning("Ajustando K de %s a %s (muestra entrenamiento)", n_components, n_comp)
    logger.info("GMM (K=%s): %s", n_comp, path)
    gmm = run_gmm_fit(Xs, n_components=n_comp, random_state=random_state)
    kind = (dataset_kind or "index").strip().lower()
    if kind == "multiband":
        dest = _unique_dest_path(out_dir, multiband_gmm_output_filename(path, n_comp))
    else:
        dest = out_dir / f"{key}_gmm_k{n_comp}.tif"
    labels_full = predict_gmm_full_raster(path, gmm, scaler, meta, dest)

    step = max(1, max(labels_full.shape) // 400)
    small = labels_full[::step, ::step]
    prev_b64 = plot_cluster_map_png(small, f"{key} — GMM K={n_comp}")
    labeled_fraction = float(np.mean(labels_full >= 0))

    return {
        "output_path": str(dest.resolve()),
        "output_basename": dest.name,
        "dataset_kind_used": kind,
        "preview_png_base64": prev_b64,
        "shape": list(labels_full.shape),
        "k_used": n_comp,
        "labeled_fraction": labeled_fraction,
    }


def plot_dashboard_grid_png(items: list[tuple[str, str]]) -> str:
    """``items``: (título, preview_png_base64). Una sola figura tipo panel."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    if not items:
        return ""
    n = len(items)
    cols = min(3, n)
    rows = (n + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 3.8 * rows), dpi=100)
    ax_list = [axes] if n == 1 else list(np.array(axes).flatten())
    for ax, (title, b64png) in zip(ax_list, items):
        ax.axis("off")
        ax.set_title(title, fontsize=10)
        raw = base64.b64decode(b64png)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        ax.imshow(np.array(im))
    for j in range(len(items), len(ax_list)):
        ax_list[j].axis("off")
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("ascii")
