import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, tenant_from_jwt
from app.core.config import settings
from app.db.session import get_db
from app.models.models import AIResult, Layer, Project, RasterLayer, User
from app.schemas.schemas import ProjectCreate

router = APIRouter()


@router.post("/projects")
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = Project(name=payload.name, tenant_id=user.tenant_id)
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name}


@router.get("/projects")
def list_projects(db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    projects = db.query(Project).filter(Project.tenant_id == tenant_id).all()
    return [{"id": p.id, "name": p.name} for p in projects]


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    db.query(AIResult).filter(AIResult.project_id == project_id, AIResult.tenant_id == tenant_id).delete()
    db.query(RasterLayer).filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id).delete()
    db.query(Layer).filter(Layer.project_id == project_id, Layer.tenant_id == tenant_id).delete()
    db.delete(project)
    db.commit()
    storage_dir = Path(settings.storage_path) / f"tenant_{tenant_id}" / f"project_{project_id}"
    if storage_dir.exists():
        shutil.rmtree(storage_dir, ignore_errors=True)
    return {"status": "ok", "deleted_project_id": project_id}
