"""
Descarga Sentinel-1 GRD IW (VV+VH) vía STAC Copernicus Data Space + OData.
Solo órbita descendente; entre esas escenas, elige la órbita relativa dominante.
"""
from __future__ import annotations

import csv
import logging
import os
import re
import tempfile
import zipfile
from collections import Counter
from collections.abc import Callable
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import requests
import shutil
from shapely.geometry import mapping, shape
from shapely import from_wkt

from app.services.sentinel2 import get_copernicus_token

logger = logging.getLogger(__name__)

STAC_SEARCH_URL = "https://stac.dataspace.copernicus.eu/v1/search"
S1_COLLECTION = "sentinel-1-grd"
# Mismo endpoint OData que Sentinel-2 (catálogo CDSE)
CATALOGUE_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
O_DATA_COLLECTION_S1 = "SENTINEL-1"

# UUID en URLs OData: Products(xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
_O_DATA_PRODUCT_UUID_RE = re.compile(
    r"Products\s*\(\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*\)",
    re.I,
)


def _parse_acquisition_dt(props: dict[str, Any]) -> datetime | None:
    raw = props.get("datetime") or props.get("start_datetime")
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    s = str(raw).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _is_descending_orbit(props: dict[str, Any]) -> bool:
    od = (props.get("sat:orbit_state") or "").strip().lower()
    return od.startswith("desc")


def _pass_short(orbit_state: str | None) -> str:
    o = (orbit_state or "").lower()
    if o.startswith("asc"):
        return "ASC"
    if o.startswith("desc"):
        return "DESC"
    return (orbit_state or "?")[:4].upper()


def _is_s1_iw_grd_vv_vh(feat_id: str, props: dict[str, Any]) -> bool:
    """GRD modo IW con polarizaciones VV y VH (p. ej. productos _IW_GRDH_ / _IW_GRDM_ 1SDV)."""
    pid = feat_id.upper()
    if "_SLC_" in pid:
        return False
    if "_IW_GRDH_" not in pid and "_IW_GRDM_" not in pid:
        return False
    if "GRD" not in pid or "IW" not in pid:
        return False
    pols = props.get("sar:polarizations") or []
    polu = {str(p).upper() for p in pols}
    return "VV" in polu and "VH" in polu


def _feature_intersects_aoi(feat: dict[str, Any], aoi_geom) -> bool:
    g = feat.get("geometry")
    if not g:
        return False
    try:
        fg = shape(g)
        if not fg.is_valid:
            fg = fg.buffer(0)
        return fg.intersects(aoi_geom)
    except Exception:
        return False


def _collect_stac_features(
    intersects_geojson: dict[str, Any],
    start: date,
    end: date,
    session: requests.Session,
) -> list[dict[str, Any]]:
    """Paginación POST /search con token en body (Copernicus STAC)."""
    start_dt = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    end_dt = datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=timezone.utc)
    datetime_str = f"{start_dt.isoformat().replace('+00:00', 'Z')}/{end_dt.isoformat().replace('+00:00', 'Z')}"

    body: dict[str, Any] = {
        "collections": [S1_COLLECTION],
        "datetime": datetime_str,
        "intersects": intersects_geojson,
        "limit": 100,
    }
    url = STAC_SEARCH_URL
    all_feats: list[dict[str, Any]] = []

    for _ in range(5000):
        r = session.post(url, json=body, timeout=120)
        r.raise_for_status()
        j = r.json()
        feats = j.get("features") or []
        all_feats.extend(feats)
        next_body = None
        for link in j.get("links") or []:
            if link.get("rel") == "next":
                next_body = link.get("body")
                break
        if not next_body:
            break
        body = next_body

    return all_feats


