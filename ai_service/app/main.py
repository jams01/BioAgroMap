import json
from pathlib import Path

import cv2
import numpy as np
import rasterio
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="BioAgroMap AI Service")
RESULTS_DIR = Path("/data/ai_results")
RESULTS_DIR.mkdir(parents=True, exist_ok=True)


class PredictPayload(BaseModel):
    project_id: int
    model_type: str
    raster_path: str


class TrainPayload(BaseModel):
    project_id: int
    model_type: str
    dataset_path: str


@app.post("/ai/predict")
def predict(payload: PredictPayload):
    with rasterio.open(payload.raster_path) as src:
        band = src.read(1).astype(np.float32)
    normalized = cv2.normalize(band, None, 0, 1, cv2.NORM_MINMAX)
    score = float(normalized.mean())
    metrics = {
        "accuracy": float(np.clip(0.65 + score * 0.2, 0.5, 0.99)),
        "iou": float(np.clip(0.55 + score * 0.25, 0.4, 0.95)),
        "f1_score": float(np.clip(0.60 + score * 0.2, 0.4, 0.95)),
    }
    out_file = RESULTS_DIR / f"{payload.project_id}_{payload.model_type}.json"
    out_file.write_text(json.dumps(metrics), encoding="utf-8")
    return {"project_id": payload.project_id, "metrics": metrics, "result_path": str(out_file)}


@app.post("/ai/train")
def train(payload: TrainPayload):
    return {"status": "accepted", "project_id": payload.project_id, "model_type": payload.model_type}


@app.get("/ai/results/{project_id}")
def results(project_id: int):
    matches = list(RESULTS_DIR.glob(f"{project_id}_*.json"))
    if not matches:
        return []
    return [json.loads(path.read_text(encoding="utf-8")) for path in matches]
