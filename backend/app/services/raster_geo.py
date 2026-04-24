"""Georreferencia y vista previa de rasters para API y workers."""

from __future__ import annotations

import io
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.transform import from_gcps
from rasterio.warp import transform_bounds


def array_bounds(height: int, width: int, transform) -> tuple[float, float, float, float]:
    """left, bottom, right, top en CRS del transform (equivalente a rasterio.coords.array_bounds)."""
    corners = (
        transform * (0, 0),
        transform * (width, 0),
        transform * (width, height),
        transform * (0, height),
    )
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    return float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

from app.services.preprocess_pipeline_variant import is_planetscope_ps_recorte_filename
from app.services.sentinel_safe import bounds_from_sibling_jp2_tci, bounds_wgs84_from_sentinel_safe


def _crs_from_prj(path: Path) -> rasterio.crs.CRS | None:
    prj = path.parent / (path.stem + ".prj")
    if not prj.is_file():
        return None
    text = prj.read_text(encoding="utf-8", errors="ignore").strip()
    if not text:
        return None
    try:
        return rasterio.crs.CRS.from_user_input(text)
    except Exception:
        return None


def _infer_crs_from_gcp_values(gcps) -> rasterio.crs.CRS | None:
    """Si los GCP no traen CRS, intenta EPSG:4326 si (x,y) parecen lon/lat en grados."""
    xs = [p.x for p in gcps]
    ys = [p.y for p in gcps]
    if not xs:
        return None
    max_abs_x = max(abs(x) for x in xs)
    max_abs_y = max(abs(y) for y in ys)
    if max_abs_x <= 180.0 and max_abs_y <= 90.0:
        try:
            return rasterio.crs.CRS.from_epsg(4326)
        except Exception:
            return None
    return None


def _bounds_from_gcps(src: rasterio.DatasetReader) -> tuple[float, float, float, float] | None:
    """Límites WGS84 desde GCP (habitual en JPEG/JP2 exportados desde Sentinel / GDAL)."""
    gcps_tup = src.gcps
    if not gcps_tup or not gcps_tup[0]:
        return None
    gcps, gcrs = gcps_tup[0], gcps_tup[1]
    crs_use = gcrs if gcrs is not None else _infer_crs_from_gcp_values(gcps)
    if crs_use is None:
        return None

    try:
        transform = from_gcps(gcps)
        left, bottom, right, top = array_bounds(src.height, src.width, transform)
    except Exception:
        xs = [p.x for p in gcps]
        ys = [p.y for p in gcps]
        left, right = min(xs), max(xs)
        bottom, top = min(ys), max(ys)

    try:
        return tuple(transform_bounds(crs_use, "EPSG:4326", left, bottom, right, top))
    except Exception:
        return None


def _find_world_file(image_path: Path) -> Path | None:
    stem = image_path.stem
    parent = image_path.parent
    for ext in (".jgw", ".jpgw", ".jpegw", ".wld"):
        p = parent / f"{stem}{ext}"
        if p.is_file():
            return p
    return None


def _affine_from_esri_world_file(wf: Path) -> Affine:
    """Lee .jgw / .wld (orden ESRI de 6 líneas, compatible con GDAL)."""
    raw = wf.read_text(encoding="utf-8", errors="ignore").split()
    if len(raw) < 6:
        raise ValueError("Archivo mundo incompleto (se esperan 6 valores)")
    vals = [float(x) for x in raw[:6]]
    # Affine(a, b, c, d, e, f): x = a*col + b*row + c; y = d*col + e*row + f
    return Affine(vals[0], vals[2], vals[4], vals[1], vals[3], vals[5])


def _looks_like_pixel_bounds(src: rasterio.DatasetReader) -> bool:
    """True si los bounds son el rectángulo de píxeles (0..ancho / 0..alto), típico sin SRS."""
    b = src.bounds
    w, h = float(src.width), float(src.height)
    if w < 1 or h < 1:
        return False
    tol = 1e-2
    horiz = abs(b.left) < tol and abs(b.right - w) < tol
    vert_a = abs(b.top) < tol and abs(b.bottom - h) < tol
    vert_b = abs(b.bottom) < tol and abs(b.top + h) < tol
    return horiz and (vert_a or vert_b)


