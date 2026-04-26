"""API: método del codo + GMM sobre stacks de índices (S2/PS/S1) y recortes multibanda (S2/PS)."""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

import numpy as np
from rasterio.enums import Resampling
from rasterio.warp import reproject
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_project_dashboard_access, tenant_from_jwt
from app.api.v1.helpers import _tenant_storage
from app.db.session import get_db
from app.models.models import Project, User
from app.schemas.schemas import ClusterElbowRequest, ClusterGmmRequest
from app.services import satellite_clustering as sc
from app.services.preprocess_pipeline_variant import (
    cluster_output_dir_name,
    indices_dir_name,
    normalize_pipeline_variant,
    recortes_dir_name,
)
from app.services.s1_sar_indices import (
    discover_s1_prep_sar_scenes,
    read_vv_vh_pair_aligned,
    write_s1_sar_multiband_stack,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _cluster_pipeline_variant(
    pipeline_variant: str = Query("s2", description="s2, ps o s1"),
) -> str:
    v = (pipeline_variant or "s2").strip().lower()
    return "s1" if v == "s1" else normalize_pipeline_variant(v)


def _cluster_out_dir_name(variant: str) -> str:
    return "cluster_s1_gmm" if variant == "s1" else cluster_output_dir_name(variant)


def _discover_ps_index_datasets_only(tenant_id: int, project_id: int) -> list[dict]:
    """
    PS: cluster únicamente sobre stacks de índices en ``indecesPS/``.
    No incluir recortes multibanda en este flujo.
    """
    recortes = _tenant_storage(tenant_id, project_id, recortes_dir_name("ps"))
    indices = _tenant_storage(tenant_id, project_id, indices_dir_name("ps"))
    all_ds = sc.discover_cluster_datasets(recortes, indices)
    return [d for d in all_ds if str(d.get("kind", "")).lower() == "index"]


def _norm_iso_date(s: str) -> str:
    t = str(s).strip()
    return t[:10] if len(t) >= 10 else t


def _resample_to_ref_grid(
    arr: np.ndarray,
    src_profile: dict,
    ref_profile: dict,
) -> np.ndarray:
    """Reproyecta una banda float32 al grid de referencia con vecino más cercano."""
    out = np.empty((int(ref_profile["height"]), int(ref_profile["width"])), dtype=np.float32)
    out.fill(np.nan)
    reproject(
        source=arr.astype(np.float32),
        destination=out,
        src_transform=src_profile["transform"],
        src_crs=src_profile["crs"],
        dst_transform=ref_profile["transform"],
        dst_crs=ref_profile["crs"],
        resampling=Resampling.nearest,
    )
    return out


def _build_s1_virtual_sigma_stacks(
    tenant_id: int,
    project_id: int,
    selected_dates: list[str] | None,
) -> list[dict]:
    """
    Construye stacks virtuales multibanda VV y VH (una banda por fecha) desde ``s1prepoceso/``.
    Se guardan en ``cluster_s1_virtual/`` para alimentar codo + GMM igual que los índices SAR.
    """
    prep_root = _tenant_storage(tenant_id, project_id, "s1prepoceso")
    virtual_root = _tenant_storage(tenant_id, project_id, "cluster_s1_virtual")
    scenes = discover_s1_prep_sar_scenes(tenant_id, project_id)
    if not scenes:
        return []

    wanted = {_norm_iso_date(d) for d in (selected_dates or []) if str(d).strip()}
    by_date: dict[str, dict] = {}
    for scene in scenes:
        d = _norm_iso_date(scene.get("sort_key", ""))
        if d == "1900-01-01":
            continue
        if wanted and d not in wanted:
            continue
        if d not in by_date:
            by_date[d] = scene
    dates = sorted(by_date.keys())
    if not dates:
        return []

    vv_bands: list[np.ndarray] = []
    vh_bands: list[np.ndarray] = []
    used_dates: list[str] = []
    ref_profile: dict | None = None

    for d in dates:
        scene = by_date[d]
        vv_path = prep_root / str(scene["scene_vv_relpath"]).replace("\\", "/")
        vh_path = prep_root / str(scene["scene_vh_relpath"]).replace("\\", "/")
        if not vv_path.is_file() or not vh_path.is_file():
            continue
        vv_arr, vh_arr, prof = read_vv_vh_pair_aligned(vv_path, vh_path)
        if ref_profile is None:
            ref_profile = prof.copy()
            vv_bands.append(vv_arr.astype(np.float32))
            vh_bands.append(vh_arr.astype(np.float32))
            used_dates.append(d)
            continue
        if vv_arr.shape != (int(ref_profile["height"]), int(ref_profile["width"])):
            vv_arr = _resample_to_ref_grid(vv_arr, prof, ref_profile)
            vh_arr = _resample_to_ref_grid(vh_arr, prof, ref_profile)
        vv_bands.append(vv_arr.astype(np.float32))
        vh_bands.append(vh_arr.astype(np.float32))
        used_dates.append(d)

    if not vv_bands or ref_profile is None or not used_dates:
        return []

    if virtual_root.exists():
        shutil.rmtree(virtual_root, ignore_errors=True)
    virtual_root.mkdir(parents=True, exist_ok=True)

    d0 = used_dates[0].replace("-", "")
    d1 = used_dates[-1].replace("-", "")
    vv_out = virtual_root / "VV" / f"VV_{d0}_{d1}.tif"
    vh_out = virtual_root / "VH" / f"VH_{d0}_{d1}.tif"
    write_s1_sar_multiband_stack(vv_out, vv_bands, ref_profile, "VV", used_dates)
    write_s1_sar_multiband_stack(vh_out, vh_bands, ref_profile, "VH", used_dates)

    return [
        {"key": "VV", "kind": "index", "path": str(vv_out.resolve()), "label": "Sigma0 VV"},
        {"key": "VH", "kind": "index", "path": str(vh_out.resolve()), "label": "Sigma0 VH"},
    ]

# Cambiar al añadir comportamiento visible (comprobar con GET /cluster-analysis/capabilities).
CLUSTER_PIPELINE_BUILD = "2026-04-22a.s1-cluster-dates"


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


def _project_or_404(db: Session, user: User, project_id: int, tenant_id: int) -> Project:
    return require_project_dashboard_access(db, user, tenant_id, project_id)


@router.get("/cluster-analysis/datasets/{project_id}")
def list_cluster_datasets(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_cluster_pipeline_variant),
):
    _project_or_404(db, user, project_id, tenant_id)
    if pipeline_variant == "s1":
        s1indices = _tenant_storage(tenant_id, project_id, "s1indices")
        datasets = sc.discover_s1_cluster_datasets(s1indices)
        datasets.extend(_build_s1_virtual_sigma_stacks(tenant_id, project_id, selected_dates=None))
    elif pipeline_variant == "ps":
        datasets = _discover_ps_index_datasets_only(tenant_id, project_id)
    else:
        recortes = _tenant_storage(tenant_id, project_id, recortes_dir_name(pipeline_variant))
        indices = _tenant_storage(tenant_id, project_id, indices_dir_name(pipeline_variant))
        datasets = sc.discover_cluster_datasets(recortes, indices)
    logger.info("cluster datasets project=%s count=%s", project_id, len(datasets))
    return {"datasets": datasets}


