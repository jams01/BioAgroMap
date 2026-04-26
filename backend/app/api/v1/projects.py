import shutil
from pathlib import Path

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_admin, tenant_from_jwt
from app.core.order_email import send_study_order_notification
from app.core.config import settings
from app.db.session import get_db
from app.models.models import AIResult, Layer, Project, ProjectProcessingLog, RasterLayer, StudyOrder, User
from app.api.v1.helpers import project_downloads_slug
from app.schemas.schemas import ProcessingLogCreate, ProcessingLogEntry, ProjectCreate, ProjectStatusPatch, ProjectSummary, ProjectUpdate

router = APIRouter()


def _rewrite_raster_paths_after_downloads_move(
    db: Session,
    tenant_id: int,
    project_id: int,
    old_dir: Path,
    new_dir: Path,
) -> None:
    """Tras mover downloads/<slug>, actualizar file_path/cog_path que apuntaban bajo esa carpeta."""
    try:
        old_root = old_dir.resolve()
        new_root = new_dir.resolve()
    except OSError:
        return

    def rewrite(stored: str | None) -> str | None:
        if not stored:
            return stored
        try:
            p = Path(stored).resolve()
            rel = p.relative_to(old_root)
        except (ValueError, OSError):
            return stored
        return str(new_root / rel)

    for r in (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    ):
        new_fp = rewrite(r.file_path)
        if new_fp != r.file_path:
            r.file_path = new_fp
        if r.cog_path:
            new_cog = rewrite(r.cog_path)
            if new_cog != r.cog_path:
                r.cog_path = new_cog


@router.post("/projects")
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_admin),
):
    project = Project(name=payload.name, tenant_id=user.tenant_id, owner_user_id=user.id, status="pendiente")
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name, "status": project.status, "owner_user_id": project.owner_user_id}


@router.get("/projects")
def list_projects(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(Project).filter(Project.tenant_id == user.tenant_id)
    if str(user.role).lower() == "cliente":
        linked_order_projects = (
            db.query(StudyOrder.project_id)
            .filter(
                StudyOrder.user_id == user.id,
                StudyOrder.project_id.isnot(None),
            )
        )
        # Todos los proyectos del cliente (dueño o vinculados por orden), con cualquier estado;
        # el estado se muestra en UI; el acceso a resultados publicados sigue filtrado en otros endpoints.
        q = q.filter(
            or_(
                Project.owner_user_id == user.id,
                Project.id.in_(linked_order_projects),
            ),
        )
    projects = q.order_by(Project.id.desc()).all()
    out = []
    for p in projects:
        owner = db.query(User).filter(User.id == p.owner_user_id).first() if p.owner_user_id else None
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "owner_user_id": p.owner_user_id,
                "owner_email": owner.email if owner else None,
                "status": p.status,
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "published_at": p.published_at.isoformat() if p.published_at else None,
            }
        )
    return out


@router.patch("/projects/{project_id}")
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    _admin: User = Depends(require_admin),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    old_name = project.name
    new_name = payload.name
    if new_name == old_name:
        return {"id": project.id, "name": project.name}

    old_slug = project_downloads_slug(old_name)
    new_slug = project_downloads_slug(new_name)
    if old_slug != new_slug:
        downloads_root = Path(settings.storage_path) / f"tenant_{tenant_id}" / f"project_{project_id}" / "downloads"
        old_path = downloads_root / old_slug
        new_path = downloads_root / new_slug
        if old_path.exists():
            if new_path.exists():
                raise HTTPException(
                    status_code=409,
                    detail="Ya existe una carpeta de descargas para el nuevo nombre. Elige otro nombre o elimina la carpeta duplicada en el servidor.",
                )
            downloads_root.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_path), str(new_path))
            _rewrite_raster_paths_after_downloads_move(db, tenant_id, project_id, old_path, new_path)

    project.name = new_name
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name}


@router.patch("/projects/{project_id}/status", response_model=ProjectSummary)
def patch_project_status(
    project_id: int,
    payload: ProjectStatusPatch,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == admin.tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    prev = project.status
    now = datetime.utcnow()
    project.status = payload.status
    if payload.status == "en proceso":
        project.processing_started_at = now
        project.processed_by_admin_id = admin.id
    if payload.status == "procesado":
        project.processing_completed_at = now
        project.processed_by_admin_id = admin.id
    if payload.status == "publicado":
        project.published_at = now
        project.approved_by_admin_id = admin.id
        owner = db.query(User).filter(User.id == project.owner_user_id).first()
        if owner:
            send_study_order_notification(
                order_id=project.id,
                user_email=owner.email,
                lines=[
                    f"Proyecto {project.name} publicado",
                    "Su polígono fue procesado y los resultados están disponibles en su dashboard.",
                    f"Proyecto ID: {project.id}",
                ],
            )
    db.add(
        ProjectProcessingLog(
            project_id=project.id,
            actor_admin_id=admin.id,
            stage="project_status",
            status="ok",
            details={"from": prev, "to": payload.status},
        )
    )
    db.commit()
    db.refresh(project)
    owner = db.query(User).filter(User.id == project.owner_user_id).first() if project.owner_user_id else None
    return {
        "id": project.id,
        "name": project.name,
        "owner_user_id": project.owner_user_id,
        "owner_email": owner.email if owner else None,
        "status": project.status,
        "created_at": project.created_at.isoformat() if project.created_at else None,
        "published_at": project.published_at.isoformat() if project.published_at else None,
    }


@router.post("/projects/{project_id}/processing-log", response_model=ProcessingLogEntry)
def append_processing_log(
    project_id: int,
    payload: ProcessingLogCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == admin.tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    latest_order = (
        db.query(StudyOrder)
        .filter(StudyOrder.project_id == project_id)
        .order_by(StudyOrder.created_at.desc())
        .first()
    )
    row = ProjectProcessingLog(
        project_id=project_id,
        order_id=latest_order.id if latest_order else None,
        actor_admin_id=admin.id,
        stage=str(payload.stage).strip().lower(),
        status=str(payload.status).strip().lower() or "ok",
        details=payload.details or {},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "project_id": row.project_id,
        "order_id": row.order_id,
        "actor_admin_id": row.actor_admin_id,
        "stage": row.stage,
        "status": row.status,
        "details": row.details or {},
        "created_at": row.created_at.isoformat() if row.created_at else "",
    }


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    _admin: User = Depends(require_admin),
):
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
