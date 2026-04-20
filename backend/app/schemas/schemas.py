from pydantic import BaseModel, EmailStr, Field, field_validator


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


class RefreshRequest(BaseModel):
    refresh_token: str


class ProjectCreate(BaseModel):
    name: str


class ProjectUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("Nombre vacío")
        return s


class PredictRequest(BaseModel):
    project_id: int
    model_type: str
    raster_layer_id: int


class DownloadRequest(BaseModel):
    project_id: int
    source: str
    start_date: str | None = None
    end_date: str | None = None
    layer_id: int | None = None


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


class S1GrdRecorteRequest(BaseModel):
    """Recorte (subset espacial) de productos Sentinel-1 GRD IW bajo ``downloads/<slug>/Sentinel1/``."""

    project_id: int
    layer_id: int | None = None
    product_paths: list[str] = Field(
        min_length=1,
        description="Rutas relativas a ``Sentinel1/`` (posix), p. ej. ``escena.SAFE`` o ``2026/01/escena.SAFE`` o ``x.zip``.",
    )


class S2L2aRecorteRequest(BaseModel):
    """Recorte de productos Sentinel-2 L2A en carpeta de descargas al polígono del proyecto."""

    project_id: int
    layer_id: int | None = None
    product_names: list[str] | None = Field(
        default=None,
        description="Basenames de .zip o carpetas .SAFE L2A a procesar. Si se omite, se procesan todos los hallados en descargas.",
    )
    source_subpath: str | None = Field(
        default=None,
        description=(
            "Ruta relativa (posix) bajo tenant_*/project_*/ donde buscar L2A. "
            "Si se omite, se usa la carpeta de descargas Sentinel por defecto (downloads/<slug>). "
            "Cadena vacía = raíz del proyecto."
        ),
    )


class S2IndexStacksRequest(BaseModel):
    """Stacks multibanda de índices de vegetación desde recortes L2A (6 bandas)."""

    project_id: int
    indices: list[str]
    raster_layer_ids: list[int] | None = Field(
        default=None,
        description="Solo estas capas raster (IDs del mapa). Omitir para autodetección en recortes/ y BD.",
    )
    recorte_filenames: list[str] | None = Field(
        default=None,
        description="Basenames de GeoTIFF en recortes/ (p. ej. escena_S2_recorte.tif). Si se envía, "
        "tiene prioridad sobre raster_layer_ids.",
    )


class VegetationTimeSeriesRequest(BaseModel):
    """Series temporales por índice desde recortes L2A (6 bandas).

    Por defecto devuelve **una serie por píxel** (muestreadas hasta ``max_pixel_series``) además de
    agregados por escena en ``points``.
    """

    project_id: int
    raster_layer_ids: list[int] = Field(..., min_length=1)
    max_pixel_series: int = Field(
        default=4000,
        ge=1,
        le=50_000,
        description="Máximo de píxeles para los que se devuelven series completas (todas las fechas).",
    )
    random_seed: int = Field(default=42, description="Semilla para el muestreo aleatorio de píxeles.")


class ClusterElbowRequest(BaseModel):
    """Método del codo (KMeans) sobre cada stack de índices y el recorte multibanda."""

    project_id: int
    k_min: int = 1
    k_max: int = 10
    max_samples: int = 100_000
    random_state: int = 42


class ClusterGmmRequest(BaseModel):
    """Clustering GMM por dataset; ``k_by_key`` debe incluir una K por cada clave devuelta en el codo."""

    project_id: int
    k_by_key: dict[str, int]
    max_samples: int = 100_000
    random_state: int = 42

    @field_validator("k_by_key")
    @classmethod
    def k_positive(cls, v: dict[str, int]) -> dict[str, int]:
        for key, k in v.items():
            if int(k) < 1:
                raise ValueError(f"K debe ser >= 1 ({key}={k})")
        return v