def _bounds_from_gdal_aux_xml(path: Path, src: rasterio.DatasetReader) -> tuple[float, float, float, float] | None:
    """GDAL PAM (`imagen.jpg.aux.xml`) con SRS + GeoTransform (export QGIS / algunos flujos Sentinel)."""
    pam = path.parent / f"{path.name}.aux.xml"
    if not pam.is_file():
        return None
    try:
        root = ET.parse(pam).getroot()
        srs_el = root.find("SRS")
        gt_el = root.find("GeoTransform")
        if srs_el is None or gt_el is None:
            return None
        srs_text = (srs_el.text or "").strip()
        gt_text = (gt_el.text or "").strip()
        if not srs_text or not gt_text:
            return None
        crs = rasterio.crs.CRS.from_user_input(srs_text)
        parts = [float(x) for x in gt_text.replace(",", " ").split()]
        if len(parts) < 6:
            return None
        transform = Affine.from_gdal(*parts[:6])
        left, bottom, right, top = array_bounds(src.height, src.width, transform)
        return tuple(transform_bounds(crs, "EPSG:4326", left, bottom, right, top))
    except Exception:
        return None


def _bounds_from_prj_and_world(path: Path, src: rasterio.DatasetReader) -> tuple[float, float, float, float] | None:
    """
    Caso JPG + .prj (+ opcional .jgw): a veces GDAL rellena transform pero rasterio deja crs en None,
    o solo hay mundo + prj junto al JPEG.
    """
    crs = _crs_from_prj(path)
    if crs is None:
        return None

    if not _looks_like_pixel_bounds(src):
        try:
            b = src.bounds
            return tuple(transform_bounds(crs, "EPSG:4326", b.left, b.bottom, b.right, b.top))
        except Exception:
            pass

    wf = _find_world_file(path)
    if wf is None:
        return None
    try:
        transform = _affine_from_esri_world_file(wf)
        left, bottom, right, top = array_bounds(src.height, src.width, transform)
        return tuple(transform_bounds(crs, "EPSG:4326", left, bottom, right, top))
    except Exception:
        return None


def bounds_wgs84_from_path(path: Path) -> tuple[float, float, float, float] | None:
    """Devuelve (west, south, east, north) en EPSG:4326 o None si no hay georreferencia usable."""
    path = Path(path).resolve()

    b = bounds_from_sibling_jp2_tci(path)
    if b is not None:
        w, s, e, n = b
        if all(math.isfinite(x) for x in (w, s, e, n)):
            return b

    try:
        with rasterio.open(path) as src:
            if src.crs is not None:
                try:
                    return tuple(transform_bounds(src.crs, "EPSG:4326", *src.bounds))
                except Exception:
                    pass

            g = _bounds_from_gcps(src)
            if g is not None:
                w, s, e, n = g
                if all(math.isfinite(x) for x in (w, s, e, n)):
                    return g

            g = _bounds_from_gdal_aux_xml(path, src)
            if g is not None:
                w, s, e, n = g
                if all(math.isfinite(x) for x in (w, s, e, n)):
                    return g

            g = _bounds_from_prj_and_world(path, src)
            if g is not None:
                w, s, e, n = g
                if all(math.isfinite(x) for x in (w, s, e, n)):
                    return g
    except Exception:
        pass

    b = bounds_wgs84_from_sentinel_safe(path)
    if b is not None:
        w, s, e, n = b
        if all(math.isfinite(x) for x in (w, s, e, n)):
            return b
    return None


