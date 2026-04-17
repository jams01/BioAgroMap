"""Detección de extensión WGS84 desde productos Sentinel-2 en carpeta *.SAFE."""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import rasterio
from rasterio.warp import transform_bounds


def find_safe_ancestor(path: Path) -> Path | None:
    """Sube por los padres hasta una carpeta cuyo nombre termina en .SAFE."""
    for p in (path.parent, *path.parents):
        if p.is_dir() and p.name.endswith(".SAFE"):
            return p
    return None


def _wgs84_bounds_from_ext_pos_list_text(text: str) -> tuple[float, float, float, float] | None:
    """
    ESA User Product / granule: lista de pares en WGS84.
    Suele ser latitud, longitud alternas (Global_Footprint / EXT_POS_LIST).
    """
    raw = text.strip().split()
    if len(raw) < 4:
        return None
    try:
        nums = [float(x) for x in raw]
    except ValueError:
        return None
    # Si el primer valor parece longitud (|v|>90), asumir lon,lat
    if abs(nums[0]) > 90 and abs(nums[1]) <= 90:
        lons = nums[0::2]
        lats = nums[1::2]
    else:
        lats = nums[0::2]
        lons = nums[1::2]
    if not lats or len(lats) != len(lons):
        return None
    w, e = min(lons), max(lons)
    s, n = min(lats), max(lats)
    if not all(math.isfinite(x) for x in (w, s, e, n)):
        return None
    if w < -180 or e > 180 or s < -90 or n > 90:
        return None
    return (w, s, e, n)


def _union_bounds(
    boxes: list[tuple[float, float, float, float]],
) -> tuple[float, float, float, float] | None:
    if not boxes:
        return None
    w = min(b[0] for b in boxes)
    s = min(b[1] for b in boxes)
    e = max(b[2] for b in boxes)
    n = max(b[3] for b in boxes)
    return (w, s, e, n)


def _parse_xml_footprints(safe_root: Path) -> tuple[float, float, float, float] | None:
    """Recorre XML del SAFE buscando EXT_POS_LIST y similares."""
    boxes: list[tuple[float, float, float, float]] = []
    count = 0
    for xml_path in safe_root.rglob("*.xml"):
        if count > 400:
            break
        try:
            if xml_path.stat().st_size > 8_000_000:
                continue
        except OSError:
            continue
        count += 1
        try:
            tree = ET.parse(xml_path)
        except ET.ParseError:
            continue
        for el in tree.getroot().iter():
            tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
            if "ext_pos_list" not in tag.lower():
                continue
            text = (el.text or "").strip()
            if not text or len(text) < 8:
                continue
            b = _wgs84_bounds_from_ext_pos_list_text(text)
            if b:
                boxes.append(b)
    return _union_bounds(boxes)


def bounds_wgs84_from_sentinel_safe(image_path: Path) -> tuple[float, float, float, float] | None:
    """
    Usa MTD_*.xml (driver GDAL) o huellas en XML dentro del árbol .SAFE.
    `image_path` puede ser un JPG/JP2 bajo GRANULE/.../IMG_DATA/...
    """
    safe_root = find_safe_ancestor(image_path.resolve())
    if safe_root is None:
        return None

    for mtd_name in ("MTD_MSIL2A.xml", "MTD_MSIL1C.xml"):
        mtd = safe_root / mtd_name
        if mtd.is_file():
            try:
                with rasterio.open(mtd) as src:
                    if src.crs is not None:
                        return tuple(transform_bounds(src.crs, "EPSG:4326", *src.bounds))
            except Exception:
                pass

    try:
        for mtd in safe_root.glob("GRANULE/*/MTD_TL.xml"):
            try:
                with rasterio.open(mtd) as src:
                    if src.crs is not None:
                        return tuple(transform_bounds(src.crs, "EPSG:4326", *src.bounds))
            except Exception:
                continue
    except Exception:
        pass

    return _parse_xml_footprints(safe_root)


