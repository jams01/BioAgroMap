import logging
import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


def _default_storage_path() -> str:
    """
    Sin STORAGE_PATH en el entorno: misma carpeta que en compose (``./data:/data`` → ``/data/storage``)
    o, en desarrollo local, ``<repo>/data/storage`` (p. ej. recortes en tenant_X/project_Y/recortes).

    En contenedor suele existir ``/data/storage``; en el repo local suele existir ``…/BioAgroMap/backend``.
    """
    core_dir = Path(__file__).resolve().parent
    docker_root = Path("/data/storage")
    if len(core_dir.parents) > 2:
        repo = core_dir.parents[2]
        if (repo / "backend").is_dir():
            return str((repo / "data" / "storage").resolve())
        if (docker_root).is_dir():
            return str(docker_root.resolve())
    if docker_root.is_dir():
        return str(docker_root.resolve())
    if len(core_dir.parents) > 2:
        return str((core_dir.parents[2] / "data" / "storage").resolve())
    return "/data/storage"


def _env_files_for_settings() -> tuple[str, ...]:
    """Carga .env de backend/ y, si existe, de la raíz del repo. En Docker (/app/app/core) no hay parents[3]."""
    core = Path(__file__).resolve().parent
    candidates: list[Path] = []
    if len(core.parents) > 2:
        candidates.append(core.parents[2] / ".env")  # …/backend/.env
    if len(core.parents) > 3:
        candidates.append(core.parents[3] / ".env")  # …/repo/.env (solo en árbol profundo)
    return tuple(str(p) for p in candidates if p.is_file())


def _settings_model_config() -> SettingsConfigDict:
    kw: dict = {"env_file_encoding": "utf-8", "extra": "ignore"}
    ef = _env_files_for_settings()
    if ef:
        kw["env_file"] = ef
    return SettingsConfigDict(**kw)


class Settings(BaseSettings):
    app_name: str = "BioAgroMap API"
    api_v1_prefix: str = "/api/v1"
    secret_key: str = "change-me-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 120
    refresh_token_expire_minutes: int = 60 * 24 * 7
    database_url: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/bioagromap"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000"
    redis_url: str = "redis://localhost:6379/0"
    ai_service_url: str = "http://localhost:8001"
    storage_path: str = Field(default_factory=_default_storage_path)
    max_upload_mb: int = 4096  # Sentinel-2 ZIP; variable de entorno MAX_UPLOAD_MB tiene prioridad
    copernicus_user: str = ""
    copernicus_password: str = ""
    model_config = _settings_model_config()


settings = Settings()


def get_max_upload_mb() -> int:
    """Prioridad: variable de entorno MAX_UPLOAD_MB (Docker/compose), luego Settings."""
    raw = os.environ.get("MAX_UPLOAD_MB", "").strip()
    if raw:
        try:
            v = int(raw)
            return max(1, v)
        except ValueError:
            pass
    return max(1, int(settings.max_upload_mb))


if settings.secret_key in {"change-me-in-production", "super-secret-dev-key"}:
    if os.getenv("ENV", "development") != "development":
        raise RuntimeError("SECRET_KEY must be changed for non-development environments")
    logger.warning("Using default SECRET_KEY — not safe for production")