def _resolve_rgb_band_indexes(
    src_count: int,
    rgb_bands_1based: tuple[int, int, int] | None,
    layer_metadata: dict | None,
) -> list[int]:
    """Índices 1-based R,G,B; color natural S2 (B04,B03,B02) = (3,2,1) si B2–B4 son bandas 1–3."""
    meta = layer_metadata or {}
    if rgb_bands_1based is not None:
        r, g, b = rgb_bands_1based
        return [r, g, b]
    # Stack de índices multibanda: una sola banda lógica repetida (la vista usa paleta aparte)
    if meta.get("s2_index_stack") and src_count >= 1:
        prgb = meta.get("preview_rgb_bands")
        if isinstance(prgb, (list, tuple)) and len(prgb) >= 1:
            b0 = max(1, min(int(prgb[0]), src_count))
            return [b0, b0, b0]
        return [1, 1, 1]
    if meta.get("planetscope_composite") and src_count >= 6:
        return [6, 4, 2]
    lab = (meta.get("source_name") or "").strip()
    if src_count >= 6 and lab and is_planetscope_ps_recorte_filename(lab):
        return [6, 4, 2]
    prgb = meta.get("preview_rgb_bands")
    if isinstance(prgb, (list, tuple)) and len(prgb) == 3:
        return [int(prgb[0]), int(prgb[1]), int(prgb[2])]
    # Stack S2: B02,B03,B04 en posiciones 1–3 (y más bandas después) → color natural (B04,B03,B02) = 3,2,1
    if src_count in (4, 6):
        return [3, 2, 1]
    n = min(3, src_count)
    if n < 1:
        raise ValueError("Raster sin bandas")
    return list(range(1, n + 1))


def _normalize_index_band_01(band: np.ndarray) -> np.ndarray:
    """Escala valores del índice a [0,1] con percentiles (NaN = nan)."""
    x = band.astype(np.float64)
    finite = np.isfinite(x)
    if not np.any(finite):
        return np.full_like(x, np.nan, dtype=np.float64)
    lo, hi = np.nanpercentile(x[finite], [2.0, 98.0])
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        lo, hi = np.nanpercentile(x[finite], [1.0, 99.0])
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        lo = float(np.nanmin(x[finite]))
        hi = float(np.nanmax(x[finite]))
    if hi <= lo:
        hi = lo + 1e-12
    t = np.full_like(x, np.nan, dtype=np.float64)
    t[finite] = np.clip((x[finite] - lo) / (hi - lo), 0.0, 1.0)
    return t


def _index_scalar_to_rgb_colormap(t_01: np.ndarray, cmap_name: str = "RdYlGn") -> np.ndarray:
    """
    t_01: (H,W) en [0,1] o NaN → RGB uint8 (H,W,3). NaN → blanco (fondo limpio en dashboard).
    Paletas típicas: RdYlGn (rojo bajo → verde alto), Spectral, turbo, jet.
    """
    finite = np.isfinite(t_01)
    if not np.any(finite):
        return np.full((*t_01.shape, 3), 255, dtype=np.uint8)

    tv = np.clip(np.where(finite, t_01, 0.0), 0.0, 1.0)

    try:
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib import colormaps

        try:
            cmap = colormaps[cmap_name]
        except (ValueError, KeyError):
            cmap = colormaps["RdYlGn"]
        rgba = cmap(tv)
        rgb = (np.clip(rgba[:, :, :3], 0.0, 1.0) * 255.0).astype(np.uint8)
    except Exception:
        # Rojo → amarillo → verde (sin matplotlib)
        r = np.where(tv < 0.5, 255.0, 255.0 * (1.0 - (tv - 0.5) * 2.0))
        g = np.where(tv < 0.5, 255.0 * (tv * 2.0), 255.0)
        b = np.zeros_like(tv)
        rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)

    rgb[~finite, :] = 255
    return rgb


def _is_planet_true_color_preview(meta: dict, src_count: int) -> bool:
    """RGB 6-4-2 sobre composite Planet (8 bandas típ.) o ≥6 bandas con nombre PS_."""
    if src_count < 6:
        return False
    if meta.get("planetscope_composite"):
        return True
    lab = (meta.get("source_name") or "").strip()
    return bool(lab and is_planetscope_ps_recorte_filename(lab))


