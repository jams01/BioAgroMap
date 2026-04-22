"""Variantes de carpetas de preproceso (S2 estándar vs PS)."""

from __future__ import annotations

import re
from pathlib import Path

# Mismo criterio que inventario / vista previa en ``recortesPS/`` (composite Planet renombrado).
PS_RECORTE_FILENAME_RE = re.compile(r"^PS_\d{2}-\d{2}-\d{2}(?:_\d+)?\.tif$", re.IGNORECASE)


def is_planetscope_ps_recorte_filename(path_or_name: str) -> bool:
    """True si el basename es ``PS_dd-mm-yy.tif`` (opc. ``_N`` antes de ``.tif``)."""
    return bool(PS_RECORTE_FILENAME_RE.match(Path(str(path_or_name)).name))


def normalize_pipeline_variant(raw: str | None) -> str:
    v = (raw or "s2").strip().lower()
    return "ps" if v == "ps" else "s2"


def recortes_dir_name(variant: str | None) -> str:
    """GeoTIFF listos (L2A recortes o Planet composite); PS usa ``recortesPS/``."""
    return "recortesPS" if normalize_pipeline_variant(variant) == "ps" else "recortes"


def planet_zip_dir_name() -> str:
    """Zips PlanetScope / PSScene en ``rasterPS/`` (solo flujo PS)."""
    return "rasterPS"


def indices_dir_name(variant: str | None) -> str:
    return "indecesPS" if normalize_pipeline_variant(variant) == "ps" else "indices"


def cluster_output_dir_name(variant: str | None) -> str:
    return "ClusterPS" if normalize_pipeline_variant(variant) == "ps" else "cluster_gmm"
