from __future__ import annotations

import shutil
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.deps import tenant_from_jwt
from app.api.v1.helpers import (
    _existing_raster_path,
    _get_project_raster,
    _tenant_storage,
    is_legacy_s2_zip_band_raster,
    project_downloads_dir,
    validate_upload_size,
)
from app.core.config import settings
from app.db.session import get_db
from app.models.models import Project, RasterLayer
from app.services.raster_geo import bounds_wgs84_from_path, render_raster_preview_png
from app.services.s2_composites import (
    s2_acquisition_date_label,
    s2_date_slug_for_filename,
)
from app.services.sentinel_safe import (
    S2_BANDS_10M_ORDER,
    find_safe_ancestor,
    find_sentinel_r10_band_files,
    safe_extract_zip,
)
from app.tasks.jobs import process_raster, process_s2_zip_layers

router = APIRouter()


def _raster_chronological_sort_key(raster: RasterLayer) -> str:
    """Clave ISO YYYY-MM-DD para ordenar recortes S2 y otros rasters por fecha de escena."""
    meta = raster.raster_metadata or {}
    sk = meta.get("s2_sort_key")
    if isinstance(sk, str) and sk.strip():
        return sk.strip()
    dl = meta.get("s2_date_label")
    if isinstance(dl, str) and dl.count("/") == 2:
        parts = [p.strip() for p in dl.split("/")]
        if len(parts) == 3:
            dd, mm, yyyy = parts[0], parts[1], parts[2]
            if len(yyyy) == 4 and len(mm) <= 2 and len(dd) <= 2:
                return f"{yyyy}-{mm.zfill(2)}-{dd.zfill(2)}"
    if raster.created_at:
        return raster.created_at.isoformat()
    return f"id_{raster.id:010d}"


def _remove_extract_dir_if_no_other_layers(
    db: Session, project_id: int, tenant_id: int, raster: RasterLayer
) -> None:
    """Elimina la carpeta descomprimida solo cuando no queda ninguna capa que la use."""
    meta = raster.raster_metadata or {}
    ex = meta.get("extract_dir")
    if not ex:
        return
    rid = raster.id
    for other in (
        db.query(RasterLayer)
        .filter(
            RasterLayer.project_id == project_id,
            RasterLayer.tenant_id == tenant_id,
            RasterLayer.id != rid,
        )
        .all()
    ):
        if (other.raster_metadata or {}).get("extract_dir") == ex:
            return
    try:
        ep = Path(ex).resolve()
        root = Path(settings.storage_path).resolve()
        if str(ep).startswith(str(root)) and ep.is_dir():
            shutil.rmtree(ep, ignore_errors=True)
    except Exception:
        pass


@router.get("/raster/project-downloads-inventory/{project_id}")
def project_downloads_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Lista productos L2A en la carpeta de descargas del proyecto: ZIP MSIL2A y carpetas .SAFE,
    más otros archivos de primer nivel (para comprobar qué hay antes de recortar).
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    root = project_downloads_dir(tenant_id, project_id, project.name)
    out: dict = {
        "downloads_dir": str(root),
        "exists": root.is_dir(),
        "zip_l2a": [],
        "safe_folders": [],
        "other_top_level": [],
    }
    if not root.is_dir():
        return out
    try:
        for p in sorted(root.iterdir()):
            if p.is_file():
                if p.suffix.lower() == ".zip" and "MSIL2A" in p.name.upper():
                    try:
                        sz = p.stat().st_size
                    except OSError:
                        sz = 0
                    out["zip_l2a"].append({"name": p.name, "size_bytes": sz})
                else:
                    out["other_top_level"].append(p.name)
            elif p.is_dir():
                if p.name.upper().endswith(".SAFE") and "MSIL2A" in p.name.upper():
                    out["safe_folders"].append(p.name)
                else:
                    out["other_top_level"].append(p.name + "/")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return out


