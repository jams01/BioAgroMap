from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.config import get_max_upload_mb, settings
from app.models.models import RasterLayer


async def validate_upload_size(file: UploadFile):
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    max_mb = get_max_upload_mb()
    max_bytes = max_mb * 1024 * 1024
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"File too large. Max {max_mb}MB")


def _tenant_storage(tenant_id: int, project_id: int, kind: str) -> Path:
    base = Path(settings.storage_path) / f"tenant_{tenant_id}" / f"project_{project_id}" / kind
    base.mkdir(parents=True, exist_ok=True)
    return base


def project_downloads_dir(tenant_id: int, project_id: int, project_name: str) -> Path:
    """Carpeta de descargas Sentinel-2 (mismo slug que en preprocess/download)."""
    slug = project_name.replace(" ", "_").lower()
    return _tenant_storage(tenant_id, project_id, "downloads") / slug


def is_legacy_s2_zip_band_raster(meta: dict | None) -> bool:
    """
    True si es una capa raster del flujo antiguo Sentinel-2 (un JP2 por banda).
    Esas entradas no deben mostrarse en el mapa: solo las vistas RGB/NIR (composite_kind).
    """
    if not meta:
        return False
    return bool(
        meta.get("s2_band_pack")
        and meta.get("band")
        and not meta.get("composite_kind")
    )


def _get_project_raster(db: Session, tenant_id: int, project_id: int, raster_layer_id: int) -> RasterLayer:
    raster = (
        db.query(RasterLayer)
        .filter(
            RasterLayer.id == raster_layer_id,
            RasterLayer.project_id == project_id,
            RasterLayer.tenant_id == tenant_id,
        )
        .first()
    )
    if not raster:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    return raster


def _existing_raster_path(raster: RasterLayer) -> Path:
    cog = Path(raster.cog_path) if raster.cog_path else None
    raw = Path(raster.file_path)
    if cog and cog.exists():
        return cog
    if raw.exists():
        return raw
    raise HTTPException(status_code=404, detail="Raster file not available")
