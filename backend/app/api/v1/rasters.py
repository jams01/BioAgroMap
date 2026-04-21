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
from app.services.raster_geo import (
    bounds_wgs84_from_path,
    render_raster_preview_png,
    render_s1_vh_vv_ratio_preview_png,
)
from app.services.s2_composites import (
    s2_acquisition_date_label,
    s2_date_slug_for_filename,
)
from app.services.sentinel_safe import (
    S2_BANDS_10M_ORDER,
    find_safe_ancestor,
    find_sentinel_r10_band_files,
    looks_like_sentinel2_product_zip_filename,
    safe_extract_zip,
)
from app.tasks.jobs import process_raster, process_s2_zip_layers

router = APIRouter()


def _tenant_root_path(tenant_id: int) -> Path:
    return (Path(settings.storage_path).resolve() / f"tenant_{tenant_id}").resolve()


def _project_root_path(tenant_id: int, project_id: int) -> Path:
    return (Path(settings.storage_path).resolve() / f"tenant_{tenant_id}" / f"project_{project_id}").resolve()


def _safe_path_under_tenant(tenant_root: Path, rel: str) -> Path:
    rel = (rel or "").strip().replace("\\", "/")
    parts = [p for p in rel.split("/") if p and p != "."]
    root = tenant_root.resolve()
    cur = root
    for p in parts:
        if p == "..":
            raise HTTPException(status_code=400, detail="Ruta inválida")
        cur = (cur / p).resolve()
    try:
        cur.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Ruta fuera del tenant") from exc
    return cur


def _safe_path_under_project(project_root: Path, rel: str) -> Path:
    rel = (rel or "").strip().replace("\\", "/")
    parts = [p for p in rel.split("/") if p and p != "."]
    root = project_root.resolve()
    cur = root
    for p in parts:
        if p == "..":
            raise HTTPException(status_code=400, detail="Ruta inválida")
        cur = (cur / p).resolve()
    try:
        cur.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Ruta fuera del proyecto") from exc
    return cur


def _parent_subpath_for_browse(base_root: Path, current: Path) -> str | None:
    try:
        rel = current.resolve().relative_to(base_root.resolve())
    except ValueError:
        return None
    if rel == Path(".") or str(rel) == ".":
        return None
    par = rel.parent
    if par == Path(".") or str(par) == ".":
        return ""
    return par.as_posix()