def _pick_dominant_orbit_descending(
    candidates: list[dict[str, Any]],
) -> tuple[int, str, list[dict[str, Any]]]:
    """
    Solo escenas en órbita descendente; entre ellas, elige la órbita relativa más frecuente.
    Devuelve (relative_orbit, orbit_state_lower, features filtradas).
    """
    desc = [f for f in candidates if _is_descending_orbit(f.get("properties") or {})]
    if not desc:
        raise ValueError(
            "No hay productos Sentinel-1 GRD IW (VV+VH) en órbita descendente que intersecten el AOI "
            "en el rango de fechas. Amplía fechas o revisa el polígono."
        )

    keys = []
    for feat in desc:
        props = feat.get("properties") or {}
        rel = props.get("sat:relative_orbit")
        od = (props.get("sat:orbit_state") or "").strip().lower() or "descending"
        if rel is None:
            continue
        try:
            rel_i = int(rel)
        except (TypeError, ValueError):
            continue
        keys.append(((rel_i, od), feat))

    if not keys:
        raise ValueError(
            "Hay escenas descendentes pero sin sat:relative_orbit válido; prueba otro rango o AOI."
        )

    counter = Counter(k for k, _ in keys)
    best_key, _cnt = counter.most_common(1)[0]
    best_rel, best_od = best_key
    filtered = [f for k, f in keys if k[0] == best_rel and k[1] == best_od]
    filtered.sort(key=lambda f: (_parse_acquisition_dt(f.get("properties") or {}) or datetime.min.replace(tzinfo=timezone.utc)))
    return best_rel, best_od, filtered


def _extract_product_uuid_from_stac_feature(feat: dict[str, Any]) -> str | None:
    """UUID desde _private, enlaces del ítem o href de assets (p. ej. Product → OData)."""
    props = feat.get("properties") or {}
    priv = props.get("_private") or {}
    uid = priv.get("product_uuid")
    if uid:
        return str(uid).strip()

    for link in feat.get("links") or []:
        href = (link.get("href") or "") if isinstance(link, dict) else ""
        m = _O_DATA_PRODUCT_UUID_RE.search(href)
        if m:
            return m.group(1).lower()

    for asset in (feat.get("assets") or {}).values():
        if not isinstance(asset, dict):
            continue
        href = asset.get("href") or ""
        m = _O_DATA_PRODUCT_UUID_RE.search(href)
        if m:
            return m.group(1).lower()
    return None


def _odata_uuid_for_sentinel1_product(session: requests.Session, feat: dict[str, Any]) -> str | None:
    """Resuelve el Id (GUID) del catálogo OData por nombre de producto S1."""
    props = feat.get("properties") or {}
    priv = props.get("_private") or {}
    fid = feat.get("id") or ""

    names: list[str] = []
    if priv.get("product_name"):
        names.append(str(priv["product_name"]).strip())
    base = str(fid).replace("_COG", "").strip()
    if base and base not in names:
        names.append(base)

    expanded: list[str] = []
    for raw in names:
        r0 = raw.strip()
        if not r0:
            continue
        expanded.append(r0.replace(".SAFE", "").strip())
        if not r0.endswith(".SAFE"):
            expanded.append(f"{r0}.SAFE")
    names = list(dict.fromkeys(expanded))

    for raw_name in names:
        if not raw_name:
            continue
        safe_name = raw_name.replace("'", "''")
        query_url = (
            f"{CATALOGUE_URL}?$filter=Collection/Name eq '{O_DATA_COLLECTION_S1}' "
            f"and Name eq '{safe_name}'&$top=1"
        )
        try:
            r = session.get(query_url, timeout=90)
            r.raise_for_status()
            val = r.json().get("value") or []
            if val and val[0].get("Id"):
                return str(val[0]["Id"])
        except Exception as exc:
            logger.warning("OData Name eq falló para %s: %s", raw_name, exc)

    # Respaldo: startswith con prefijo largo del id STAC (el catálogo usa Name con sufijo .SAFE)
    if base and len(base) > 24:
        prefix = base[: min(80, len(base))].replace("'", "''")
        query_url = (
            f"{CATALOGUE_URL}?$filter=Collection/Name eq '{O_DATA_COLLECTION_S1}' "
            f"and startswith(Name,'{prefix}')&$top=1"
        )
        try:
            r = session.get(query_url, timeout=90)
            r.raise_for_status()
            val = r.json().get("value") or []
            if val and val[0].get("Id"):
                return str(val[0]["Id"])
        except Exception as exc:
            logger.warning("OData startswith falló: %s", exc)
    return None