@router.get("/cluster-analysis/gmm-results/{project_id}")
def get_cluster_gmm_results(
    project_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    tenant_id: int = Depends(tenant_from_jwt),
    pipeline_variant: str = Depends(_cluster_pipeline_variant),
):
    """
    Lista resultados GMM ya guardados en ``cluster_gmm/`` o ``ClusterPS/`` (misma forma que POST /gmm),
    regenerando las miniaturas PNG desde los GeoTIFF en disco.
    """
    _project_or_404(db, user, project_id, tenant_id)
    out_dir = _tenant_storage(tenant_id, project_id, _cluster_out_dir_name(pipeline_variant))
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
    user: User = Depends(get_current_user),
    tenant_id: int = Depends(tenant_from_jwt),
):
    _project_or_404(db, user, payload.project_id, tenant_id)
    pv = _cluster_pipeline_variant(payload.pipeline_variant)
    if pv == "s1":
        s1indices = _tenant_storage(tenant_id, payload.project_id, "s1indices")
        datasets = sc.discover_s1_cluster_datasets(s1indices)
        datasets.extend(_build_s1_virtual_sigma_stacks(tenant_id, payload.project_id, payload.selected_dates))
    elif pv == "ps":
        datasets = _discover_ps_index_datasets_only(tenant_id, payload.project_id)
    else:
        recortes = _tenant_storage(tenant_id, payload.project_id, recortes_dir_name(pv))
        indices = _tenant_storage(tenant_id, payload.project_id, indices_dir_name(pv))
        datasets = sc.discover_cluster_datasets(recortes, indices)
    if not datasets:
        detail = (
            "No hay stacks de índices en indecesPS/. Primero ejecuta el paso 3 (Estimar índices PS)."
            if pv == "ps"
            else "No hay datasets para cluster en el variant seleccionado."
        )
        raise HTTPException(
            status_code=400,
            detail=detail,
        )

    results: list[dict] = []
    k_min, k_max = payload.k_min, payload.k_max
    if k_min < 1 or k_max < k_min or k_max > 50:
        raise HTTPException(status_code=400, detail="k_min/k_max inválidos (1 ≤ k_min ≤ k_max ≤ 50).")

    logger.info("cluster elbow project=%s datasets=%s K=%s..%s", payload.project_id, len(datasets), k_min, k_max)
    for ds in datasets:
        path = Path(ds["path"])
        try:
            band_indexes = sc.band_indexes_from_dates(path, payload.selected_dates) if pv == "s1" else None
            r = sc.run_elbow_for_dataset(
                path,
                k_min=k_min,
                k_max=k_max,
                max_samples=payload.max_samples,
                random_state=payload.random_state,
                band_indexes=band_indexes,
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
    user: User = Depends(get_current_user),
    tenant_id: int = Depends(tenant_from_jwt),
):
    _project_or_404(db, user, payload.project_id, tenant_id)
    pv = _cluster_pipeline_variant(payload.pipeline_variant)
    if pv == "s1":
        s1indices = _tenant_storage(tenant_id, payload.project_id, "s1indices")
        datasets = sc.discover_s1_cluster_datasets(s1indices)
        datasets.extend(_build_s1_virtual_sigma_stacks(tenant_id, payload.project_id, payload.selected_dates))
    elif pv == "ps":
        datasets = _discover_ps_index_datasets_only(tenant_id, payload.project_id)
    else:
        recortes = _tenant_storage(tenant_id, payload.project_id, recortes_dir_name(pv))
        indices = _tenant_storage(tenant_id, payload.project_id, indices_dir_name(pv))
        datasets = sc.discover_cluster_datasets(recortes, indices)
    if not datasets:
        detail = (
            "No hay stacks de índices en indecesPS/. Primero ejecuta el paso 3 (Estimar índices PS)."
            if pv == "ps"
            else "No hay datasets para clustering."
        )
        raise HTTPException(status_code=400, detail=detail)

    keys_found = {d["key"] for d in datasets}
    missing = keys_found - set(payload.k_by_key.keys())
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Faltan K en k_by_key para: {sorted(missing)}",
        )

    out_dir = _tenant_storage(tenant_id, payload.project_id, _cluster_out_dir_name(pv))
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
            band_indexes = sc.band_indexes_from_dates(path, payload.selected_dates) if pv == "s1" else None
            r = sc.run_gmm_for_dataset(
                path,
                n_components=k,
                max_samples=payload.max_samples,
                random_state=payload.random_state,
                out_dir=out_dir,
                key=key,
                dataset_kind=dk,
                band_indexes=band_indexes,
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