def _planet_true_color_stack_to_rgb_u8(stack: np.ndarray) -> np.ndarray:
    """
    Color natural PlanetScope: ``stack`` (3,H,W) en orden R,G,B (bandas 6,4,2 crudas del composite).

    Mucho lienzo negro alrededor del polígono hace que los percentiles globales fallen (p99≈0) o
    compriman el histograma hacia el blanco. Aquí se infiere la escala con píxeles que tienen señal,
    el estirado 2–98 va solo sobre esos píxeles, y se aplica gamma > 1 para bajar highlights
    (antes ``y**1.07`` con gamma mal interpretado aclaraba el cielo/cultivo).
    """
    s = stack.astype(np.float64)
    h, w = int(s.shape[1]), int(s.shape[2])
    out = np.full((h, w, 3), 255, dtype=np.uint8)
    valid = np.isfinite(s).all(axis=0)
    if not np.any(valid):
        return out

    raw_energy = np.sum(np.abs(s), axis=0)
    infer = valid & (raw_energy > 0)
    if not np.any(infer):
        infer = valid

    flat = s[:, infer].ravel()
    p50 = float(np.percentile(flat, 50.0))
    p99 = float(np.percentile(flat, 99.0))
    mx = float(np.max(flat))

    # Misma lógica de escalas que la versión por banda, pero una sola decisión para R,G,B.
    if p99 <= 1.15 and mx <= 1.5:
        r = np.where(valid, np.clip(s, 0.0, None), np.nan)
    elif 12 <= p99 <= 100 and mx <= 105 and p50 >= 1.0:
        # Reflectancia en % (0–100), típ. mediana ≥1
        r = np.where(valid, s / 100.0, np.nan)
    elif mx > 12000 or (p99 > 6000 and p50 > 400):
        r = np.where(valid, s / 20000.0, np.nan)
    elif p99 > 800 or p50 > 120 or (p99 > 400 and p50 > 40):
        r = np.where(valid, s / 10000.0, np.nan)
    elif p99 > 35 or mx > 80:
        r = np.where(valid, s / 3800.0, np.nan)
    else:
        r = np.where(valid, s / 3000.0, np.nan)

    sig = np.nanmax(r, axis=0)
    p5_sig = float(np.nanpercentile(sig[valid], 5.0)) if np.any(valid) else 0.0
    eps = max(1e-7, p5_sig * 0.2)
    content = valid & np.isfinite(sig) & (sig > eps)
    if not np.any(content):
        content = valid & np.isfinite(sig)

    reflectance_like = p99 <= 1.15 and mx <= 1.5
    for i in range(3):
        chan = r[i][content]
        if chan.size == 0:
            continue
        lo, hi = np.percentile(chan, (2.0, 98.0))
        if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
            lo, hi = np.percentile(chan, (0.5, 99.5))
        if hi <= lo:
            lo = float(np.nanmin(chan))
            hi = float(np.nanmax(chan))
        if hi <= lo:
            hi = lo + 1e-9
        # Escenas muy uniformes y claras: forzar un mínimo de contraste
        if reflectance_like and (hi - lo) < 0.055:
            hi = min(lo + 0.22, 1.0)
            if hi <= lo:
                hi = lo + 1e-9

        plane = r[i]
        span = hi - lo
        if span < 1e-6:
            y = np.where(np.isfinite(plane), 0.5, 1.0)
        else:
            y = (plane - lo) / span
        y = np.clip(np.where(np.isfinite(y), y, 1.0), 0.0, 1.0)
        y = np.power(y, 1.16)
        out[:, :, i] = (y * 255.0).astype(np.uint8)

    # Fuera del polígono / relleno suele ser DN≈0 (finito, no NaN): el estirado los dejaba negros.
    # Alinear con índice: fondo blanco donde no hay señal útil (misma máscara que define el histograma).
    bg = ~content
    out[bg, :] = 255
    return out


