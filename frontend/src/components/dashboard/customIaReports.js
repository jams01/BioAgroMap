/**
 * Informes «Ver análisis» estáticos (Markdown en /public/reports).
 * Clave: id de proyecto o nombre normalizado.
 */
const PALM_VICHADA_REPORT = "/reports/informe-palm-vichada.md";

function normalizeProjectName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s_]+/g, "-");
}

/** Figuras obligatorias — sección 4 del informe Palma Vichada (DOCX). */
export const PALM_MORTALIDAD_FIGURES = [
  {
    sectionMatch: /4\.2.*mapa de focos/i,
    src: "/reports/images/focos-mapa-lote.png",
    alt: "Mapa de focos de mortalidad sobre el lote",
    caption: "Figura 1. Mapa de focos de mortalidad sobre geometria real del lote",
  },
  {
    sectionMatch: /4\.3.*evoluci[oó]n temporal/i,
    src: "/reports/images/focos-evolucion-temporal.png",
    alt: "Evolucion temporal de focos de mortalidad",
    caption: "Figura 2. Evolucion temporal de focos de mortalidad (ene 2025 - mar 2026)",
  },
];

function blockHasImageSrc(blocks, src) {
  return blocks.some(
    (b) =>
      (b?.type === "figure" || b?.type === "image") &&
      String(b.src || "").trim() === src,
  );
}

/** Garantiza las dos figuras de mortalidad aunque falten en el Markdown cargado. */
export function ensureMortalidadFigures(blocks) {
  const out = [...blocks];
  for (const fig of PALM_MORTALIDAD_FIGURES) {
    if (blockHasImageSrc(out, fig.src)) continue;
    const hIdx = out.findIndex(
      (b) =>
        (b?.type === "h" || b?.type === "h1" || b?.type === "h3") &&
        fig.sectionMatch.test(String(b.text || "")),
    );
    if (hIdx < 0) continue;
    let insertAt = hIdx + 1;
    while (insertAt < out.length && typeof out[insertAt] === "string") {
      insertAt += 1;
    }
    out.splice(insertAt, 0, {
      type: "figure",
      src: fig.src,
      alt: fig.alt,
      caption: fig.caption,
    });
  }
  return out;
}

/** @returns {string|null} URL del markdown o null si usa informe automático */
export function getCustomIaReportUrl({ projectId, projectName }) {
  const id = Number(projectId);
  const slug = normalizeProjectName(projectName);
  if (id === 14 || slug === "palm-10anos" || slug === "palm-10años" || slug.includes("palm-10")) {
    return PALM_VICHADA_REPORT;
  }
  return null;
}
