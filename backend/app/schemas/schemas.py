from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator


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


class PsPlanetZipExtractRequest(BaseModel):
    """Extrae ``composite.tif`` y metadatos desde zips PlanetScope en ``rasterPS/`` hacia ``recortesPS/``."""

    project_id: int


class S2L2aRecorteRequest(BaseModel):
    """Recorte de productos Sentinel-2 L2A en carpeta de descargas al polígono del proyecto."""

    project_id: int
    pipeline_variant: str = "s2"
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


class S1SarIndexStacksRequest(BaseModel):
    """Stacks multibanda de índices SAR (VV/VH sigma0 dB) desde ``s1prepoceso/``."""

    project_id: int
    indices: list[str] = Field(..., min_length=1, description="RVI, RFDI, VV_VH, VH_VV, NRPB y/o TODOS")
    scene_vv_relpaths: list[str] = Field(
        ...,
        min_length=1,
        description=(
            "Rutas relativas a ``Sigma0_VV_db.img`` bajo ``s1prepoceso/`` (una por escena). "
            "El VH de la misma escena se toma de ``Sigma0_VH_db.img`` en esa carpeta."
        ),
    )


class S2IndexStacksRequest(BaseModel):
    """Stacks multibanda de índices: L2A 6 bandas (S2) o PlanetScope 8 bandas (PS, carpetas indecesPS/)."""

    project_id: int
    pipeline_variant: str = "s2"
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


class RoiPointNormalized(BaseModel):
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)


class RoiSelectionNormalized(BaseModel):
    """ROI normalizado opcional en forma de rectángulo o polígono."""

    x1: float | None = Field(default=None, ge=0.0, le=1.0)
    y1: float | None = Field(default=None, ge=0.0, le=1.0)
    x2: float | None = Field(default=None, ge=0.0, le=1.0)
    y2: float | None = Field(default=None, ge=0.0, le=1.0)
    polygon_points: list[RoiPointNormalized] | None = Field(default=None, min_length=3)

    @model_validator(mode="after")
    def validate_bounds(self):
        rect_vals = (self.x1, self.y1, self.x2, self.y2)
        rect_defined = all(v is not None for v in rect_vals)
        if any(v is not None for v in rect_vals) and not rect_defined:
            raise ValueError("ROI inválido: define x1,y1,x2,y2 completos para rectángulo.")
        if rect_defined:
            assert self.x1 is not None and self.y1 is not None and self.x2 is not None and self.y2 is not None
            if self.x2 <= self.x1:
                raise ValueError("ROI inválido: x2 debe ser mayor que x1.")
            if self.y2 <= self.y1:
                raise ValueError("ROI inválido: y2 debe ser mayor que y1.")
        if not rect_defined and not self.polygon_points:
            raise ValueError("ROI inválido: define rectángulo o polygon_points.")
        return self


class VegetationTimeSeriesRequest(BaseModel):
    """Series temporales por índice desde recortes L2A (6 bandas) o PlanetScope (8 bandas).

    Por defecto devuelve **una serie por píxel** (muestreadas hasta ``max_pixel_series``) además de
    agregados por escena en ``points``.
    """

    project_id: int
    raster_layer_ids: list[int] = Field(default_factory=list)
    recorte_relative_paths: list[str] = Field(
        default_factory=list,
        description="Rutas relativas dentro de recortes/ o recortesPS/ (mismo ``relative_path`` que el inventario).",
    )
    pipeline_variant: str = Field(
        default="s2",
        description="s2 → L2A 6 bandas; ps → PlanetScope 8 bandas (índices del catálogo PS).",
    )
    max_pixel_series: int = Field(
        default=4000,
        ge=1,
        le=50_000,
        description="Máximo de píxeles para los que se devuelven series completas (todas las fechas).",
    )
    random_seed: int = Field(default=42, description="Semilla para el muestreo aleatorio de píxeles.")
    roi_selection: RoiSelectionNormalized | None = Field(
        default=None,
        description="ROI opcional: rectángulo (x1,y1,x2,y2) o polígono (polygon_points) en [0,1].",
    )

    @model_validator(mode="after")
    def at_least_one_scene_source(self):
        if not self.raster_layer_ids and not self.recorte_relative_paths:
            raise ValueError("Indica raster_layer_ids y/o recorte_relative_paths.")
        return self


class S1SarTimeSeriesRequest(BaseModel):
    """Series temporales desde stacks multibanda en ``s1indices/`` (RVI, RFDI, VV_VH, VH_VV, NRPB).

    Solo se usan fechas presentes en **los cinco** stacks (intersección de ``BAND_DATES_JSON``).
    """

    project_id: int
    dates: list[str] = Field(
        ...,
        min_length=1,
        description="Fechas ISO (YYYY-MM-DD) a incluir; deben existir en todos los índices SAR del proyecto.",
    )
    max_pixel_series: int = Field(
        default=4000,
        ge=1,
        le=50_000,
        description="Máximo de píxeles para los que se devuelven series completas (todas las fechas).",
    )
    random_seed: int = Field(default=42, description="Semilla para el muestreo aleatorio de píxeles.")
    roi_selection: RoiSelectionNormalized | None = Field(
        default=None,
        description="ROI opcional: rectángulo (x1,y1,x2,y2) o polígono (polygon_points) en [0,1].",
    )


class ClusterElbowRequest(BaseModel):
    """Método del codo (KMeans) sobre cada stack de índices y el recorte multibanda."""

    project_id: int
    pipeline_variant: str = "s2"
    selected_dates: list[str] | None = Field(
        default=None,
        description=(
            "Fechas ISO (YYYY-MM-DD) opcionales para filtrar bandas en stacks temporales "
            "(p. ej. s1indices/). Si se omite, se usan todas las bandas."
        ),
    )
    k_min: int = 1
    k_max: int = 10
    max_samples: int = 100_000
    random_state: int = 42


class ClusterGmmRequest(BaseModel):
    """Clustering GMM por dataset; ``k_by_key`` debe incluir una K por cada clave devuelta en el codo."""

    project_id: int
    pipeline_variant: str = "s2"
    selected_dates: list[str] | None = Field(
        default=None,
        description=(
            "Fechas ISO (YYYY-MM-DD) opcionales para filtrar bandas en stacks temporales "
            "(p. ej. s1indices/). Si se omite, se usan todas las bandas."
        ),
    )
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


class PsSpatiotemporalClusterRequest(BaseModel):
    """Parámetros KMeans; el conjunto de índices lo fija el query ``preset`` (smart1, smart2 o smart3)."""

    n_clusters: int = Field(default=4, ge=2, le=32)
    random_state: int = 42
