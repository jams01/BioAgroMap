"""
Combina bandas Sentinel-2 (L1C/L2A) en GeoTIFF.

Portado desde 0.geoagro/satellital/combine_s2_bands.py — misma lógica de lectura y apilado.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject, transform_geom
from rasterio.windows import Window, from_bounds
from shapely import from_wkt
from shapely.geometry import mapping, shape

# Presets: (bandas en orden de salida, resolución m) — usado por la API S2
PRESETS = {
    "rgb": (["B04", "B03", "B02"], 10),  # color natural
    "fcir": (["B08", "B04", "B03"], 10),  # falso color infrarrojo
    "multiband": (["B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A"], 20),
}


def read_band(path: Path) -> tuple[np.ndarray, dict]:
    """Lee una banda con rasterio; devuelve array y metadata (profile)."""
    with rasterio.open(path) as src:
        data = src.read()
        profile = src.profile.copy()
    return data, profile


def profile_for_geotiff(ref_profile: dict, count: int, dtype) -> dict:
    """Perfil para escribir GeoTIFF (no JP2)."""
    p = ref_profile.copy()
    p.update(
        driver="GTiff",
        count=count,
        dtype=dtype,
        compress="lzw",
        tiled=True,
        blockxsize=512,
        blockysize=512,
    )
    return p


def stack_bands_same_resolution(
    band_paths: list[Path], ref_profile: dict
) -> tuple[np.ndarray, dict]:
    """
    Apila varias bandas (misma resolución y tamaño) en un array (n_bands, H, W).
    ref_profile: metadata de la primera banda para el GeoTIFF de salida.
    """
    arrays = []
    for p in band_paths:
        arr, _ = read_band(p)
        arrays.append(arr)
    stack = np.concatenate(arrays, axis=0).astype(np.float32)
    out_profile = ref_profile.copy()
    out_profile.update(count=stack.shape[0], dtype=stack.dtype)
    return stack, out_profile


def window_from_wkt_on_ref(ref_path: Path, wkt: str, *, pad_px: int = 128) -> Window:
    """
    Ventana de lectura (rejilla B02/10 m) que cubre el polígono WGS84 + margen en píxeles.
    Reduce mucho el uso de RAM frente a leer el tile Sentinel completo.
    """
    geom = from_wkt(wkt)
    if not geom.is_valid:
        geom = geom.buffer(0)
    with rasterio.open(ref_path) as ref:
        gj = transform_geom("EPSG:4326", ref.crs, mapping(geom))
        minx, miny, maxx, maxy = shape(gj).bounds
        w = from_bounds(minx, miny, maxx, maxy, ref.transform)
        w = w.round_offsets().crop(ref.height, ref.width)
        col_off = max(0, int(w.col_off) - pad_px)
        row_off = max(0, int(w.row_off) - pad_px)
        width = min(ref.width - col_off, int(w.width) + 2 * pad_px)
        height = min(ref.height - row_off, int(w.height) + 2 * pad_px)
        return Window(col_off, row_off, width, height)


def read_band_window(path: Path, window: Window) -> tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        data = src.read(1, window=window).astype(np.float32)
        profile = src.profile.copy()
        profile.update(
            height=int(window.height),
            width=int(window.width),
            transform=rasterio.windows.transform(window, src.transform),
        )
    return data[np.newaxis, :, :], profile


def resample_lower_band_to_ref_window(
    src_path: Path,
    ref_path: Path,
    window: Window,
    *,
    resampling: int = Resampling.bilinear,
) -> np.ndarray:
    """Remuestrea B05/B11 a la sub-rejilla 10 m definida por `window` sobre B02 (sin cargar tile entero)."""
    with rasterio.open(ref_path) as ref:
        dst_transform = rasterio.windows.transform(window, ref.transform)
        height, width = int(window.height), int(window.width)
        dst_crs = ref.crs
    dest = np.empty((height, width), dtype=np.float32)
    with rasterio.open(src_path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=dest,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=dst_transform,
            dst_crs=dst_crs,
            resampling=resampling,
        )
    return dest[np.newaxis, :, :]


def resample_single_band_to_reference_grid(
    src_path: Path,
    ref_path: Path,
    *,
    resampling: int = Resampling.bilinear,
) -> np.ndarray:
    """
    Remuestrea una banda (p. ej. B05/B11 en 20m/60m) a la rejilla exacta de ref_path (B02 10m):
    mismo shape, transform, CRS. Devuelve (1, H, W) float32.
    """
    with rasterio.open(ref_path) as ref:
        ref_transform = ref.transform
        ref_crs = ref.crs
        height, width = ref.height, ref.width

    with rasterio.open(src_path) as src:
        src_arr = src.read(1).astype(np.float32)
        src_transform = src.transform
        src_crs = src.crs

    dest = np.empty((height, width), dtype=np.float32)
    reproject(
        source=src_arr,
        destination=dest,
        src_transform=src_transform,
        src_crs=src_crs,
        dst_transform=ref_transform,
        dst_crs=ref_crs,
        resampling=resampling,
    )
    return dest[np.newaxis, :, :]


def combine_s2_recorte_six_band(
    band_files_10m: dict[str, Path],
    band_files_lower: dict[str, Path],
    out_path: Path,
    *,
    resampling: int = Resampling.bilinear,
    crop_wkt: str | None = None,
    window_pad_px: int = 128,
) -> Path:
    """
    GeoTIFF multibanda (6) en orden: B02, B03, B04, B05 (10m), B08, B11 (10m).
    B05 y B11 se remuestrean a la grilla de B02 antes del apilado (sin clip aquí).

    Si `crop_wkt` está definido (WGS84), solo se lee la ventana que cubre el polígono (+ margen),
    evitando cargar el tile Sentinel completo en RAM (reduce OOM / SIGKILL 9).
    """
    req_10 = ("B02", "B03", "B04", "B08")
    req_lr = ("B05", "B11")
    missing_10 = [b for b in req_10 if b not in band_files_10m]
    missing_lr = [b for b in req_lr if b not in band_files_lower]
    if missing_10 or missing_lr:
        raise FileNotFoundError(
            f"Bandas faltantes: 10m {missing_10 or '—'}, R20/R60 {missing_lr or '—'}"
        )

    ref_path = band_files_10m["B02"]
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if crop_wkt:
        win = window_from_wkt_on_ref(ref_path, crop_wkt, pad_px=window_pad_px)
        arrays: list[np.ndarray] = []
        for b in ("B02", "B03", "B04"):
            arr, _ = read_band_window(band_files_10m[b], win)
            arrays.append(arr)
        arrays.append(
            resample_lower_band_to_ref_window(
                band_files_lower["B05"], ref_path, win, resampling=resampling
            )
        )
        arr_b8, _ = read_band_window(band_files_10m["B08"], win)
        arrays.append(arr_b8)
        arrays.append(
            resample_lower_band_to_ref_window(
                band_files_lower["B11"], ref_path, win, resampling=resampling
            )
        )
        stack = np.concatenate(arrays, axis=0).astype(np.float32)
        _, ref_profile = read_band_window(ref_path, win)
    else:
        arrays = []
        for b in ("B02", "B03", "B04"):
            arr, _ = read_band(band_files_10m[b])
            arrays.append(arr.astype(np.float32))
        arrays.append(
            resample_single_band_to_reference_grid(
                band_files_lower["B05"], ref_path, resampling=resampling
            )
        )
        arr_b8, _ = read_band(band_files_10m["B08"])
        arrays.append(arr_b8.astype(np.float32))
        arrays.append(
            resample_single_band_to_reference_grid(
                band_files_lower["B11"], ref_path, resampling=resampling
            )
        )
        stack = np.concatenate(arrays, axis=0).astype(np.float32)
        _, ref_profile = read_band(ref_path)

    profile = profile_for_geotiff(ref_profile, count=stack.shape[0], dtype=stack.dtype)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(stack)
    return out_path


def combine_bands_from_paths(
    band_files: dict[str, Path],
    bands: list[str],
    out_path: Path,
    scale: float = 1.0,
) -> Path:
    """
    Combina las rutas JP2 ya resueltas (p. ej. desde find_sentinel_r10_band_files)
    en el orden indicado. Misma lógica que combine_bands_from_folder del script geoagro.
    """
    missing = [b for b in bands if b not in band_files]
    if missing:
        raise FileNotFoundError(f"Bandas no encontradas: {missing}")

    paths_ordered = [band_files[b] for b in bands]
    stack, ref_profile = stack_bands_same_resolution(paths_ordered, read_band(paths_ordered[0])[1])

    if scale != 1.0:
        stack = (stack * scale).astype(np.float32)
    else:
        stack = stack.astype(np.float32)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    profile = profile_for_geotiff(ref_profile, count=len(bands), dtype=stack.dtype)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(stack)
    return out_path


# Orden de las 4 bandas en el stack unificado (bandas 1..4 del GeoTIFF) — usado en upload ZIP / composites
S2_FOUR_BAND_FILE_ORDER = ("B04", "B03", "B02", "B08")

# Orden físico estándar B02…B08 (banda 1=B02 … banda 4=B08) para un único GeoTIFF multibanda
S2_PHYSICAL_BAND_ORDER = ("B02", "B03", "B04", "B08")

# Recorte L2A: B02,B03,B04,B05 (remuestreada a 10m),B08,B11 (remuestreada a 10m)
S2_RECORTE_SIX_BAND_ORDER = ("B02", "B03", "B04", "B05", "B08", "B11")

# Vista color natural en lienzo: R=B04, G=B03, B=B02 → índices 1-based en stack B02,B03,B04,…
S2_TRUE_COLOR_RGB_BANDS_1BASED = (3, 2, 1)


def write_rgb_nir_views_from_stack(stack_path: Path, rgb_out: Path, nir_out: Path) -> None:
    """
    A partir del .tif de 4 bandas en orden B04, B03, B02, B08 (índices 0..3),
    genera dos GeoTIFF de 3 bandas solo para visualización en capas:
    - RGB: B04, B03, B02 (bandas 1–3 del stack)
    - NIR (falso color): B08, B04, B03
    """
    stack_path = Path(stack_path)
    rgb_out, nir_out = Path(rgb_out), Path(nir_out)
    with rasterio.open(stack_path) as src:
        if src.count != 4:
            raise ValueError(f"Se esperaban 4 bandas en {stack_path}, hay {src.count}")
        data = src.read().astype(np.float32)
        profile_in = src.profile.copy()

    # data[0]=B04, [1]=B03, [2]=B02, [3]=B08
    rgb = data[0:3]
    nir = np.stack([data[3], data[0], data[1]], axis=0)

    for out_path, arr in ((rgb_out, rgb), (nir_out, nir)):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        profile = profile_for_geotiff(profile_in, count=3, dtype=arr.dtype)
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(arr)
