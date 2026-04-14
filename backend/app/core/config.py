import logging
import os

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    app_name: str = "BioAgroMap API"
    api_v1_prefix: str = "/api/v1"
    secret_key: str = "change-me-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_minutes: int = 60 * 24 * 7
    database_url: str = "postgresql+psycopg2://postgres:postgres@localhost:5432/bioagromap"
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    redis_url: str = "redis://localhost:6379/0"
    ai_service_url: str = "http://localhost:8001"
    storage_path: str = "/data/storage"
    max_upload_mb: int = 100
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()

if settings.secret_key in {"change-me-in-production", "super-secret-dev-key"}:
    if os.getenv("ENV", "development") != "development":
        raise RuntimeError("SECRET_KEY must be changed for non-development environments")
    logger.warning("Using default SECRET_KEY — not safe for production")
