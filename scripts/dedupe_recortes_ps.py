#!/usr/bin/env python3
"""
Elimina duplicados en carpetas recortesPS/ (mismo día PS_DD-MM-YY con sufijo _N de
planet_ps_extract._unique_path). Conserva la versión cuyo composite .tif sea más
reciente (mtime) y borra el resto; si la ganadora es _N, la renombra a la forma
canónica sin sufijo (composite y sidecars).
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

PS_ANY = re.compile(r"^(PS_\d{2}-\d{2}-\d{2})(.+)?$")
PS_TIF = re.compile(r"^(PS_\d{2}-\d{2}-\d{2})(?:_(\d+))?\.tif$")


def file_base_version(name: str) -> tuple[str, int] | None:
    """Retorna (PS_dd-mm-yy, versión) con versión 0 = sin sufijo _N en el composite."""
    m = PS_TIF.match(name)
    if m:
        return (m.group(1), int(m.group(2) or 0))
    m2 = PS_ANY.match(name)
    if not m2 or not m2.group(2):
        return None
    base, rest = m2.group(1), m2.group(2).lstrip("_")
    if not rest:
        return None
    head = rest.split("_", 1)[0]
    if head.isdigit():
        if len(head) <= 3:
            return (base, int(head))
        return (base, 0)
    return (base, 0)


def collect_recortes_ps_roots(storage: Path) -> list[Path]:
    out: list[Path] = []
    if not storage.is_dir():
        return out
    for p in storage.rglob("recortesPS"):
        if p.is_dir():
            out.append(p)
    return sorted(set(out))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--storage",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "storage",
        help="Raíz tenant_*/project_*/recortesPS (por defecto <repo>/data/storage)",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Sin esto solo lista acciones (dry-run).",
    )
    args = ap.parse_args()
    roots = collect_recortes_ps_roots(args.storage)
    if not roots:
        print(f"No se encontró ninguna carpeta recortesPS bajo {args.storage}", file=sys.stderr)
        return 1

    dry = not args.apply
    total_del = 0
    total_ren = 0

    for root in roots:
        files = [p for p in root.iterdir() if p.is_file()]
        by_base: dict[str, list[tuple[int, Path]]] = {}
        for p in files:
            parsed = file_base_version(p.name)
            if not parsed:
                continue
            b, v = parsed
            by_base.setdefault(b, []).append((v, p))

        for base, entries in sorted(by_base.items()):
            tifs = [(v, p) for v, p in entries if p.suffix.lower() == ".tif" and PS_TIF.match(p.name)]
            if len(tifs) < 2:
                continue
            by_v: dict[int, list[Path]] = {}
            for v, p in entries:
                by_v.setdefault(v, []).append(p)
            # Ganador por mtime del composite principal (no udm2 pequeño)
            composites = [(v, p) for v, p in tifs if "udm2" not in p.name.lower()]
            if not composites:
                composites = tifs
            win_v, win_path = max(composites, key=lambda x: x[1].stat().st_mtime)
            losers = [v for v in by_v if v != win_v]
            if not losers:
                continue
            print(f"\n[{root}] {base}: conservar versión {win_v} ({win_path.name}, mtime)")
            for lv in losers:
                for p in sorted(by_v[lv], key=lambda x: x.name):
                    print(f"  {'BORRAR ' if args.apply else '[dry] '}{p.name}")
                    if args.apply:
                        p.unlink()
                        total_del += 1
            if win_v != 0 and args.apply:
                old_pfx = f"{base}_{win_v}"
                new_pfx = base
                # Renombrar de sufijo más largo a más corto para evitar colisiones
                to_rename = sorted(
                    (p for p in by_v[win_v] if p.name.startswith(old_pfx + "_") or p.name == f"{old_pfx}.tif"),
                    key=lambda p: len(p.name),
                    reverse=True,
                )
                for p in to_rename:
                    new_name = new_pfx + p.name[len(old_pfx) :]
                    dest = p.with_name(new_name)
                    if dest.exists():
                        print(f"  ERROR: destino ya existe: {dest.name}", file=sys.stderr)
                        return 2
                    os.rename(p, dest)
                    print(f"  RENOMBRAR {p.name} -> {new_name}")
                    total_ren += 1

    print(f"\nResumen: {'dry-run (sin --apply)' if dry else f'borrados={total_del}, renombrados={total_ren}'}")
    if dry:
        print(
            "Con --apply: si «Permiso denegado», ejecutar como root, p. ej.\n"
            "  docker run --rm -v <repo>/data:/data -v <repo>/scripts:/scripts "
            "python:3.11-slim python3 /scripts/dedupe_recortes_ps.py --storage /data/storage --apply"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
