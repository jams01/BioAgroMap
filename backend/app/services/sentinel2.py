"""
Sentinel-2 download service using Copernicus Data Space.
Searches and downloads S2 L2A (MSIL2A) products month by month for a given WKT polygon.
Only downloads products that cover >= 75% of the user's area of interest.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Callable
from datetime import date

import requests
from dateutil.relativedelta import relativedelta
from shapely import from_wkt

logger = logging.getLogger(__name__)

CATALOGUE_URL = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"
TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
DATA_COLLECTION = "SENTINEL-2"
MIN_COVERAGE = 0.75


def _count_month_slots(start: date, end: date) -> int:
    n = 0
    cur = start
    while cur < end:
        n += 1
        cur = cur + relativedelta(months=1)
    return max(n, 1)


def get_copernicus_token(username: str, password: str) -> str:
    data = {
        "client_id": "cdse-public",
        "username": username,
        "password": password,
        "grant_type": "password",
    }
    r = requests.post(TOKEN_URL, data=data, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def _product_covers_area(product: dict, aoi_geom) -> bool:
    """Check if product footprint covers >= 75% of the area of interest."""
    try:
        footprint_wkt = product.get("Footprint", "")
        if not footprint_wkt:
            # If no footprint, accept based on catalogue intersection
            return True
        # Extract WKT from "geography'SRID=4326;POLYGON(...)'" format
        if "SRID=" in footprint_wkt:
            footprint_wkt = footprint_wkt.split(";", 1)[1].rstrip("'")
        product_geom = from_wkt(footprint_wkt)
        if not product_geom.is_valid:
            product_geom = product_geom.buffer(0)
        intersection = aoi_geom.intersection(product_geom)
        coverage = intersection.area / aoi_geom.area if aoi_geom.area > 0 else 0
        logger.info("Product coverage: %.1f%%", coverage * 100)
        return coverage >= MIN_COVERAGE
    except Exception:
        logger.warning("Could not compute coverage, accepting product")
        return True


def download_product(
    product_id: str,
    product_name: str,
    session: requests.Session,
    output_dir: str,
    stream_progress: Callable[[int, int, str], None] | None = None,
) -> str | None:
    url = f"{CATALOGUE_URL}({product_id})/$value"
    r1 = session.get(url, allow_redirects=False, timeout=30)
    download_url = r1.headers.get("Location", url)
    r2 = session.get(
        download_url,
        allow_redirects=True,
        headers={"Authorization": session.headers["Authorization"]},
        stream=True,
        timeout=300,
    )
    r2.raise_for_status()
    zip_path = os.path.join(output_dir, f"{product_name}.zip")
    total_size = 0
    total_hint: int | None = None
    cl = r2.headers.get("Content-Length")
    if cl and str(cl).isdigit():
        total_hint = int(cl)
    # Porcentaje dentro de la fase de descarga del ZIP (la barra no queda congelada varios minutos).
    lo_pct, hi_pct = 88, 99
    throttle = 2 * 1024 * 1024
    last_emit = 0

    def _emit_progress(force: bool = False) -> None:
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
        stream_progress(pct, 100, f"Descargando {product_name}... ({mb} MB)")

    with open(zip_path, "wb") as f:
        for chunk in r2.iter_content(chunk_size=8192 * 16):
            if not chunk:
                continue
            f.write(chunk)
            total_size += len(chunk)
            _emit_progress(force=False)
    _emit_progress(force=True)
    logger.info("Downloaded %s (%d MB)", product_name, total_size // (1024 * 1024))
    return zip_path


def search_and_download_monthly(
    wkt_polygon: str,
    start_date: date,
    end_date: date,
    output_dir: str,
    copernicus_user: str,
    copernicus_password: str,
    progress_callback: Callable[[int, int, str], None] | None = None,
) -> dict:
    """Download S2 L2A (MSIL2A) products per month that cover >=75% of the WKT area."""
    os.makedirs(output_dir, exist_ok=True)
    total_downloaded = 0
    total_size_mb = 0
    downloaded_files: list[str] = []
    skipped_low_coverage = 0

    aoi_geom = from_wkt(wkt_polygon)
    if not aoi_geom.is_valid:
        aoi_geom = aoi_geom.buffer(0)

    total_months = _count_month_slots(start_date, end_date)
    month_index = 0

    def _report(msg: str, sub: float | None = None) -> None:
        if not progress_callback:
            return
        if sub is not None:
            pct = int(5 + (month_index + sub) / max(total_months, 1) * 90)
        else:
            pct = int(5 + month_index / max(total_months, 1) * 90)
        progress_callback(min(pct, 99), 100, msg)

    _report("Iniciando busqueda Sentinel-2...", 0)

    current = start_date
    while current < end_date:
        next_month = current + relativedelta(months=1)
        if next_month > end_date:
            next_month = end_date
        start_str = current.strftime("%Y-%m-%d")
        end_str = next_month.strftime("%Y-%m-%d")
        logger.info("Searching S2 products: %s -> %s", start_str, end_str)
        _report(f"Buscando imagenes: {start_str} (mes {month_index + 1}/{total_months})", 0.2)

        try:
            token = get_copernicus_token(copernicus_user, copernicus_password)
            session = requests.Session()
            session.verify = False
            session.headers.update({"Authorization": f"Bearer {token}"})

            query_url = (
                f"{CATALOGUE_URL}"
                f"?$filter=Collection/Name eq '{DATA_COLLECTION}'"
                f" and OData.CSC.Intersects(area=geography'SRID=4326;{wkt_polygon}')"
                f" and ContentDate/Start ge {start_str}T00:00:00.000Z"
                f" and ContentDate/Start lt {end_str}T00:00:00.000Z"
                f"&$count=True&$top=1000"
            )
            resp = session.get(query_url, timeout=60)
            resp.raise_for_status()
            j = resp.json()

            products = j.get("value", [])
            s2_l2a_products = [
                p
                for p in products
                if p["Name"].startswith("S2A_MSIL2A") or p["Name"].startswith("S2B_MSIL2A")
            ]

            if not s2_l2a_products:
                logger.info("No S2 L2A (MSIL2A) products for %s", start_str)
                current = next_month
                continue

            s2_l2a_products.sort(key=lambda p: p["ContentDate"]["Start"])

            downloaded_this_month = False
            for product in s2_l2a_products:
                if not _product_covers_area(product, aoi_geom):
                    skipped_low_coverage += 1
                    continue

                prod_id = product["Id"]
                identifier = product["Name"].split(".")[0]

                expected_file = os.path.join(output_dir, f"{identifier}.zip")
                if os.path.exists(expected_file):
                    logger.info("Already exists: %s", identifier)
                    downloaded_files.append(expected_file)
                else:
                    _report(f"Descargando {identifier}...", 0.5)
                    zip_path = download_product(
                        prod_id,
                        identifier,
                        session,
                        output_dir,
                        stream_progress=progress_callback,
                    )
                    if zip_path and os.path.exists(zip_path):
                        file_size = os.path.getsize(zip_path) // (1024 * 1024)
                        total_downloaded += 1
                        total_size_mb += file_size
                        downloaded_files.append(zip_path)

                downloaded_this_month = True
                break

            if not downloaded_this_month:
                logger.info("No product with >=75%% coverage for %s", start_str)

        except Exception:
            logger.exception("Error downloading S2 for %s", start_str)

        month_index += 1
        current = next_month

    _report("Finalizando...", 0.95)

    return {
        "total_downloaded": total_downloaded,
        "total_size_mb": total_size_mb,
        "files": downloaded_files,
        "skipped_low_coverage": skipped_low_coverage,
    }