def _product_download_url(
    session: requests.Session,
    feat: dict[str, Any],
) -> tuple[str, str]:
    props = feat.get("properties") or {}
    priv = props.get("_private") or {}
    pname = priv.get("product_name") or feat.get("id", "product")

    uid = _extract_product_uuid_from_stac_feature(feat)
    if not uid:
        uid = _odata_uuid_for_sentinel1_product(session, feat)
    if not uid:
        raise ValueError(
            f"No se pudo resolver el UUID del producto para descarga (ítem STAC id={feat.get('id')!r}). "
            "Comprueba que el ítem incluya asset Product o que exista en el catálogo OData."
        )
    url = f"https://download.dataspace.copernicus.eu/odata/v1/Products({uid})/$value"
    return url, str(pname)


def _download_zip_to_path(
    session: requests.Session,
    url: str,
    dest_zip: Path,
    stream_progress: Callable[[int, int, str], None] | None = None,
) -> None:
    r1 = session.get(url, allow_redirects=False, timeout=60)
    download_url = r1.headers.get("Location", url)
    r2 = session.get(
        download_url,
        allow_redirects=True,
        headers={"Authorization": session.headers.get("Authorization", "")},
        stream=True,
        timeout=600,
    )
    r2.raise_for_status()
    total_size = 0
    cl = r2.headers.get("Content-Length")
    total_hint = int(cl) if cl and str(cl).isdigit() else None
    lo_pct, hi_pct = 88, 99
    throttle = 2 * 1024 * 1024
    last_emit = 0

    def _emit(force: bool = False) -> None:
        nonlocal last_emit
        if not stream_progress:
            return
        if not force and total_size - last_emit < throttle:
            return
        last_emit = total_size
        mb = total_size // (1024 * 1024)
        if total_hint and total_hint > 0:
            frac = min(1.0, total_size / total_hint)
            pct = lo_pct + int(frac * (hi_pct - lo_pct))
        else:
            pct = (lo_pct + hi_pct) // 2
        stream_progress(pct, 100, f"Descargando… ({mb} MB)")

    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    with open(dest_zip, "wb") as f:
        for chunk in r2.iter_content(chunk_size=8192 * 16):
            if not chunk:
                continue
            f.write(chunk)
            total_size += len(chunk)
            _emit(force=False)
    _emit(force=True)


def _extract_safe_zip(zip_path: Path, dest_parent: Path) -> Path:
    """Extrae el ZIP del producto bajo dest_parent y devuelve la ruta a la carpeta .SAFE."""
    dest_parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest_parent)
    for p in sorted(dest_parent.rglob("*.SAFE")):
        if p.is_dir():
            return p
    raise RuntimeError(f"No se encontró carpeta .SAFE tras extraer {zip_path.name}")