def _stretch_band_to_u8_sentinel_friendly(band: np.ndarray) -> np.ndarray:
    """
    Estira reflectancia a 8 bits. Sentinel-2 L2A suele venir como DN ~0–10000 o float 0–1;
    los recortes pueden tener NaN (máscara). Sin nanpercentile la imagen queda negra.
    """
    x = band.astype(np.float64)
    finite = np.isfinite(x)
    if not np.any(finite):
        return np.full(x.shape, 255, dtype=np.uint8)

    # Reflectancia típica ×10000 (BOA) o valores grandes → pasar a reflectancia ~0–1+.
    # No recortar a [0,1] antes del estirado: p. ej. NIR (DN>10000) quedaría todo en 1.0 y la RGB se ve pálida / lavada.
    p99 = float(np.nanpercentile(x[finite], 99.0))
    if p99 > 1.8:
        x = np.where(finite, x / 10000.0, np.nan)
    else:
        x = np.where(finite, x, np.nan)

    lo, hi = np.nanpercentile(x, [2.0, 98.0])
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        lo, hi = np.nanpercentile(x, [1.0, 99.0])
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= lo:
        lo = float(np.nanmin(x))
        hi = float(np.nanmax(x))
    if hi <= lo:
        hi = lo + 1e-9

    y = (x - lo) / (hi - lo)
    y = np.clip(y, 0.0, 1.0)
    # Ligera gamma para que el color natural no quede apagado
    y = np.power(y, 0.88)
    y = np.where(np.isfinite(y), y, 1.0)
    return (y * 255.0).astype(np.uint8)


