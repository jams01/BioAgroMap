"""
Recorte espacial (subset por polígono WGS84) de productos Sentinel-1 GRD IW COG en carpeta *.SAFE.

**Orden de motores:** si el worker encuentra el ejecutable ``gpt`` de ESA SNAP (``SNAP_GPT_PATH`` o
autodetección), se intenta primero un grafo **Read → Subset (geoRegion WGS84) → Terrain-Correction
(Range-Doppler) → Write GeoTIFF** (salida ``*_recorte_TC.tif``). Si SNAP falla o no está instalado,
se usa **rasterio** leyendo solo la ventana de píxeles que cubre el AOI (margen acotado), sin cargar
el IW completo en RAM.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import geometry_mask, geometry_window
from rasterio.transform import Affine
from rasterio.windows import Window
from rasterio.warp import transform_bounds, transform_geom
from shapely import force_2d, from_wkt
from shapely.geometry import box, mapping, shape
from shapely.geometry.base import BaseGeometry

from app.core.config import settings

logger = logging.getLogger(__name__)

# Margen máximo alrededor del bbox del polígono (píxeles); el valor efectivo se acota al tamaño de escena.
_DEFAULT_PAD_PX = 96


def _effective_pad_px(full_w: int, full_h: int, requested: int) -> int:
    m = max(1, min(int(full_w), int(full_h)))
    return max(16, min(int(requested), m // 6))


def _geotiff_tiling_for_dims(width: int, height: int, profile: dict) -> None:
    """
    GeoTIFF segmentado: GDAL exige ``blockxsize`` y ``blockysize`` múltiplos de 16.
    Si no cabe un bloque válido, se desactiva el tiling (dataset pequeño o ventana estrecha).
    """
    w, h = max(1, int(width)), max(1, int(height))

    def _blk(dim: int) -> int | None:
        m = min(256, dim)
        b = (m // 16) * 16
        if b >= 16 and b <= dim:
            return b
        return None

    bx, by = _blk(w), _blk(h)
    if bx is not None and by is not None:
        profile["tiled"] = True
        profile["blockxsize"] = bx
        profile["blockysize"] = by
    else:
        profile["tiled"] = False
        profile.pop("blockxsize", None)
        profile.pop("blockysize", None)


def find_s1_grd_measurement_vv_vh(safe_dir: Path) -> tuple[Path, Path]:
    """Localiza los GeoTIFF COG de medición VV y VH bajo ``measurement/``."""
    meas = safe_dir / "measurement"
    if not meas.is_dir():
        raise FileNotFoundError(f"No existe measurement/ en {safe_dir}")
    vvs: list[Path] = []
    vhs: list[Path] = []
    for p in meas.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".tif", ".tiff"):
            continue
        low = p.name.lower()
        if "-vv-" in low or "_vv_" in low:
            vvs.append(p)
        elif "-vh-" in low or "_vh_" in low:
            vhs.append(p)
    if not vvs or not vhs:
        raise FileNotFoundError(f"No se hallaron pares VV/VH en {meas}")
    vvs.sort(key=lambda x: x.name)
    vhs.sort(key=lambda x: x.name)
    return vvs[0], vhs[0]


def _band_meta_blob(src, band_idx: int) -> str:
    """Texto unido para heurística VV/VH (descripciones + tags típicos de SNAP/GDAL)."""
    tags = src.tags(band_idx)
    parts = [
        src.descriptions[band_idx - 1] or "",
        str(tags.get("long_name", "")),
        str(tags.get("LONG_NAME", "")),
        str(tags.get("DESCRIPTION", "")),
    ]
    return " ".join(parts).lower()


def normalize_s1_subset_geotiff_to_vv_vh(path: Path) -> None:
    """
    Tras un Subset SNAP, el GeoTIFF puede tener muchas bandas. Reescribe ``path`` como GeoTIFF de
    exactamente 2 bandas (VV, VH) si hace falta, para COG y vista RGB coherentes con el flujo rasterio.
    """
    with rasterio.open(path) as src:
        if src.count <= 2:
            return

        blobs = {i: _band_meta_blob(src, i) for i in range(1, src.count + 1)}
        comp = {i: b.replace(" ", "").replace("_", "") for i, b in blobs.items()}

        def pick_vv() -> int | None:
            for i, b in comp.items():
                if "vh" in b and "vv" not in b:
                    continue
                if any(x in b for x in ("gamma0vv", "intensityvv", "sigma0vv", "amplitudevv", "-vv", "_vv")):
                    return i
            return None

        def pick_vh() -> int | None:
            for i, b in comp.items():
                if any(x in b for x in ("gamma0vh", "intensityvh", "sigma0vh", "amplitudevh", "-vh", "_vh")):
                    return i
            return None

        vv_i = pick_vv()
        vh_i = pick_vh()
        if vv_i is None or vh_i is None or vv_i == vh_i:
            logger.warning(
                "SNAP salida con %s bandas sin metadatos VV/VH claros; usando bandas 1 y 2.",
                src.count,
            )
            vv_i, vh_i = 1, min(2, src.count)
        if vv_i == vh_i:
            raise ValueError(
                "Salida SNAP: no se pudo reducir a dos bandas VV/VH (revisa el producto o usa rasterio)."
            )

        stack = np.stack(
            [src.read(vv_i).astype(np.float32), src.read(vh_i).astype(np.float32)],
            axis=0,
        )
        profile = src.profile.copy()
        profile.update(
            {
                "count": 2,
                "dtype": "float32",
                "compress": "lzw",
            }
        )
        _geotiff_tiling_for_dims(int(profile["width"]), int(profile["height"]), profile)

    tmp = path.with_name(path.stem + f"_norm_{os.getpid()}.tif")
    try:
        with rasterio.open(tmp, "w", **profile) as dst:
            dst.write(stack)
            dst.set_band_description(1, "VV")
            dst.set_band_description(2, "VH")
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _geom_in_raster_crs(wkt_polygon: str, raster_crs) -> BaseGeometry:
    geom_wgs = from_wkt(wkt_polygon)
    if not geom_wgs.is_valid:
        geom_wgs = geom_wgs.buffer(0)
    if raster_crs is not None:
        geom_dict = mapping(geom_wgs)
        geom_dict = transform_geom("EPSG:4326", raster_crs, geom_dict)
        return shape(geom_dict)
    return geom_wgs


def clip_s1_vv_vh_windowed_by_wkt(
    vv_path: Path,
    vh_path: Path,
    wkt_polygon: str,
    out_path: Path,
    pad_pixels: int = _DEFAULT_PAD_PX,
) -> None:
    """
    Lee solo la ventana alrededor del polígono en VV/VH (misma grilla), aplica ``rasterio.mask`` y
    escribe GeoTIFF de 2 bandas. Evita materializar el IW completo en disco o en RAM.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(vv_path) as src_vv, rasterio.open(vh_path) as src_vh:
        if src_vv.shape != src_vh.shape or src_vv.transform != src_vh.transform:
            raise ValueError("VV y VH deben compartir dimensión y transformación.")
        crs = src_vv.crs
        geom432 = from_wkt(wkt_polygon)
        if not geom432.is_valid:
            geom432 = geom432.buffer(0)
        if crs is not None:
            try:
                w, s, e, n = geom432.bounds
                aoi_l, aoi_b, aoi_r, aoi_t = transform_bounds(
                    "EPSG:4326", crs, w, s, e, n, densify_pts=21
                )
                sl, sb, sr, st = src_vv.bounds
                aoi_box = box(min(aoi_l, aoi_r), min(aoi_b, aoi_t), max(aoi_l, aoi_r), max(aoi_b, aoi_t))
                scene_box = box(sl, sb, sr, st)
                if not aoi_box.intersects(scene_box):
                    raise ValueError(
                        "El polígono del proyecto no intersecta la extensión geográfica de esta escena "
                        "Sentinel-1 (elige productos que cubran el lote, o revisa que el vector esté en WGS84 "
                        "o GeoJSON con CRS explícito si usas coordenadas proyectadas)."
                    )
            except ValueError:
                raise
            except Exception as exc:
                logger.debug("s1: comprobación rápida AOI/escena omitida: %s", exc)

        geom_proj = _geom_in_raster_crs(wkt_polygon, crs)
        geoms = [mapping(force_2d(geom_proj))]

        pad_use = _effective_pad_px(src_vv.width, src_vv.height, pad_pixels)
        try:
            win = geometry_window(src_vv, geoms, pad_x=pad_use, pad_y=pad_use, north_up=True)
        except Exception as exc:
            raise ValueError(f"No se pudo calcular ventana del polígono sobre el raster: {exc}") from exc

        full = Window(0, 0, src_vv.width, src_vv.height)
        win = win.intersection(full)
        if win.width < 1 or win.height < 1:
            raise ValueError("El polígono no intersecta la escena Sentinel-1 (ventana vacía).")

        b1 = src_vv.read(1, window=win)
        b2 = src_vh.read(1, window=win)
        win_transform = src_vv.window_transform(win)

        h, w = int(win.height), int(win.width)
        px_x = max(abs(float(win_transform.a)), 1e-12)
        px_y = max(abs(float(win_transform.e)), 1e-12)
        buf_m = max(px_x, px_y) * 0.75

        def _raster_mask(g) -> np.ndarray:
            return geometry_mask(
                [mapping(force_2d(g))],
                (h, w),
                transform=win_transform,
                invert=True,
                all_touched=True,
            )

        try:
            mask_arr = _raster_mask(geom_proj)
        except Exception as exc:
            raise ValueError(f"No se pudo rasterizar el polígono sobre la ventana: {exc}") from exc
        if not np.any(mask_arr):
            try:
                mask_arr = _raster_mask(geom_proj.buffer(buf_m))
            except Exception:
                pass
        if not np.any(mask_arr):
            raise ValueError(
                "El polígono no intersecta la escena Sentinel-1 (sin píxeles en el recorte). "
                "Si el AOI es correcto, prueba SNAP (gpt en el worker) o otra escena que cubra el lote."
            )

        b1f = b1.astype(np.float32, copy=False) if b1.dtype != np.float32 else b1
        b2f = b2.astype(np.float32, copy=False) if b2.dtype != np.float32 else b2
        b1f = np.where(mask_arr, b1f, np.nan)
        b2f = np.where(mask_arr, b2f, np.nan)
        stack = np.stack([b1f, b2f], axis=0)

        ys, xs = np.nonzero(mask_arr)
        r0, r1 = int(ys.min()), int(ys.max()) + 1
        c0, c1 = int(xs.min()), int(xs.max()) + 1
        out_image = stack[:, r0:r1, c0:c1]
        out_transform = win_transform * Affine.translation(c0, r0)

        out_h, out_w = int(out_image.shape[1]), int(out_image.shape[2])
        out_meta = src_vv.meta.copy()
        out_meta.update(
            {
                "driver": "GTiff",
                "height": out_h,
                "width": out_w,
                "count": out_image.shape[0],
                "transform": out_transform,
                "compress": "lzw",
            }
        )
        _geotiff_tiling_for_dims(out_w, out_h, out_meta)
        if np.isnan(out_image).any():
            out_meta["dtype"] = "float32"
            out_image = out_image.astype(np.float32)
        else:
            out_meta["dtype"] = out_image.dtype

        with rasterio.open(out_path, "w", **out_meta) as dst:
            dst.write(out_image)


