"""API: método del codo + GMM sobre índices y recorte multibanda Sentinel-2."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import _tenant_storage
from app.db.session import get_db
from app.models.models import Project
from app.schemas.schemas import ClusterElbowRequest, ClusterGmmRequest
from app.services import satellite_clustering as sc
from app.services.preprocess_pipeline_variant import (
    cluster_output_dir_name,
    indices_dir_name,
    normalize_pipeline_variant,
    recortes_dir_name,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _cluster_pipeline_variant(pipeline_variant: str = Query("s2", description="s2 o ps (carpetas ClusterPS / indecesPS / rasterPS)")) -> str:
    return normalize_pipeline_variant(pipeline_variant)

# Cambiar al añadir comportamiento visible (comprobar con GET /cluster-analysis/capabilities).
CLUSTER_PIPELINE_BUILD = "2026-04-16b.gmm-clear+paths+ui-proof"


@router.get("/cluster-analysis/capabilities")
def cluster_capabilities():
    """
    Sin autenticación: comprueba qué código está cargado en el servidor (útil con Docker/volúmenes).
    """
    import app.services.satellite_clustering as scm

    p = getattr(scm, "__file__", "")
    mtime = None
    try:
        mtime = os.path.getmtime(p) if p else None
    except OSError:
        pass
    return {
        "build": CLUSTER_PIPELINE_BUILD,
        "satellite_clustering_py": p,
        "satellite_clustering_mtime": mtime,
        "clears_cluster_gmm_before_run": hasattr(scm, "clear_cluster_gmm_dir"),
        "multiband_output_pattern": "DD-MM-YYYY_GMM_K{n}.tif",
    }


def _project_or_404(db: Session, project_id: int, tenant_id: int) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/cluster-analysis/datasets/{project_id}")
def list_cluster_datasets(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_cluster_pipeline_variant),
):
    _project_or_404(db, project_id, tenant_id)
    recortes = _tenant_storage(tenant_id, project_id, recortes_dir_name(pipeline_variant))
    indices = _tenant_storage(tenant_id, project_id, indices_dir_name(pipeline_variant))
    datasets = sc.discover_cluster_datasets(recortes, indices)
    logger.info("cluster datasets project=%s count=%s", project_id, len(datasets))
    return {"datasets": datasets}


@router.get("/cluster-analysis/gmm-results/{project_id}")
def get_cluster_gmm_results(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_cluster_pipeline_variant),
):
    """
    Lista resultados GMM ya guardados en ``cluster_gmm/`` o ``ClusterPS/`` (misma forma que POST /gmm),
    regenerando las miniaturas PNG desde los GeoTIFF en disco.
    """
    _project_or_404(db, project_id, tenant_id)
    out_dir = _tenant_storage(tenant_id, project_id, cluster_output_dir_name(pipeline_variant))
    results = sc.load_cluster_gmm_results_from_storage(out_dir)
    return {
        "project_id": project_id,
        "output_dir": str(Path(out_dir).resolve()),
        "cluster_gmm_absolute_path": str(Path(out_dir).resolve()),
        "pipeline_build": CLUSTER_PIPELINE_BUILD,
        "results": results,
        "reload_from_disk": True,
    }


@router.post("/cluster-analysis/elbow")
def cluster_elbow(
    payload: ClusterElbowRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    _project_or_404(db, payload.project_id, tenant_id)
    pv = normalize_pipeline_variant(payload.pipeline_variant)
    recortes = _tenant_storage(tenant_id, payload.project_id, recortes_dir_name(pv))
    indices = _tenant_storage(tenant_id, payload.project_id, indices_dir_name(pv))
    datasets = sc.discover_cluster_datasets(recortes, indices)
    if not datasets:
        raise HTTPException(
            status_code=400,
            detail="No hay GeoTIFF en la carpeta de índices ni recortes multibanda válidos en la carpeta de recortes del variant.",
        )

    results: list[dict] = []
    k_min, k_max = payload.k_min, payload.k_max
    if k_min < 1 or k_max < k_min or k_max > 50:
        raise HTTPException(status_code=400, detail="k_min/k_max inválidos (1 ≤ k_min ≤ k_max ≤ 50).")

    logger.info("cluster elbow project=%s datasets=%s K=%s..%s", payload.project_id, len(datasets), k_min, k_max)
    for ds in datasets:
        path = Path(ds["path"])
        try:
            r = sc.run_elbow_for_dataset(
                path,
                k_min=k_min,
                k_max=k_max,
                max_samples=payload.max_samples,
                random_state=payload.random_state,
            )
        except Exception as exc:
            logger.exception("Elbow falló %s", path)
            raise HTTPException(status_code=500, detail=f"Elbow falló ({ds.get('key')}): {exc}") from exc
        results.append(
            {
                "key": ds["key"],
                "kind": ds["kind"],
                "label": ds["label"],
                "path": ds["path"],
                **r,
            }
        )

    return {"project_id": payload.project_id, "datasets": results}


@router.post("/cluster-analysis/gmm")
def cluster_gmm(
    payload: ClusterGmmRequest,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    _project_or_404(db, payload.project_id, tenant_id)
    pv = normalize_pipeline_variant(payload.pipeline_variant)
    recortes = _tenant_storage(tenant_id, payload.project_id, recortes_dir_name(pv))
    indices = _tenant_storage(tenant_id, payload.project_id, indices_dir_name(pv))
    datasets = sc.discover_cluster_datasets(recortes, indices)
    if not datasets:
        raise HTTPException(status_code=400, detail="No hay datasets para clustering.")

    keys_found = {d["key"] for d in datasets}
    missing = keys_found - set(payload.k_by_key.keys())
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Faltan K en k_by_key para: {sorted(missing)}",
        )

    out_dir = _tenant_storage(tenant_id, payload.project_id, cluster_output_dir_name(pv))
    removed_n, out_abs = sc.clear_cluster_gmm_dir(out_dir)
    out_results: list[dict] = []
    logger.info(
        "cluster GMM project=%s out=%s eliminados=%s (carpeta vaciada antes de escribir)",
        payload.project_id,
        out_abs,
        removed_n,
    )

    for ds in datasets:
        key = ds["key"]
        k = int(payload.k_by_key[key])
        path = Path(ds["path"])
        try:
            dk = str(ds.get("kind") or "index").strip().lower()
            r = sc.run_gmm_for_dataset(
                path,
                n_components=k,
                max_samples=payload.max_samples,
                random_state=payload.random_state,
                out_dir=out_dir,
                key=key,
                dataset_kind=dk,
            )
        except Exception as exc:
            logger.exception("GMM falló %s", path)
            raise HTTPException(status_code=500, detail=f"GMM falló ({key}): {exc}") from exc
        out_results.append(
            {
                "key": key,
                "kind": ds["kind"],
                "label": ds["label"],
                **r,
            }
        )

    dashboard_b64 = ""
    try:
        items = [(f"{o['key']} Cluster", o["preview_png_base64"]) for o in out_results]
        dashboard_b64 = sc.plot_dashboard_grid_png(items)
    except Exception as exc:
        logger.warning("Panel resumen GMM no generado: %s", exc)

    return {
        "project_id": payload.project_id,
        "output_dir": str(Path(out_dir).resolve()),
        "cluster_gmm_cleared_count": removed_n,
        "cluster_gmm_absolute_path": out_abs,
        "pipeline_build": CLUSTER_PIPELINE_BUILD,
        "results": out_results,
        "dashboard_png_base64": dashboard_b64,
    }
