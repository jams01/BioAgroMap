import json
import logging
import shutil
import tempfile
import zipfile
from datetime import date, datetime
from pathlib import Path

import geopandas as gpd
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_admin
from app.api.v1.helpers import _tenant_storage
from app.api.v1.helpers import validate_upload_size
from app.api.v1.layers import _kml_to_geojson
from app.core.order_email import send_study_order_notification
from app.db.session import get_db
from app.models.models import Layer, Project, ProjectProcessingLog, StudyOrder, User
from app.schemas.schemas import StudyOrderCreate, StudyOrderDetail, StudyOrderStatusPatch, StudyOrderSummary

router = APIRouter()
logger = logging.getLogger(__name__)


def _normalize_geometry(raw: dict) -> dict:
    try:
        t = raw.get("type")
        if t == "FeatureCollection":
            gdf = gpd.GeoDataFrame.from_features(raw["features"], crs="EPSG:4326")
        elif t == "Feature":
            gdf = gpd.GeoDataFrame.from_features([raw], crs="EPSG:4326")
        elif t in ("Polygon", "MultiPolygon"):
            gdf = gpd.GeoDataFrame.from_features(
                [{"type": "Feature", "properties": {}, "geometry": raw}],
                crs="EPSG:4326",
            )
        else:
            raise ValueError(f"tipo GeoJSON no soportado: {t}")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("GeoJSON inválido: %s", e)
        raise HTTPException(status_code=422, detail="GeoJSON inválido o no compatible") from e
    if gdf.empty:
        raise HTTPException(status_code=422, detail="Sin geometrías")
    try:
        if gdf.crs is not None:
            gdf = gdf.to_crs(4326)
    except Exception:
        pass
    for geom in gdf.geometry:
        if geom is None or geom.is_empty:
            raise HTTPException(status_code=422, detail="Geometría vacía")
        if geom.geom_type not in ("Polygon", "MultiPolygon"):
            raise HTTPException(status_code=422, detail="Solo se permiten polígonos o multipolígonos")
    return json.loads(gdf.to_json())


def _parse_uploaded_vector(path: Path) -> dict:
    ext = path.suffix.lower()
    if ext in {".geojson", ".json"}:
        return json.loads(path.read_text(encoding="utf-8"))
    if ext == ".kml":
        r = _kml_to_geojson(path.read_text(encoding="utf-8"))
        if not r:
            raise HTTPException(status_code=422, detail="No se pudo interpretar el KML")
        return r
    if ext == ".kmz":
        with zipfile.ZipFile(path) as zf:
            for name in zf.namelist():
                if ".." in name or name.startswith(("/", "\\")):
                    continue
                if name.lower().endswith(".kml"):
                    r = _kml_to_geojson(zf.read(name).decode("utf-8"))
                    if r:
                        return r
        raise HTTPException(status_code=422, detail="KMZ sin KML válido")
    if ext in {".zip", ".shp"}:
        try:
            gdf = gpd.read_file(path)
        except Exception as e:
            raise HTTPException(
                status_code=422,
                detail="No se pudo leer el shapefile. Use .zip con .shp, .dbf y .shx o un KML/KMZ.",
            ) from e
        if gdf.empty:
            raise HTTPException(status_code=422, detail="Capa vectorial vacía")
        if gdf.crs is not None:
            gdf = gdf.to_crs(4326)
        return json.loads(gdf.to_json())
    raise HTTPException(status_code=400, detail="Formato no soportado (.kml, .kmz, .shp, .zip, .geojson)")


