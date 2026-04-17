"""Fusión Sentinel-2: un TIF 4 bandas (B04,B03,B02,B08) y dos vistas derivadas para capas."""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from app.services.combine_s2_bands import (
    S2_FOUR_BAND_FILE_ORDER,
    combine_bands_from_paths,
    write_rgb_nir_views_from_stack,
)


def s2_acquisition_date_label(filename_stem: str) -> str:
    """
    Fecha de adquisición dd/mm/YYYY desde el nombre de carpeta/producto .SAFE
    (primer bloque YYYYMMDDT).
    """
    m = re.search(r"_(20\d{2})(\d{2})(\d{2})T", filename_stem)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            date(y, mo, d)
        except ValueError:
            pass
        else:
            return f"{d:02d}/{mo:02d}/{y}"
    today = date.today()
    return f"{today.day:02d}/{today.month:02d}/{today.year}"


def s2_date_slug_for_filename(date_label: str) -> str:
    """dd/mm/YYYY → dd-mm-YYYY para nombres de archivo en disco."""
    return date_label.replace("/", "-")


def build_s2_stack_and_composites(
    band_files: dict[str, Path],
    stack_out: Path,
    rgb_out: Path,
    nir_out: Path,
) -> None:
    """
    1) Un único GeoTIFF con bandas B04, B03, B02, B08 (orden en archivo).
    2) Dos vistas generadas solo desde ese stack (sin volver a leer JP2):
       - RGB: B04, B03, B02
       - NIR: B08, B04, B03
    """
    combine_bands_from_paths(band_files, list(S2_FOUR_BAND_FILE_ORDER), stack_out)
    write_rgb_nir_views_from_stack(stack_out, rgb_out, nir_out)
