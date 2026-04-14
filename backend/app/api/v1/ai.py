import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import _tenant_storage
from app.db.session import get_db
from app.models.models import AIResult, RasterLayer
from app.schemas.schemas import PredictRequest
from app.tasks.jobs import mock_inference

router = APIRouter()


@router.post("/ai/predict")
def predict(payload: PredictRequest, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    raster = (
        db.query(RasterLayer)
        .filter(
            RasterLayer.id == payload.raster_layer_id,
            RasterLayer.project_id == payload.project_id,
            RasterLayer.tenant_id == tenant_id,
        )
        .first()
    )
    if not raster:
        raise HTTPException(status_code=404, detail="Raster layer not found")

    output_json = _tenant_storage(tenant_id, payload.project_id, "ai") / f"result_{uuid.uuid4().hex}.json"
    task = mock_inference.delay(raster.file_path, str(output_json))
    record = AIResult(
        project_id=payload.project_id,
        tenant_id=tenant_id,
        model_type=payload.model_type,
        status="queued",
        output_path=str(output_json),
        metrics={"task_id": task.id},
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return {"result_id": record.id, "task_id": task.id}


@router.get("/ai/results/{project_id}")
def ai_results(project_id: int, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    results = (
        db.query(AIResult)
        .filter(AIResult.project_id == project_id, AIResult.tenant_id == tenant_id)
        .all()
    )
    out = []
    for result in results:
        metrics = result.metrics or {}
        path = Path(result.output_path) if result.output_path else None
        if path and path.exists():
            metrics = json.loads(path.read_text(encoding="utf-8"))
            result.status = "done"
            result.metrics = metrics
            db.add(result)
        out.append({"id": result.id, "model_type": result.model_type, "status": result.status, "metrics": metrics})
    db.commit()
    return out