def _scan_l2a_products_in_dir(root: Path) -> dict:
    out: dict = {
        "downloads_dir": str(root.resolve()),
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
                if p.suffix.lower() == ".zip":
                    try:
                        sz = p.stat().st_size
                    except OSError:
                        sz = 0
                    entry: dict = {"name": p.name, "size_bytes": sz}
                    if not looks_like_sentinel2_product_zip_filename(p.name):
                        entry["weak_match"] = True
                    out["zip_l2a"].append(entry)
                else:
                    out["other_top_level"].append(p.name)
            elif p.is_dir():
                if p.name.upper().endswith(".SAFE"):
                    out["safe_folders"].append(p.name)
                else:
                    out["other_top_level"].append(p.name + "/")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return out


def _looks_like_sentinel1_product_zip_filename(name: str) -> bool:
    u = name.upper()
    if not u.endswith(".ZIP"):
        return False
    return "S1" in u and ("IW_GRD" in u or "IW_GRDM" in u or "GRDH" in u)


def _scan_sentinel1_products_in_dir(sentinel1_root: Path) -> dict:
    """
    Inventario bajo ``…/downloads/<slug>/Sentinel1/``: carpetas ``*.SAFE`` (incluye
    subcarpetas p. ej. ``YYYY/MM/`` de descargas antiguas) y ZIP GRD IW en el primer nivel.
    """
    out: dict = {
        "downloads_dir": str(sentinel1_root.resolve()),
        "exists": sentinel1_root.is_dir(),
        "zip_l2a": [],
        "safe_folders": [],
        "other_top_level": [],
    }
    if not sentinel1_root.is_dir():
        return out

    safe_rel_set: set[str] = set()
    try:
        for p in sorted(sentinel1_root.rglob("*")):
            if not p.is_dir():
                continue
            if not p.name.upper().endswith(".SAFE"):
                continue
            try:
                rel = p.resolve().relative_to(sentinel1_root.resolve()).as_posix()
            except ValueError:
                continue
            if rel:
                safe_rel_set.add(rel)
        out["safe_folders"] = sorted(safe_rel_set)

        for p in sorted(sentinel1_root.iterdir()):
            if p.name.startswith("."):
                continue
            if p.is_file():
                if p.suffix.lower() == ".zip":
                    try:
                        sz = p.stat().st_size
                    except OSError:
                        sz = 0
                    entry: dict = {"name": p.name, "size_bytes": sz}
                    if not _looks_like_sentinel1_product_zip_filename(p.name):
                        entry["weak_match"] = True
                    out["zip_l2a"].append(entry)
                else:
                    out["other_top_level"].append(p.name)
            elif p.is_dir():
                if p.name.upper().endswith(".SAFE"):
                    continue
                out["other_top_level"].append(p.name + "/")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return out


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


@router.get("/raster/tenant-storage-browse")
def tenant_storage_browse(
    path: str = Query("", description="Ruta relativa bajo storage/tenant_*/"),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Lista carpetas y archivos desde la raíz del tenant (p. ej. project_1, project_2, …)."""
    root = _tenant_root_path(tenant_id)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Carpeta del tenant no existe en almacenamiento")
    target = _safe_path_under_tenant(root, path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="No es una carpeta")
    entries: list[dict] = []
    try:
        for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if p.name.startswith("."):
                continue
            try:
                rel_posix = p.resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            if p.is_dir():
                entries.append({"name": p.name, "kind": "dir", "relative_path": rel_posix})
            else:
                try:
                    sz = p.stat().st_size if p.is_file() else 0
                except OSError:
                    sz = 0
                entries.append(
                    {"name": p.name, "kind": "file", "relative_path": rel_posix, "size_bytes": sz}
                )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    try:
        rel_current = target.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        rel_current = ""
    parent_subpath = _parent_subpath_for_browse(root, target)
    return {
        "tenant_root": str(root),
        "relative_path": rel_current,
        "parent_subpath": parent_subpath,
        "entries": entries,
    }


@router.get("/raster/project-storage-browse/{project_id}")
def project_storage_browse(
    project_id: int,
    path: str = Query("", description="Ruta relativa (posix) bajo la raíz del proyecto"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """Lista carpetas y archivos para navegar desde la raíz del proyecto (storage/tenant_*/project_*)."""
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    root = _project_root_path(tenant_id, project_id)
    if not root.is_dir():
        raise HTTPException(status_code=404, detail="Carpeta del proyecto no existe en almacenamiento")
    target = _safe_path_under_project(root, path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="No es una carpeta")
    entries: list[dict] = []
    try:
        for p in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if p.name.startswith("."):
                continue
            try:
                rel_posix = p.resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            if p.is_dir():
                entries.append({"name": p.name, "kind": "dir", "relative_path": rel_posix})
            else:
                try:
                    sz = p.stat().st_size if p.is_file() else 0
                except OSError:
                    sz = 0
                entries.append(
                    {"name": p.name, "kind": "file", "relative_path": rel_posix, "size_bytes": sz}
                )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    try:
        rel_current = target.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        rel_current = ""
    parent_subpath = _parent_subpath_for_browse(root, target)
    return {
        "project_root": str(root),
        "relative_path": rel_current,
        "parent_subpath": parent_subpath,
        "entries": entries,
    }


@router.get("/raster/project-downloads-inventory/{project_id}")
def project_downloads_inventory(
    project_id: int,
    subpath: str | None = Query(
        None,
        description="Si se envía, lista L2A en esa ruta bajo el proyecto. Si se omite, carpeta descargas por defecto (downloads/<slug>).",
    ),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Lista productos Sentinel-2 (ZIP y carpetas .SAFE reconocibles, p. ej. L2A/L1C) en el directorio indicado (primer nivel),
    más otros elementos del mismo nivel.
    Sin ``subpath``: misma carpeta que hasta ahora (descargas Sentinel por nombre de proyecto).
    Con ``subpath``: carpeta bajo la raíz del proyecto (p. ej. ``downloads/mi_slug``).
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if subpath is None:
        root = project_downloads_dir(tenant_id, project_id, project.name)
    else:
        pr = _project_root_path(tenant_id, project_id)
        root = _safe_path_under_project(pr, subpath)
    out = _scan_l2a_products_in_dir(root)
    out["source_subpath"] = None if subpath is None else subpath
    return out


@router.get("/raster/project-sentinel1-inventory/{project_id}")
def project_sentinel1_inventory(
    project_id: int,
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Lista productos Sentinel-1 (carpetas ``*.SAFE`` bajo ``Sentinel1/``, cualquier profundidad;
    ZIP GRD en el primer nivel) en ``downloads/<slug>/Sentinel1/``.
    """
    project = db.query(Project).filter(Project.id == project_id, Project.tenant_id == tenant_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    root = project_downloads_dir(tenant_id, project_id, project.name) / "Sentinel1"
    out = _scan_sentinel1_products_in_dir(root)
    out["source"] = "sentinel-1"
    return out


def _merge_copy_downloads_dir(src: Path, dst: Path) -> int:
    """
    Copia el contenido de ``src`` dentro de ``dst``, fusionando carpetas con el mismo nombre.
    Devuelve el número de archivos copiados (incluye archivos dentro de árboles copiados con copytree).
    """
    n_files = 0
    dst.mkdir(parents=True, exist_ok=True)
    for child in sorted(src.iterdir()):
        if child.name.startswith("."):
            continue
        target = dst / child.name
        if child.is_file():
            shutil.copy2(child, target)
            n_files += 1
        elif child.is_dir():
            if target.exists():
                if not target.is_dir():
                    raise HTTPException(
                        status_code=409,
                        detail=f"Conflicto: «{child.name}» existe como archivo en destino y como carpeta en origen.",
                    )
                n_files += _merge_copy_downloads_dir(child, target)
            else:
                shutil.copytree(child, target)
                n_files += sum(1 for p in child.rglob("*") if p.is_file())
        else:
            continue
    return n_files


@router.post("/raster/copy-downloads-from-project")
def copy_downloads_from_project(
    source_project_id: int = Query(..., description="Proyecto origen (tiene las descargas)"),
    target_project_id: int = Query(..., description="Proyecto destino (proyecto actual)"),
    db: Session = Depends(get_db),
    tenant_id: int = Depends(tenant_from_jwt),
):
    """
    Copia el contenido de ``downloads/<slug>`` del proyecto origen sobre la carpeta de descargas del proyecto destino
    (mismo tenant). No elimina archivos previos en destino; fusiona por nombre.
    """
    if source_project_id == target_project_id:
        raise HTTPException(status_code=400, detail="El origen y el destino deben ser proyectos distintos.")
    src_project = db.query(Project).filter(Project.id == source_project_id, Project.tenant_id == tenant_id).first()
    tgt_project = db.query(Project).filter(Project.id == target_project_id, Project.tenant_id == tenant_id).first()
    if not src_project or not tgt_project:
        raise HTTPException(status_code=404, detail="Project not found")
    src_dir = project_downloads_dir(tenant_id, source_project_id, src_project.name)
    tgt_dir = project_downloads_dir(tenant_id, target_project_id, tgt_project.name)
    if not src_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail="El proyecto origen no tiene carpeta de descargas (downloads).",
        )
    if not any(src_dir.iterdir()):
        raise HTTPException(status_code=400, detail="La carpeta de descargas del proyecto origen está vacía.")
    n_files = _merge_copy_downloads_dir(src_dir, tgt_dir)
    return {
        "ok": True,
        "source_project_id": source_project_id,
        "target_project_id": target_project_id,
        "files_copied": n_files,
        "target_downloads_dir": str(tgt_dir.resolve()),
    }


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
    s1_derived: str | None = Query(
        None,
        description="Sentinel-1 (VV+VH): vista derivada. vh_vv_ratio = cociente VH/VV en lineal "
        "(log-scale + paleta RdYlGn). Ignora preview_rgb_bands.",
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
        sd = (s1_derived or "").strip().lower()
        if sd == "vh_vv_ratio":
            png = render_s1_vh_vv_ratio_preview_png(path, layer_metadata=meta)
        elif sd != "":
            raise ValueError(f"s1_derived no reconocido: {s1_derived}")
        elif band is not None:
            rgb_override = (band, band, band)
            png = render_raster_preview_png(
                path,
                layer_metadata=meta,
                rgb_bands_1based=rgb_override,
                index_palette_request=index_palette == 1,
            )
        else:
            png = render_raster_preview_png(
                path,
                layer_metadata=meta,
                rgb_bands_1based=None,
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
