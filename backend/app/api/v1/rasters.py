import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import _tenant_storage, validate_upload_size
from app.db.session import get_db
from app.models.models import Project, RasterLayer
from app.tasks.jobs import process_raster

router = APIRouter()


@router.post("/upload-raster")
async def upload_raster(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await validate_upload_size(file)
    ext = Path(file.filename).suffix.lower()
    if ext not in {".tif", ".tiff", ".jp2", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(status_code=400, detail="Unsupported raster format")
    out_dir = _tenant_storage(tenant_id, project_id, "rasters")
    destination = out_dir / f"{uuid.uuid4().hex}{ext}"
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    cog_path = out_dir / f"{destination.stem}_cog.tif"
    process_raster.delay(str(destination), str(cog_path))
    raster = RasterLayer(
        project_id=project_id,
        tenant_id=tenant_id,
        name=file.filename,
        file_path=str(destination),
        cog_path=str(cog_path),
        raster_metadata={"source_name": file.filename, "status": "processing"},
    )
    db.add(raster)
    db.commit()
    db.refresh(raster)
    return {"raster_layer_id": raster.id}


@router.get("/raster/{project_id}")
def list_rasters(project_id: int, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    rasters = (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    )
    return [{"id": r.id, "name": r.name, "metadata": r.raster_metadata} for r in rasters]


@router.delete("/raster/{project_id}/{raster_id}")
def delete_raster(
    project_id: int,
    raster_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    raster = (
        db.query(RasterLayer)
        .filter(RasterLayer.id == raster_id, RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .first()
    )
    if not raster:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    for p in [raster.file_path, raster.cog_path]:
        if p:
            fp = Path(p)
            if fp.exists():
                fp.unlink(missing_ok=True)
    db.delete(raster)
    db.commit()
    return {"status": "ok", "deleted_raster_id": raster_id}