def render_s1_vh_vv_ratio_preview_png(
    path: Path,
    max_dim: int = 2048,
    layer_metadata: dict | None = None,
    *,
    cmap_name: str = "RdYlGn",
) -> bytes:
    """
    Índice tipo VH/VV en potencia lineal (útil como «índice radar» sobre GRD IW VV+VH).

    Bandas esperadas: 1 = VV, 2 = VH. Los recortes SNAP suelen estar en sigma0 dB:
    convierte dB → lineal antes del cociente.
    """
    if Image is None:
        raise RuntimeError("Pillow is required for raster previews")

    meta = layer_metadata or {}
    cmap = meta.get("index_preview_cmap") or cmap_name
    if not isinstance(cmap, str) or not cmap.strip():
        cmap = cmap_name

    with rasterio.open(path) as src:
        if src.count < 2:
            raise ValueError("VH/VV requiere al menos 2 bandas (VV, VH)")
        h, w = src.height, src.width
        scale = min(1.0, float(max_dim) / max(h, w))
        out_h = max(1, int(h * scale))
        out_w = max(1, int(w * scale))
        vv = src.read(
            1,
            out_shape=(out_h, out_w),
            resampling=Resampling.bilinear,
        ).astype(np.float64)
        vh = src.read(
            2,
            out_shape=(out_h, out_w),
            resampling=Resampling.bilinear,
        ).astype(np.float64)

    finite_v = np.isfinite(vv)
    finite_h = np.isfinite(vh)
    finite = finite_v & finite_h

    # Recortes S1 del pipeline: sigma0 dB (negativos típicos)
    use_db = bool(meta.get("s1_grd_recorte") or meta.get("s1_iw_grd_vv_vh"))
    if not use_db:
        med = float(np.nanmedian(vv[np.isfinite(vv)])) if np.any(np.isfinite(vv)) else 0.0
        use_db = med < 5.0 and float(np.nanpercentile(vv[np.isfinite(vv)], 95)) < 50.0

    if use_db:
        vv_lin = np.power(10.0, np.clip(vv, -50.0, 30.0) / 10.0)
        vh_lin = np.power(10.0, np.clip(vh, -50.0, 30.0) / 10.0)
    else:
        vv_lin = np.maximum(vv, 0.0)
        vh_lin = np.maximum(vh, 0.0)

    ratio = np.divide(
        vh_lin,
        vv_lin + 1e-30,
        out=np.full_like(vh_lin, np.nan),
        where=finite,
    )
    z = np.full_like(ratio, np.nan, dtype=np.float64)
    z[finite] = np.log10(np.clip(ratio[finite], 1e-12, None))

    t01 = _normalize_index_band_01(z)
    rgb = _index_scalar_to_rgb_colormap(t01, cmap_name=cmap)
    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def render_raster_preview_png(
    path: Path,
    max_dim: int = 2048,
    rgb_bands_1based: tuple[int, int, int] | None = None,
    layer_metadata: dict | None = None,
    *,
    index_palette_request: bool = False,
) -> bytes:
    """
    Genera PNG RGB para superponer en el mapa (MapLibre image source).
    Recortes S2: color natural (p. ej. R=B04,G=B03,B=B02 en 4/6 bandas).
    PlanetScope (``planetscope_composite`` o nombre ``PS_*.tif``): bandas 6,4,2 y estirado
    tipo EO Browser (``/ 3000`` sobre DN típico + percentiles).

    Stacks de índices (`s2_index_stack`): la paleta (RdYlGn, etc.) solo si
    ``index_palette_request`` es True (p. ej. galería «Visual NDVI»). Sin ese flag,
    una sola banda en escala de grises (p. ej. llamadas genéricas a /preview).
    """
    if Image is None:
        raise RuntimeError("Pillow is required for raster previews")

    meta = layer_metadata or {}
    cmap_name = meta.get("index_preview_cmap") or "RdYlGn"
    if not isinstance(cmap_name, str) or not cmap_name.strip():
        cmap_name = "RdYlGn"

    src_count = 0
    with rasterio.open(path) as src:
        src_count = int(src.count)
        h, w = src.height, src.width
        scale = min(1.0, float(max_dim) / max(h, w))
        out_h = max(1, int(h * scale))
        out_w = max(1, int(w * scale))

        def _read_one_band_for_preview() -> np.ndarray:
            if rgb_bands_1based is not None:
                b0 = int(rgb_bands_1based[0])
            else:
                prgb = meta.get("preview_rgb_bands")
                if isinstance(prgb, (list, tuple)) and len(prgb) >= 1:
                    b0 = int(prgb[0])
                else:
                    b0 = 1
            b0 = max(1, min(b0, src.count))
            raw = src.read(
                b0,
                out_shape=(out_h, out_w),
                resampling=Resampling.bilinear,
            )
            if raw.ndim == 3:
                return raw[0].astype(np.float64)
            return raw.astype(np.float64)

        # Galería «Visual NDVI»: index_palette=1 → paleta siempre (no exige metadatos en BD)
        if index_palette_request and src.count >= 1:
            data = _read_one_band_for_preview()
            t01 = _normalize_index_band_01(data)
            rgb = _index_scalar_to_rgb_colormap(t01, cmap_name=cmap_name)
            img = Image.fromarray(rgb, mode="RGB")
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue()

        # Stack de índice sin petición de paleta (p. ej. preview genérico): gris
        if bool(meta.get("s2_index_stack")) and src.count >= 1:
            data = _read_one_band_for_preview()
            u8 = _stretch_band_to_u8_sentinel_friendly(data)
            rgb = np.stack([u8, u8, u8], axis=-1)
            img = Image.fromarray(rgb, mode="RGB")
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue()

        indexes = _resolve_rgb_band_indexes(src.count, rgb_bands_1based, layer_metadata)
        for idx in indexes:
            if idx < 1 or idx > src.count:
                raise ValueError(f"Índice de banda {idx} fuera de rango (1..{src.count})")

        arr = src.read(
            indexes=indexes,
            out_shape=(len(indexes), out_h, out_w),
            resampling=Resampling.bilinear,
        )

    if arr.shape[0] == 1:
        arr = np.concatenate([arr, arr, arr], axis=0)
    elif arr.shape[0] == 2:
        arr = np.concatenate([arr, arr[:1]], axis=0)

    use_planet_tc = _is_planet_true_color_preview(meta, src_count)
    if use_planet_tc:
        rgb = _planet_true_color_stack_to_rgb_u8(arr)
    else:
        rgb = np.full((arr.shape[1], arr.shape[2], 3), 255, dtype=np.uint8)
        for i in range(3):
            rgb[:, :, i] = _stretch_band_to_u8_sentinel_friendly(arr[i])

    img = Image.fromarray(rgb, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
