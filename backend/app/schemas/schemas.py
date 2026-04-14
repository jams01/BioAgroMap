from pydantic import BaseModel, EmailStr, field_validator


class RegisterRequest(BaseModel):
    tenant_name: str
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def password_strength(cls, v):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class ProjectCreate(BaseModel):
    name: str


class PredictRequest(BaseModel):
    project_id: int
    model_type: str
    raster_layer_id: int


class DownloadRequest(BaseModel):
    project_id: int
    source: str


class CropRequest(BaseModel):
    project_id: int
    raster_layer_id: int
    crop_ratio: float = 0.6


class IndicesRequest(BaseModel):
    project_id: int
    raster_layer_id: int
    index_type: str


class StackRequest(BaseModel):
    project_id: int
    mode: str


class ClusterRequest(BaseModel):
    project_id: int
    raster_layer_id: int
    clusters: int = 4
