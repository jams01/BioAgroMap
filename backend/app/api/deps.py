from datetime import timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_token, decode_token
from app.db.session import get_db
from app.models.models import User

bearer = HTTPBearer(auto_error=False)


def issue_tokens(user: User):
    access = create_token(str(user.id), user.tenant_id, timedelta(minutes=settings.access_token_expire_minutes), "access")
    refresh = create_token(str(user.id), user.tenant_id, timedelta(minutes=settings.refresh_token_expire_minutes), "refresh")
    return {"access_token": access, "refresh_token": refresh, "token_type": "bearer"}


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing token")
    payload = decode_token(credentials.credentials)
    if payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid user")
    return user


def tenant_from_jwt(user: User = Depends(get_current_user)) -> int:
    return user.tenant_id