def bounds_from_sibling_jp2_tci(image_path: Path) -> tuple[float, float, float, float] | None:
    """Si es preview JPG, el JP2 TCI en la misma carpeta (o hermana R10m) suele tener CRS."""
    suf = image_path.suffix.lower()
    if suf not in {".jpg", ".jpeg", ".png"}:
        return None
    parent = image_path.parent
    candidates: list[Path] = []
    for pat in ("*TCI*.jp2", "*_TCI.jp2", "*.jp2"):
        candidates.extend(sorted(parent.glob(pat)))
    for p in candidates:
        if p == image_path:
            continue
        try:
            with rasterio.open(p) as src:
                if src.crs is None:
                    continue
                return tuple(transform_bounds(src.crs, "EPSG:4326", *src.bounds))
        except Exception:
            continue
    return None


def _path_is_sentinel_10m_band_jp2(p: Path) -> bool:
    """
    L2A: JP2 bajo .../IMG_DATA/R10m/ (nombres tipo *_B04_10m.jp2).
    L1C: JP2 bajo .../IMG_DATA/ sin subcarpeta R*m (nombres tipo *_T19NDG_*_B04.jp2).
    Excluye R20m/R60m (otras resoluciones).
    """
    parts_upper = [x.upper() for x in p.parts]
    if "IMG_DATA" not in parts_upper:
        return False
    i = parts_upper.index("IMG_DATA")
    dirs_after = parts_upper[i + 1 : -1]
    if not dirs_after:
        return True
    top = dirs_after[0]
    if top == "R10M":
        return True
    if top in ("R20M", "R60M"):
        return False
    # Subcarpetas no estándar bajo IMG_DATA: intentar igual (regex de banda filtra)
    return True


S2_BANDS_10M_ORDER = ("B02", "B03", "B04", "B08")

S2_BAND_LABELS_ES = {
    "B02": "B02 Azul (490 nm)",
    "B03": "B03 Verde (560 nm)",
    "B04": "B04 Rojo (665 nm)",
    "B08": "B08 NIR (842 nm)",
}


def find_sentinel_r20_r60_band_files(root: Path, bands: tuple[str, ...]) -> dict[str, Path]:
    """
    Localiza B05 (Red Edge) y B11 (SWIR) en L2A bajo IMG_DATA/R20m o R60m
    (p. ej. *_B05_20m.jp2, *_B11_20m.jp2). Prefiere 20 m sobre 60 m.
    """
    out: dict[str, Path] = {}
    pat = re.compile(r"_(B05|B11)_(20m|60m)\.jp2$", re.IGNORECASE)
    found: dict[str, list[tuple[Path, str]]] = {b: [] for b in bands}

    for p in root.rglob("*.jp2"):
        if not p.is_file():
            continue
        parts_upper = [x.upper() for x in p.parts]
        if "IMG_DATA" not in parts_upper:
            continue
        m = pat.search(p.name)
        if not m:
            continue
        band = m.group(1).upper()
        res = m.group(2).lower()
        if band not in bands:
            continue
        found[band].append((p, res))

    for b in bands:
        opts = found.get(b) or []
        if not opts:
            continue
        opts.sort(key=lambda x: (0 if x[1] == "20m" else 1, x[0].name))
        out[b] = opts[0][0]
    return out


def find_sentinel_r10_band_files(root: Path) -> dict[str, Path]:
    """
    Localiza JP2 de bandas 2,3,4,8 a 10 m.
    L2A: .../IMG_DATA/R10m/*_B02_10m.jp2
    L1C: .../IMG_DATA/*_B02.jp2 (misma resolución; sin carpeta R10m).
    """
    r10_jp2 = [p for p in root.rglob("*.jp2") if p.is_file() and _path_is_sentinel_10m_band_jp2(p)]
    pat = re.compile(r"_(B(?:02|03|04|08))(?:_10m)?\.jp2$", re.IGNORECASE)
    out: dict[str, Path] = {}
    for p in r10_jp2:
        m = pat.search(p.name)
        if m:
            b = m.group(1).upper()
            if b not in out:
                out[b] = p
    for band in S2_BANDS_10M_ORDER:
        if band in out:
            continue
        token = f"_{band}_"
        for p in r10_jp2:
            n = p.name.upper()
            if token in n or n.endswith(f"_{band}.JP2"):
                out[band] = p
                break
    return out


def safe_extract_zip(zip_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest_dir)