@router.post("/study-orders/parse-vector")
async def parse_study_vector(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    _ = user
    await validate_upload_size(file)
    ext = Path(file.filename or "vector").suffix.lower()
    if ext not in {".kml", ".kmz", ".shp", ".zip", ".geojson", ".json"}:
        raise HTTPException(status_code=400, detail="Extensión no permitida")
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp_path = Path(tmp.name)
            shutil.copyfileobj(file.file, tmp)
    finally:
        await file.close()
    try:
        gj = _parse_uploaded_vector(tmp_path)
        normalized = _normalize_geometry(gj)
        return JSONResponse(normalized)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def _order_to_detail(o: StudyOrder, email: str) -> dict:
    project_name = getattr(o, "_project_name", None)
    return {
        "id": o.id,
        "user_id": o.user_id,
        "user_email": email,
        "project_id": o.project_id,
        "project_name": project_name,
        "applicant_name": o.applicant_name,
        "applicant_phone": o.applicant_phone,
        "company": o.company,
        "crop": o.crop,
        "age_years": o.age_years,
        "study_date_start": o.study_date_start.isoformat() if o.study_date_start else "",
        "study_date_end": o.study_date_end.isoformat() if o.study_date_end else "",
        "has_weather_data": bool(o.has_weather_data),
        "has_soil_data": bool(o.has_soil_data),
        "extra_notes": o.extra_notes,
        "geometry": o.geometry_geojson or {},
        "status": o.status,
        "assigned_admin_id": o.assigned_admin_id,
        "processing_started_at": o.processing_started_at.isoformat() if o.processing_started_at else None,
        "processing_completed_at": o.processing_completed_at.isoformat() if o.processing_completed_at else None,
        "created_at": o.created_at.isoformat() if o.created_at else "",
    }


@router.post("/study-orders", response_model=StudyOrderDetail)
def create_study_order(
    payload: StudyOrderCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        ds = date.fromisoformat(str(payload.study_date_start)[:10])
        de = date.fromisoformat(str(payload.study_date_end)[:10])
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Fechas inválidas (use YYYY-MM-DD)") from e
    if ds > de:
        raise HTTPException(status_code=400, detail="La fecha de inicio no puede ser posterior a la fecha final")
    geom = _normalize_geometry(payload.geometry)
    # 1) creación automática de proyecto del cliente (nombre elegido en la solicitud)
    project_name = (payload.project_name or "").strip()
    if not project_name:
        raise HTTPException(status_code=422, detail="Indique un nombre para el proyecto")
    project = Project(
        name=project_name,
        owner_user_id=user.id,
        tenant_id=user.tenant_id,
        status="pendiente",
    )
    db.add(project)
    db.flush()
    # Persistimos el polígono como capa vectorial inicial del proyecto
    out_dir = _tenant_storage(user.tenant_id, project.id, "vectors")
    geojson_path = out_dir / "cliente_poligono_inicial.geojson"
    geojson_path.write_text(json.dumps(geom), encoding="utf-8")
    db.add(
        Layer(
            project_id=project.id,
            tenant_id=user.tenant_id,
            name="Poligono cliente",
            file_path=str(geojson_path),
            geom_type="Vector",
            layer_metadata={"source_name": "cliente_poligono_inicial.geojson", "auto_created": True},
        )
    )
    # 2) generación automática de orden asociada a proyecto
    applicant_name = (payload.applicant_name or "").strip() or (user.full_name or "").strip() or user.email
    applicant_phone = (payload.applicant_phone or "").strip() or (user.email or "")[:50]
    if not applicant_phone:
        applicant_phone = "—"
    row = StudyOrder(
        user_id=user.id,
        project_id=project.id,
        tenant_id=user.tenant_id,
        applicant_name=applicant_name,
        applicant_phone=applicant_phone,
        company=(payload.company or None),
        crop=(payload.crop or None),
        age_years=payload.age_years,
        study_date_start=ds,
        study_date_end=de,
        has_weather_data=bool(payload.has_weather_data),
        has_soil_data=bool(payload.has_soil_data),
        extra_notes=payload.extra_notes,
        geometry_geojson=geom,
        status="pendiente",
    )
    db.add(row)
    db.flush()
    db.add(
        ProjectProcessingLog(
            project_id=project.id,
            order_id=row.id,
            actor_admin_id=None,
            stage="order_created",
            status="ok",
            details={"project_status": project.status, "order_status": row.status},
        )
    )
    db.commit()
    db.refresh(row)
    row._project_name = project.name
    yn = lambda b: "Sí" if b else "No"
    lines = [
        f"Nueva solicitud AgroGeoFísico #{row.id}",
        f"Proyecto: {project.name} (id {project.id})",
        f"Correo del usuario: {user.email}",
        f"Solicitante: {row.applicant_name}",
        f"Contacto (cuenta / celular): {row.applicant_phone}",
        f"Empresa: {row.company or '—'}",
        f"Fechas del estudio: {ds.isoformat()} → {de.isoformat()}",
        f"Cultivo: {row.crop or '—'}",
        f"Edad (cultivo): {row.age_years if row.age_years is not None else '—'}",
        f"Datos meteorológicos: {yn(row.has_weather_data)}",
        f"Datos de suelo: {yn(row.has_soil_data)}",
        f"Información adicional:\n{row.extra_notes or '—'}",
    ]
    send_study_order_notification(order_id=row.id, user_email=user.email, lines=lines)
    return _order_to_detail(row, user.email)


@router.get("/study-orders", response_model=list[StudyOrderSummary])
def list_study_orders(db: Session = Depends(get_db), _admin: User = Depends(require_admin)):
    rows = db.query(StudyOrder).order_by(StudyOrder.created_at.desc()).all()
    out = []
    for o in rows:
        u = db.query(User).filter(User.id == o.user_id).first()
        p = db.query(Project).filter(Project.id == o.project_id).first() if o.project_id else None
        out.append(
            {
                "id": o.id,
                "user_email": u.email if u else "",
                "project_id": o.project_id,
                "project_name": p.name if p else None,
                "created_at": o.created_at.isoformat() if o.created_at else "",
                "crop": o.crop,
                "status": o.status,
            }
        )
    return out


@router.get("/study-orders/{order_id}", response_model=StudyOrderDetail)
def get_study_order(
    order_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    o = db.query(StudyOrder).filter(StudyOrder.id == order_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    u = db.query(User).filter(User.id == o.user_id).first()
    p = db.query(Project).filter(Project.id == o.project_id).first() if o.project_id else None
    o._project_name = p.name if p else None
    return _order_to_detail(o, u.email if u else "")


@router.patch("/study-orders/{order_id}", response_model=StudyOrderDetail)
def patch_study_order_status(
    order_id: int,
    payload: StudyOrderStatusPatch,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    o = db.query(StudyOrder).filter(StudyOrder.id == order_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    prev = o.status
    o.status = payload.status
    now = datetime.utcnow()
    if payload.status == "pendiente":
        if o.project_id:
            p = db.query(Project).filter(Project.id == o.project_id).first()
            if p:
                p.status = "pendiente"
                db.add(p)
    if payload.status == "procesado":
        o.assigned_admin_id = _admin.id
        o.processing_completed_at = now
        if not o.processing_started_at:
            o.processing_started_at = now
        if o.project_id:
            p = db.query(Project).filter(Project.id == o.project_id).first()
            if p:
                p.status = "procesado"
                if not p.processing_started_at:
                    p.processing_started_at = now
                p.processing_completed_at = now
                p.processed_by_admin_id = _admin.id
                db.add(p)
    if payload.status == "publicado":
        o.assigned_admin_id = _admin.id
        if not o.processing_started_at:
            o.processing_started_at = now
        if not o.processing_completed_at:
            o.processing_completed_at = now
        if o.project_id:
            p = db.query(Project).filter(Project.id == o.project_id).first()
            if p:
                p.status = "publicado"
                if not p.processing_started_at:
                    p.processing_started_at = now
                if not p.processing_completed_at:
                    p.processing_completed_at = now
                if not p.published_at:
                    p.published_at = now
                p.processed_by_admin_id = _admin.id
                p.approved_by_admin_id = _admin.id
                db.add(p)
    if o.project_id:
        db.add(
            ProjectProcessingLog(
                project_id=o.project_id,
                order_id=o.id,
                actor_admin_id=_admin.id,
                stage="order_status",
                status="ok",
                details={"from": prev, "to": payload.status},
            )
        )
    db.add(o)
    db.commit()
    db.refresh(o)
    u = db.query(User).filter(User.id == o.user_id).first()
    p = db.query(Project).filter(Project.id == o.project_id).first() if o.project_id else None
    o._project_name = p.name if p else None
    return _order_to_detail(o, u.email if u else "")


@router.get("/study-orders/{order_id}/processing-log")
def get_order_processing_log(
    order_id: int,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    order = db.query(StudyOrder).filter(StudyOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    if not order.project_id:
        return []
    rows = (
        db.query(ProjectProcessingLog)
        .filter(ProjectProcessingLog.project_id == order.project_id)
        .order_by(ProjectProcessingLog.created_at.asc())
        .all()
    )
    return [
        {
            "id": r.id,
            "project_id": r.project_id,
            "order_id": r.order_id,
            "actor_admin_id": r.actor_admin_id,
            "stage": r.stage,
            "status": r.status,
            "details": r.details or {},
            "created_at": r.created_at.isoformat() if r.created_at else "",
        }
        for r in rows
    ]
