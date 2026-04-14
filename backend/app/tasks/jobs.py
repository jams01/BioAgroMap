import json
from pathlib import Path

import numpy as np
import rasterio

from app.tasks.celery_app import celery_app


@celery_app.task(name="tasks.process_raster")
def process_raster(file_path: str, output_path: str) -> dict:
    src_path = Path(file_path)
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with rasterio.open(src_path) as src:
        profile = src.profile.copy()
        profile.update({"driver": "GTiff", "compress": "lzw", "tiled": True})
        data = src.read()
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(data)
    return {"status": "done", "cog_path": str(out_path)}


@celery_app.task(name="tasks.mock_inference")
def mock_inference(input_raster: str, output_json: str) -> dict:
    with rasterio.open(input_raster) as src:
        band = src.read(1)
        metrics = {
            "accuracy": float(np.clip(band.mean() / 255.0, 0.55, 0.95)),
            "iou": 0.71,
            "f1_score": 0.81,
        }
    Path(output_json).parent.mkdir(parents=True, exist_ok=True)
    Path(output_json).write_text(json.dumps(metrics), encoding="utf-8")
    return metrics