def s1_safe_spatial_subset_to_recorte(
    safe_dir: Path,
    wkt_polygon: str,
    recortes_root: Path,
    work_dir: Path,
) -> tuple[Path, dict]:
    """
    Recorta VV+VH al polígono WKT (EPSG:4326) y guarda en ``recortes_root``.

    Returns:
        (ruta GeoTIFF, diagnóstico con ``clip_engine`` ``snap`` | ``rasterio`` y estado de SNAP).
    """
    vv, vh = find_s1_grd_measurement_vv_vh(safe_dir)
    stem = safe_dir.name
    if stem.upper().endswith(".SAFE"):
        stem = stem[:-5]
    safe_slug = re.sub(r"[^\w\-.]+", "_", stem)[:90]
    work_dir.mkdir(parents=True, exist_ok=True)
    recortes_root.mkdir(parents=True, exist_ok=True)
    clip_out_rasterio = recortes_root / f"{safe_slug}_S1_VV_VH_recorte.tif"
    clip_out_snap = recortes_root / f"{safe_slug}_S1_VV_VH_recorte_TC.tif"

    info: dict = {
        "clip_engine": "rasterio",
        "snap_gpt_attempted": False,
        "snap_gpt_executable_found": False,
        "snap_ok": False,
        "snap_error": None,
    }

    from app.services.sentinel1_snap import resolve_snap_gpt_executable, run_snap_gpt_subset_polygon

    snap_only = (os.environ.get("S1_RECORTE_SNAP_ONLY") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )

    gpt_exe = resolve_snap_gpt_executable(settings.snap_gpt_path or "")
    if gpt_exe is None and snap_only:
        raise FileNotFoundError(
            "S1_RECORTE_SNAP_ONLY está activo pero no hay ejecutable gpt "
            "(arranca el worker con docker-compose.snap.yml y SNAP_HOST_MOUNT, o define SNAP_GPT_PATH)."
        )
    if gpt_exe is not None:
        info["snap_gpt_executable_found"] = True
        info["snap_gpt_attempted"] = True
        logger.info(
            "s1 recorte: SNAP GPT (subset + Terrain-Correction) %s → %s",
            gpt_exe,
            clip_out_snap.name,
        )
        ok, err = run_snap_gpt_subset_polygon(safe_dir, wkt_polygon, clip_out_snap, gpt_exe)
        if ok:
            try:
                normalize_s1_subset_geotiff_to_vv_vh(clip_out_snap)
            except Exception as exc:
                info["snap_error"] = f"snap_output_normalize: {exc!s}"
                if clip_out_snap.exists():
                    try:
                        clip_out_snap.unlink()
                    except OSError:
                        pass
                if snap_only:
                    raise ValueError(
                        f"S1_RECORTE_SNAP_ONLY: la salida de SNAP no se pudo normalizar a VV/VH: {exc}"
                    ) from exc
                logger.warning(
                    "s1 recorte: salida SNAP no normalizable a VV/VH (%s); reintentando con rasterio.",
                    exc,
                )
            else:
                info["snap_ok"] = True
                info["clip_engine"] = "snap"
                return clip_out_snap, info
        else:
            info["snap_error"] = err or "snap_failed"
            if clip_out_snap.exists():
                try:
                    clip_out_snap.unlink(missing_ok=True)
                except OSError:
                    pass
            if snap_only:
                raise RuntimeError(
                    f"S1_RECORTE_SNAP_ONLY: SNAP GPT no generó el recorte ({err or 'snap_failed'})"
                )
            logger.info("s1 recorte: SNAP no completó (%s); rasterio por ventana.", err)
    else:
        info["snap_error"] = "gpt_not_found"

    logger.info(
        "s1 recorte rasterio (ventana optimizada): VV=%s VH=%s → %s",
        vv.name,
        vh.name,
        clip_out_rasterio.name,
    )
    clip_s1_vv_vh_windowed_by_wkt(vv, vh, wkt_polygon, clip_out_rasterio)
    return clip_out_rasterio, info


def s1_sort_key_from_safe_stem(stem: str) -> str:
    m = re.search(r"_(20\d{2})(\d{2})(\d{2})T", stem.upper())
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return stem[:32]
