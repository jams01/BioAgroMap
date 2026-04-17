from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import issue_tokens
from app.core.security import decode_token, hash_password, verify_password
from app.db.session import get_db
from app.models.models import Tenant, User
from app.schemas.schemas import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse

router = APIRouter()


@router.post("/auth/register", response_model=TokenResponse)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    tenant = db.query(Tenant).filter(Tenant.name == payload.tenant_name).first()
    if tenant is None:
        tenant = Tenant(name=payload.tenant_name)
        db.add(tenant)
        db.flush()
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=400, detail="Email already exists")
    user = User(email=payload.email, hashed_password=hash_password(payload.password), tenant_id=tenant.id)
    db.add(user)
    db.commit()
    db.refresh(user)
    return issue_tokens(user)


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh_session(payload: RefreshRequest, db: Session = Depends(get_db)):
    """Emite nuevos access/refresh tokens a partir de un refresh token válido."""
    claims = decode_token(payload.refresh_token)
    if claims.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")
    user = db.query(User).filter(User.id == int(claims["sub"])).first()
    if not user:
        raise HTTPException(status_code=401, detail="Invalid user")
    return issue_tokens(user)


@router.post("/auth/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return issue_tokens(user)
