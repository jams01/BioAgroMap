#!/usr/bin/env python3
"""Regenera frontend/public/reports/informe-palm-vichada.md desde el DOCX fuente."""
from __future__ import annotations

import base64
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

import mammoth
from markdownify import markdownify as html_to_md

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "ai_service/IA_response_Palm_10años/Informe_Palma_Vichada_Final.docx"
OUT = ROOT / "frontend/public/reports/informe-palm-vichada.md"
IMG_DIR = ROOT / "frontend/public/reports/images"


class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._row: list[str] = []
        self._cell: list[str] = []
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "tr":
            self._row = []
        if tag in ("td", "th"):
            self._in_cell = True
            self._cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th"):
            self._in_cell = False
            self._row.append(" ".join(self._cell).strip())
        if tag == "tr" and self._row:
            self.rows.append(self._row)

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell.append(data)


def _clean_cell(text: str) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    t = re.sub(r"__([^_]+?)__", r"\1", t)
    return t


def html_table_to_markdown(table_html: str) -> str:
    parser = _TableParser()
    parser.feed(table_html)
    rows = [[_clean_cell(c) for c in r] for r in parser.rows if any(c.strip() for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    norm = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(r) + " |" for r in norm]
    sep = "| " + " | ".join(["---"] * width) + " |"
    return "\n".join([lines[0], sep, *lines[1:]])


def normalize(md: str) -> str:
    md = re.sub(r"__([^_\n]+?)__", r"**\1**", md)
    md = re.sub(r"\\([.\-\(\)\\+])", r"\1", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def _save_data_url(data_url: str, filename_stem: str) -> str | None:
    m = re.match(r"data:image/([^;]+);base64,(.+)", data_url, flags=re.DOTALL)
    if not m:
        return None
    ext = m.group(1).lower().replace("jpeg", "jpg")
    if ext == "svg+xml":
        ext = "svg"
    raw = base64.b64decode(re.sub(r"\s+", "", m.group(2)))
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    out = IMG_DIR / f"{filename_stem}.{ext}"
    out.write_bytes(raw)
    return f"/reports/images/{out.name}"


def _replace_img_tags_in_html(html: str) -> str:
    figures = (
        (
            "focos-mapa-lote",
            "Figura 1 — Mapa de focos de mortalidad sobre geometria real del lote",
        ),
        (
            "focos-evolucion-temporal",
            "Figura 2 — Evolucion temporal de focos de mortalidad (ene 2025 - mar 2026)",
        ),
    )
    idx = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal idx
        tag = match.group(0)
        src_m = re.search(r'src="([^"]+)"', tag, flags=re.I)
        if not src_m:
            return tag
        src = src_m.group(1)
        if idx < len(figures):
            stem, alt = figures[idx]
        else:
            stem, alt = f"foco-imagen-{idx + 1}", f"Figura {idx + 1}"
        idx += 1
        if src.startswith("data:"):
            public = _save_data_url(src, stem)
            if public:
                return f"\n\n![{alt}]({public})\n\n"
        return tag

    return re.sub(r"<img[^>]+>", repl, html, flags=re.IGNORECASE)


def _inline_markdown_images_to_files(md: str) -> str:
    """Convierte ![](data:image/...) restantes a rutas en /reports/images/."""

    def repl(match: re.Match[str]) -> str:
        alt, url = match.group(1), match.group(2)
        if not url.startswith("data:image"):
            return match.group(0)
        stem = (alt or "imagen").strip().replace(" ", "-")[:40] or "imagen"
        public = _save_data_url(url, stem)
        return f"![{alt}]({public})" if public else match.group(0)

    return re.sub(r"!\[([^\]]*)\]\((data:image/[^)]+)\)", repl, md)


def docx_to_markdown(path: Path) -> str:
    with open(path, "rb") as f:
        html = mammoth.convert_to_html(f).value
    html = _replace_img_tags_in_html(html)

    chunks: list[str] = []
    pos = 0
    for match in re.finditer(r"<table[^>]*>.*?</table>", html, flags=re.DOTALL | re.IGNORECASE):
        before = html[pos : match.start()]
        if before.strip():
            piece = html_to_md(before, heading_style="ATX").strip()
            if piece:
                chunks.append(piece)
        chunks.append(html_table_to_markdown(match.group(0)))
        pos = match.end()

    tail = html[pos:]
    if tail.strip():
        piece = html_to_md(tail, heading_style="ATX").strip()
        if piece:
            chunks.append(piece)

    md = normalize("\n\n".join(c for c in chunks if c))
    return _inline_markdown_images_to_files(md)


def main() -> int:
    if not SRC.is_file():
        print(f"No encontrado: {SRC}", file=sys.stderr)
        return 1
    body = docx_to_markdown(SRC)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body + "\n", encoding="utf-8")
    print(f"OK → {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