@router.get("/raster/project-downloads/{project_id}")
def list_project_download_files(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """List files in the project's Sentinel-2 download folder (not shown as map layers until imported)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    d = project_downloads_dir(tenant_id, project_id, project.name)
    if not d.is_dir():
        return {"files": [], "folder": project.name}
    allowed = {".tif", ".tiff", ".jp2", ".zip", ".png", ".jpg", ".jpeg"}
    files = []
    for p in sorted(d.iterdir()):
        if p.is_file() and p.suffix.lower() in allowed:
            try:
                sz = p.stat().st_size
            except OSError:
                continue
            files.append({"name": p.name, "size_bytes": sz, "ext": p.suffix.lower()})
    return {"files": files, "folder": project.name}


@router.post("/raster/import-from-downloads")
def import_raster_from_downloads(
    project_id: int = Query(..., description="Project ID"),
    filename: str = Query(..., description="File name inside project download folder"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Copy a file from the project download folder into rasters and register as a normal raster layer."""
    safe = Path(filename).name
    if safe != filename or ".." in safe:
        raise HTTPException(status_code=400, detail="Invalid filename")

    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    src_dir = project_downloads_dir(tenant_id, project_id, project.name)
    src = (src_dir / safe).resolve()
    base = src_dir.resolve()
    if not str(src).startswith(str(base)) or not src.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    ext = src.suffix.lower()
    if ext not in {".tif", ".tiff", ".jp2", ".png", ".jpg", ".jpeg"}:
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden importar como capa raster: GeoTIFF, JP2 o imagen. Para .ZIP use extracción manual.",
        )

    out_dir = _tenant_storage(tenant_id, project_id, "rasters")
    destination = out_dir / f"{uuid.uuid4().hex}{ext}"
    shutil.copy2(src, destination)
    cog_path = out_dir / f"{destination.stem}_cog.tif"
    bounds = bounds_wgs84_from_path(destination)
    meta = {
        "source_name": safe,
        "status": "processing",
        "cog_ready": False,
        "imported_from": "project_downloads",
    }
    if bounds:
        meta["bounds_wgs84"] = list(bounds)
    raster = RasterLayer(
        project_id=project_id,
        tenant_id=tenant_id,
        name=safe,
        file_path=str(destination),
        cog_path=str(cog_path),
        raster_metadata=meta,
    )
    db.add(raster)
    db.commit()
    db.refresh(raster)
    process_raster.delay(str(destination), str(cog_path), raster.id)
    return {"raster_layer_id": raster.id, "name": safe, "metadata": raster.raster_metadata}


@router.post("/upload-raster")
async def upload_raster(
    project_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await validate_upload_size(file)
    ext = Path(file.filename).suffix.lower()
    if ext not in {".tif", ".tiff", ".jp2", ".png", ".jpg", ".jpeg", ".zip"}:
        raise HTTPException(status_code=400, detail="Unsupported raster format")

    out_dir = _tenant_storage(tenant_id, project_id, "rasters")
    extract_dir: Path | None = None

    if ext == ".zip":
        pack_id = uuid.uuid4().hex
        zip_path = out_dir / f"{pack_id}.zip"
        with zip_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        extract_dir = out_dir / f"s2_{pack_id}"
        try:
            safe_extract_zip(zip_path, extract_dir)
        except (zipfile.BadZipFile, OSError):
            zip_path.unlink(missing_ok=True)
            shutil.rmtree(extract_dir, ignore_errors=True)
            raise HTTPException(status_code=400, detail="ZIP invalido o no se pudo descomprimir")
        zip_path.unlink(missing_ok=True)

        band_files = find_sentinel_r10_band_files(extract_dir)
        missing = [b for b in S2_BANDS_10M_ORDER if b not in band_files]
        if missing:
            shutil.rmtree(extract_dir, ignore_errors=True)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"No se encontraron JP2 de bandas: {', '.join(missing)}. "
                    "Se requieren B02, B03, B04 y B08 a 10 m (L2A: IMG_DATA/R10m; "
                    "L1C: IMG_DATA con nombres tipo …_B04.jp2). Producto .SAFE completo."
                ),
            )

        zip_stem = Path(file.filename).stem
        first_jp2 = next(iter(band_files.values()))
        safe_anc = find_safe_ancestor(Path(first_jp2).resolve())
        stem_for_date = safe_anc.stem if safe_anc else zip_stem
        date_label = s2_acquisition_date_label(stem_for_date)
        date_slug = s2_date_slug_for_filename(date_label)
        name_rgb = f"{date_label}_RGB"
        name_nir = f"{date_label}_NIR"

        uid = uuid.uuid4().hex
        # Un solo TIF 4 bandas (B04,B03,B02,B08); nombre con fecha desde carpeta .SAFE
        stack_tif = out_dir / f"{date_slug}_S2_4band_{pack_id[:8]}.tif"
        rgb_src = out_dir / f"{uid}_rgb.tif"
        nir_src = out_dir / f"{uid}_nir.tif"
        rgb_cog = out_dir / f"{uid}_rgb_cog.tif"
        nir_cog = out_dir / f"{uid}_nir_cog.tif"

        bounds = bounds_wgs84_from_path(band_files["B02"])
        meta_common = {
            "source_name": file.filename,
            "status": "processing",
            "cog_ready": False,
            "extract_dir": str(extract_dir),
            "from_zip": True,
            "s2_band_pack": True,
            "s2_composite": True,
            "s2_stack_path": str(stack_tif),
            "s2_stack_band_order": "B04,B03,B02,B08",
            "s2_date_label": date_label,
        }
        if bounds:
            meta_common["bounds_wgs84"] = list(bounds)

        meta_rgb = {
            **meta_common,
            "composite_kind": "true_color",
            "bands_rgb": "R=B04, G=B03, B=B02",
            "derived_from_stack": True,
        }
        meta_nir = {
            **meta_common,
            "composite_kind": "false_color_nir",
            "bands_rgb": "R=B08, G=B04, B=B03",
            "derived_from_stack": True,
        }

        raster_rgb = RasterLayer(
            project_id=project_id,
            tenant_id=tenant_id,
            name=name_rgb,
            file_path=str(rgb_src),
            cog_path=str(rgb_cog),
            raster_metadata=meta_rgb,
        )
        raster_nir = RasterLayer(
            project_id=project_id,
            tenant_id=tenant_id,
            name=name_nir,
            file_path=str(nir_src),
            cog_path=str(nir_cog),
            raster_metadata=meta_nir,
        )
        db.add(raster_rgb)
        db.add(raster_nir)
        db.commit()
        db.refresh(raster_rgb)
        db.refresh(raster_nir)

        band_paths = {k: str(v) for k, v in band_files.items()}
        process_s2_zip_layers.delay(
            band_paths,
            str(stack_tif),
            str(rgb_src),
            str(nir_src),
            str(rgb_cog),
            str(nir_cog),
            raster_rgb.id,
            raster_nir.id,
        )

        items = [
            {
                "id": raster_rgb.id,
                "name": name_rgb,
                "composite": "rgb",
                "metadata": meta_rgb,
            },
            {
                "id": raster_nir.id,
                "name": name_nir,
                "composite": "nir",
                "metadata": meta_nir,
            },
        ]
        return {
            "raster_layer_id": raster_rgb.id,
            "raster_layer_ids": [raster_rgb.id, raster_nir.id],
            "layers": items,
            "metadata": meta_rgb,
        }

    destination = out_dir / f"{uuid.uuid4().hex}{ext}"
    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    cog_path = out_dir / f"{uuid.uuid4().hex}_cog.tif"
    bounds = bounds_wgs84_from_path(destination)
    meta: dict = {"source_name": file.filename, "status": "processing", "cog_ready": False}
    if bounds:
        meta["bounds_wgs84"] = list(bounds)
    raster = RasterLayer(
        project_id=project_id,
        tenant_id=tenant_id,
        name=file.filename,
        file_path=str(destination),
        cog_path=str(cog_path),
        raster_metadata=meta,
    )
    db.add(raster)
    db.commit()
    db.refresh(raster)
    process_raster.delay(str(destination), str(cog_path), raster.id)
    return {"raster_layer_id": raster.id, "metadata": raster.raster_metadata}


