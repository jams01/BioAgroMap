from datetime import timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_token, decode_token
from app.db.session import get_db
from app.models.models import Project, StudyOrder, User

bearer = HTTPBearer(auto_error=False)


def issue_tokens(user: User, extra: dict | None = None):
    access = create_token(
        str(user.id),
        user.tenant_id,
        user.role,
        timedelta(minutes=settings.access_token_expire_minutes),
        "access",
    )
    refresh = create_token(
        str(user.id),
        user.tenant_id,
        user.role,
        timedelta(minutes=settings.refresh_token_expire_minutes),
        "refresh",
    )
    out = {"access_token": access, "refresh_token": refresh, "token_type": "bearer", "role": user.role}
    if extra:
        out.update(extra)
    return out


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    payload = decode_token(credentials.credentials)
    if payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    sub = payload.get("sub")
    token_tenant_id = payload.get("tenant_id")
    token_role = payload.get("role")
    if sub is None or token_tenant_id is None or token_role is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")
    try:
        token_user_id = int(sub)
        token_tenant_id = int(token_tenant_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")

    # Server-side session validation: never trust user identifiers from client.
    user = db.query(User).filter(User.id == token_user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")
    if user.id != token_user_id or user.tenant_id != token_tenant_id or user.role != str(token_role):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session/user mismatch")
    if not getattr(user, "is_active", True):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Cuenta inactiva")
    return user


def tenant_from_jwt(user: User = Depends(get_current_user)) -> int:
    return user.tenant_id


def assert_user_matches_session(user_id: int, user: User = Depends(get_current_user)) -> User:
    """
    Enforce `user.id == session.user.id` on endpoints that receive `user_id`.
    """
    if user.id != int(user_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden user scope")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if str(user.role).lower() != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required")
    return user


def assert_cliente_can_view_published_dashboard(db: Session, user: User, project: Project) -> None:
    """Cliente solo ve datos de proyectos publicados y con vínculo (dueño u orden de estudio)."""
    role = str(user.role or "").strip().lower()
    if role != "cliente":
        return
    st = str(project.status or "").strip().lower()
    if st != "publicado":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Los resultados de este proyecto no están publicados.",
        )
    owner_id = getattr(project, "owner_user_id", None)
    if owner_id is not None and int(owner_id) == int(user.id):
        return
    linked = (
        db.query(StudyOrder)
        .filter(
            StudyOrder.user_id == user.id,
            StudyOrder.project_id == project.id,
            StudyOrder.tenant_id == user.tenant_id,
        )
        .first()
    )
    if linked:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="No tienes acceso a los resultados de este proyecto.",
    )


def require_project_dashboard_access(
    db: Session,
    user: User,
    tenant_id: int,
    project_id: int,
) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    assert_cliente_can_view_published_dashboard(db, user, project)
    return project
