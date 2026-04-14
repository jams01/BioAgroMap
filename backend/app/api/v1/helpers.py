from pathlib import Path

from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import RasterLayer

MAX_UPLOAD_BYTES = settings.max_upload_mb * 1024 * 1024


async def validate_upload_size(file: UploadFile):
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large. Max {settings.max_upload_mb}MB")


def _tenant_storage(tenant_id: int, project_id: int, kind: str) -> Path:
    base = Path(settings.storage_path) / f"tenant_{tenant_id}" / f"project_{project_id}" / kind
    base.mkdir(parents=True, exist_ok=True)
    return base


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