@router.get("/raster/{project_id}/{raster_layer_id}/preview")
def get_raster_preview(
    project_id: int,
    raster_layer_id: int,
    band: int | None = Query(
        None,
        ge=1,
        description="Stacks de índices multibanda: banda (1..N) a visualizar.",
    ),
    index_palette: int = Query(
        0,
        ge=0,
        le=1,
        description="1 = aplicar paleta de índice (RdYlGn: rojo bajo → verde alto). 0 = sin paleta. "
        "Usar 1 solo en la galería «Visual NDVI/…»; el mapa y la galería RGB envían 0.",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    raster = _get_project_raster(db, tenant_id, project_id, raster_layer_id)
    path = _existing_raster_path(raster)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Raster file not found")
    try:
        meta = raster.raster_metadata or {}
        rgb_override = (band, band, band) if band is not None else None
        png = render_raster_preview_png(
            path,
            layer_metadata=meta,
            rgb_bands_1based=rgb_override,
            index_palette_request=index_palette == 1,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"No se pudo generar la vista previa: {exc}") from exc
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.get("/raster/{project_id}")
def list_rasters(project_id: int, db: Session = Depends(get_db), tenant_id: int = Depends(tenant_from_jwt)):
    rasters = (
        db.query(RasterLayer)
        .filter(RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .all()
    )
    filtered = [r for r in rasters if not is_legacy_s2_zip_band_raster(r.raster_metadata)]
    filtered.sort(key=_raster_chronological_sort_key)
    return [{"id": r.id, "name": r.name, "metadata": r.raster_metadata} for r in filtered]


@router.delete("/raster/{project_id}/{raster_id}")
def delete_raster(
    project_id: int,
    raster_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    raster = (
        db.query(RasterLayer)
        .filter(RasterLayer.id == raster_id, RasterLayer.project_id == project_id, RasterLayer.tenant_id == tenant_id)
        .first()
    )
    if not raster:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    _remove_extract_dir_if_no_other_layers(db, project_id, tenant_id, raster)
    stack_p = (raster.raster_metadata or {}).get("s2_stack_path")
    for p in [raster.cog_path, raster.file_path]:
        if p:
            fp = Path(p)
            if fp.exists():
                fp.unlink(missing_ok=True)
    if stack_p:
        others = (
            db.query(RasterLayer)
            .filter(
                RasterLayer.project_id == project_id,
                RasterLayer.tenant_id == tenant_id,
                RasterLayer.id != raster_id,
            )
            .all()
        )
        if not any((o.raster_metadata or {}).get("s2_stack_path") == stack_p for o in others):
            sp = Path(stack_p).resolve()
            root = Path(settings.storage_path).resolve()
            if str(sp).startswith(str(root)) and sp.is_file():
                sp.unlink(missing_ok=True)
    db.delete(raster)
    db.commit()
    return {"status": "ok", "deleted_raster_id": raster_id}