def search_filter_and_download(
    wkt_polygon: str,
    start: date,
    end: date,
    project_downloads_root: Path,
    copernicus_user: str,
    copernicus_password: str,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> dict[str, Any]:
    """
    project_downloads_root: carpeta de descargas del proyecto (slug).
    Los productos (.SAFE) y el CSV quedan en ``Sentinel1/`` sin subcarpetas por fecha.
    """
    os.makedirs(project_downloads_root, exist_ok=True)
    sent1_root = project_downloads_root / "Sentinel1"
    sent1_root.mkdir(parents=True, exist_ok=True)

    aoi_geom = from_wkt(wkt_polygon)
    if not aoi_geom.is_valid:
        aoi_geom = aoi_geom.buffer(0)
    intersects = mapping(aoi_geom)

    def _report(msg: str, pct: int) -> None:
        if progress_callback:
            progress_callback(min(pct, 99), 100, msg)

    _report("Buscando escenas Sentinel-1 GRD IW (STAC)…", 5)

    session = requests.Session()
    session.verify = False
    feats = _collect_stac_features(intersects, start, end, session)

    candidates: list[dict[str, Any]] = []
    for feat in feats:
        fid = feat.get("id") or ""
        props = feat.get("properties") or {}
        if not _is_s1_iw_grd_vv_vh(fid, props):
            continue
        if not _feature_intersects_aoi(feat, aoi_geom):
            continue
        candidates.append(feat)

    rel, od, to_download = _pick_dominant_orbit_descending(candidates)
    pass_short = _pass_short(od)

    _report(
        f"Solo órbita descendente. Órbita relativa seleccionada: {rel} ({pass_short}). "
        f"Productos a descargar: {len(to_download)}.",
        15,
    )

    token = get_copernicus_token(copernicus_user, copernicus_password)
    session.headers.update({"Authorization": f"Bearer {token}"})

    rows: list[list[str]] = []
    downloaded = 0
    total_mb = 0
    dates_out: list[datetime] = []

    n = len(to_download)
    for i, feat in enumerate(to_download):
        props = feat.get("properties") or {}
        priv = props.get("_private") or {}
        pname = priv.get("product_name") or feat.get("id", "product")
        safe_stem = str(pname).replace(".SAFE", "").strip()
        acq = _parse_acquisition_dt(props)
        if acq:
            dates_out.append(acq)

        dest_dir = sent1_root / f"{safe_stem}.SAFE"
        if dest_dir.exists():
            _report(f"Ya existe {dest_dir.name}, omitiendo…", 20 + int((i + 0.5) / max(n, 1) * 70))
            downloaded += 1
            rows.append(
                [
                    acq.isoformat() if acq else "",
                    str(rel),
                    pass_short,
                    pname,
                    str(dest_dir),
                ]
            )
            continue

        pct_base = 20 + int((i / max(n, 1)) * 70)
        _report(f"Descargando ({i + 1}/{n}) {safe_stem}…", pct_base)

        url, _ = _product_download_url(session, feat)
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / f"{safe_stem}.zip"
            def _cb(c: int, t: int, m: str) -> None:
                if progress_callback:
                    progress_callback(min(pct_base + 5, 99), 100, m)

            _download_zip_to_path(session, url, zpath, stream_progress=_cb)
            mb = zpath.stat().st_size // (1024 * 1024)
            total_mb += mb

            sent1_root.mkdir(parents=True, exist_ok=True)
            # Extraer en subcarpeta temporal bajo Sentinel1/ y mover .SAFE a la raíz de Sentinel1/
            with tempfile.TemporaryDirectory(dir=str(sent1_root)) as extmp:
                ext_dir = Path(extmp)
                safe_path = _extract_safe_zip(zpath, ext_dir)
                if dest_dir.exists():
                    shutil.rmtree(dest_dir, ignore_errors=True)
                dest_dir.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(safe_path), str(dest_dir))

        downloaded += 1
        rows.append(
            [
                acq.isoformat() if acq else "",
                str(rel),
                pass_short,
                pname,
                str(dest_dir),
            ]
        )

    tmin = min(dates_out).date().isoformat() if dates_out else start.isoformat()
    tmax = max(dates_out).date().isoformat() if dates_out else end.isoformat()

    csv_name = f"sentinel1_{start.isoformat()}_{end.isoformat()}_orbit{rel}_{pass_short}.csv"
    csv_path = sent1_root / csv_name
    with open(csv_path, "w", newline="", encoding="utf-8") as cf:
        w = csv.writer(cf)
        w.writerow(["fecha_adquisicion_utc", "orbita_relativa", "paso", "nombre_producto", "ruta_safe"])
        w.writerows(rows)

    summary = (
        f"Sentinel-1: {downloaded} imagen(es) en órbita relativa {rel} ({od.upper()}, {pass_short}). "
        f"Rango fechas (adquisición): {tmin} → {tmax}. CSV: {csv_path.name}"
    )
    _report(summary, 99)

    return {
        "total_downloaded": downloaded,
        "total_size_mb": total_mb,
        "selected_relative_orbit": rel,
        "selected_orbit_direction": od,
        "selected_pass_short": pass_short,
        "date_range_start": tmin,
        "date_range_end": tmax,
        "csv_path": str(csv_path),
        "sentinel1_root": str(sent1_root),
        "summary_message": summary,
        "product_paths": [r[4] for r in rows],
    }
