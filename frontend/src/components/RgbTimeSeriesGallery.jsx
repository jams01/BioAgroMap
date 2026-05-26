import { useCallback, useEffect, useRef, useState } from "react";
import api, { API_URL, formatApiErrorDetail, setAuthToken } from "../api";
import {
  formatRecorteDisplayName,
  rasterSortKeyFromMetadata,
} from "../utils/geo";

function isLegacyS2ZipBandRaster(meta) {
  if (!meta) return false;
  return !!(meta.s2_band_pack && meta.band && !meta.composite_kind);
}

/** Capas con vista RGB en galería (recortes y composites). */
function filterGalleryRasters(rows) {
  return rows.filter((r) => {
    const m = r.metadata || {};
    if ((m.source === "sentinel-2" || m.source === "sentinel-1") && m.type === "download")
      return false;
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    if (m.composite_kind === "false_color_nir") return false;
    return (
      m.s2_l2a_recorte ||
      m.s1_grd_recorte ||
      m.s2_four_band_stack ||
      m.s2_six_band_stack ||
      m.composite_kind === "true_color"
    );
  });
}

/**
 * Variante Sentinel-2 (pestaña S2 / galería con pipelineVariant s2): no mezclar recortes GRD
 * Sentinel-1; comparten etiqueta ``dd/mm/aaaa_clip`` vía ``formatRecorteDisplayName`` y el preview RGB
 * puede salir en negro.
 */
function filterGalleryRastersS2Pipeline(rows) {
  return filterGalleryRasters(rows).filter((r) => !r.metadata?.s1_grd_recorte);
}

/** Solo recortes GRD IW VV+VH (pestaña SI). */
function filterS1GrdRecortes(rows) {
  return rows.filter((r) => {
    const m = r.metadata || {};
    if ((m.source === "sentinel-2" || m.source === "sentinel-1") && m.type === "download")
      return false;
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    return !!m.s1_grd_recorte;
  });
}

export function isS1GalleryVisualMode(m) {
  return m === "s1-vv" || m === "s1-vh" || m === "s1-index";
}

/**
 * Solo escenas con GeoTIFF multibanda L2A usado para índices (misma capa que apunta al .tif 6 bandas).
 */
function filterSixBandStackRasters(rows) {
  return rows.filter((r) => {
    const m = r.metadata || {};
    if ((m.source === "sentinel-2" || m.source === "sentinel-1") && m.type === "download")
      return false;
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    if (m.composite_kind === "false_color_nir") return false;
    return !!(m.s2_six_band_stack || m.s2_l2a_recorte);
  });
}

function formatIsoDateDdMmYyyy(iso) {
  if (typeof iso !== "string" || iso.length < 10) return iso || "";
  const [y, mo, d] = iso.split("-");
  if (!y || !mo || !d) return iso;
  return `${d.padStart(2, "0")}/${mo.padStart(2, "0")}/${y}`;
}

/** Etiqueta corta solo con fecha (dd/mm/aaaa) para escenas en recortes/. */
function formatSceneDateLabel(sortKey) {
  if (typeof sortKey !== "string" || !sortKey) return "—";
  const head = sortKey.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) {
    return formatIsoDateDdMmYyyy(head);
  }
  return "—";
}

/** Nombre visible ``PS_dd/mm/yy`` desde ``PS_dd-mm-yy.tif`` o ``PS_dd-mm-yy_N.tif``. */
function labelPsRgbFromBasename(basename) {
  const m = String(basename || "").match(/^PS_(\d{2})-(\d{2})-(\d{2})(?:_(\d+))?\.tif$/i);
  if (m) {
    const suf = m[4] ? ` (${m[4]})` : "";
    return `PS_${m[1]}/${m[2]}/${m[3]}${suf}`;
  }
  return basename || "—";
}

/** Mismo criterio que el backend para inventario PS: solo ``PS_dd-mm-yy.tif`` (opc. ``_N``). */
const PS_RECORTE_TIF_BASENAME_RE = /^PS_\d{2}-\d{2}-\d{2}(?:_\d+)?\.tif$/i;

const RECORTE_PREVIEW_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect fill="#2a2a2a" width="100%" height="100%"/><text x="50%" y="50%" fill="#999" font-size="12" text-anchor="middle" font-family="system-ui,sans-serif">Sin vista previa</text></svg>'
  );

/** Clave estable YYYY-MM-DD para no duplicar miniaturas por la misma fecha en un stack. */
function _bandDateKeyForDedupe(d) {
  if (typeof d === "string" && d.length >= 10) return d.slice(0, 10);
  return null;
}

/**
 * Una miniatura por fecha distinta en el stack (evita band_dates repetidos o filas duplicadas en inventario).
 * Conserva la primera banda asociada a cada fecha.
 */
function specsUniqueByBandDate(nb, dates) {
  const specs = [];
  const seenDate = new Set();
  const seenFallback = new Set();
  const n = Number(nb);
  if (!Number.isFinite(n) || n < 1) {
    return [{ band: 1, labelSuffix: "" }];
  }
  for (let i = 0; i < n; i++) {
    const d = Array.isArray(dates) ? dates[i] : undefined;
    const dk = _bandDateKeyForDedupe(d);
    let labelSuffix;
    if (dk) {
      labelSuffix = formatIsoDateDdMmYyyy(dk);
      if (seenDate.has(dk)) continue;
      seenDate.add(dk);
    } else {
      labelSuffix = `banda ${i + 1}`;
      if (seenFallback.has(labelSuffix)) continue;
      seenFallback.add(labelSuffix);
    }
    specs.push({ band: i + 1, labelSuffix });
  }
  return specs.length ? specs : [{ band: 1, labelSuffix: "" }];
}

/** Quita entradas de inventario con la misma ruta (p. ej. duplicados por casing o escaneo). */
function dedupeIndexInventoryRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const k = String(row.relative_path || "").replace(/\\/g, "/").toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

/** ``NDVI · 05/10/2025`` → ``2025-10-05`` para orden y deduplicación entre varios stacks en disco. */
function isoDateFromIndexGalleryLabel(label) {
  const m = String(label || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mo, yyyy] = m;
  return `${yyyy}-${mo}-${dd}`;
}

/**
 * Una miniatura por fecha de escena: bajo ``indices/<INDICE>/`` pueden existir varios .tif con las mismas
 * fechas en ``band_dates`` (p. ej. corridas duplicadas del pipeline). Orden cronológico por fecha.
 */
function dedupeAndSortIndexGalleryItems(items) {
  const byKey = new Map();
  for (const it of items) {
    const lab = String(it.label || "").trim();
    const iso = isoDateFromIndexGalleryLabel(lab);
    const key = iso || lab;
    if (!byKey.has(key)) byKey.set(key, it);
  }
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

/** Miniaturas a pedir: una por banda/fecha en stacks de índice; una por capa en RGB. */
function previewSpecsForRaster(r) {
  const m = r.metadata || {};
  const n = m.index_stack_band_count;
  const dates = m.index_band_dates;
  if (m.s2_index_stack && typeof n === "number" && n >= 1 && Array.isArray(dates) && dates.length >= n) {
    return specsUniqueByBandDate(n, dates);
  }
  if (m.s2_index_stack && typeof n === "number" && n >= 1) {
    return specsUniqueByBandDate(n, []);
  }
  return [{ band: null, labelSuffix: null }];
}

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    if (!src || src.startsWith("data:image/svg")) {
      reject(new Error("skip"));
      return;
    }
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("load"));
    im.decoding = "async";
    im.src = src;
  });
}

function parseIsoFromGalleryItem(item) {
  const raw = item?.raw;
  if (raw && typeof raw.sort_key === "string") {
    const head = raw.sort_key.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
  }
  if (raw && typeof raw === "object" && raw.metadata) {
    const sk = raw.metadata.s2_sort_key;
    if (typeof sk === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sk)) return sk;
  }
  const lbl = String(item?.label || "");
  const ps = lbl.match(/^PS_(\d{2})\/(\d{2})\/(\d{2})(?:\s|\(|$)/);
  if (ps) {
    const dd = ps[1];
    const mm = ps[2];
    const yy2 = ps[3];
    const y2 = parseInt(yy2, 10);
    const y4 = y2 >= 70 ? `19${yy2}` : `20${yy2}`;
    return `${y4}-${mm}-${dd}`;
  }
  const m = lbl.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const isoish = lbl.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoish) return `${isoish[1]}-${isoish[2]}-${isoish[3]}`;
  return null;
}

function mmyyFromIso(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "0000";
  const [y, mo] = iso.split("-");
  return `${mo.padStart(2, "0")}${String(y).slice(-2)}`;
}

function startEndMmyyFromItems(items) {
  const isos = [...items.map(parseIsoFromGalleryItem).filter(Boolean)].sort();
  if (!isos.length) {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    const fb = `${mm}${yy}`;
    return { start: fb, end: fb };
  }
  return { start: mmyyFromIso(isos[0]), end: mmyyFromIso(isos[isos.length - 1]) };
}

function sanitizeExportProjectName(name) {
  const s = String(name || "")
    .replace(/[/\\?%*:|"<>]/g, "")
    .trim();
  return s || "Proyecto";
}

function buildGalleryJpegBasename({
  mode,
  galleryVisualMode,
  pipelineVariant,
  activeIndexKey,
  s1PrepSigmaPol,
  s1VvPalette,
  items,
  projectName,
}) {
  const { start, end } = startEndMmyyFromItems(items);
  const proj = sanitizeExportProjectName(projectName);
  const pv = pipelineVariant === "ps" ? "PS" : "S2";

  if (mode === "view" && galleryVisualMode === "rgb") return `RGB_${pv}_${start}_${end} ${proj}`;
  if (mode === "view" && galleryVisualMode === "index")
    return `IDX_${String(activeIndexKey || "NDVI").toUpperCase()}_${pv}_${start}_${end} ${proj}`;
  if (mode === "view" && galleryVisualMode === "s1-sar-index")
    return `IDXSAR_${String(activeIndexKey || "RVI").toUpperCase()}_${start}_${end} ${proj}`;
  if (mode === "view" && galleryVisualMode === "s1-vv") {
    const pol = s1PrepSigmaPol === "vh" ? "VH" : "VV";
    return `S1PREP_${pol}_${String(s1VvPalette || "spectral")}_${start}_${end} ${proj}`;
  }
  if (mode === "view" && galleryVisualMode === "s1-vh") return `S1GRD_VH_${start}_${end} ${proj}`;
  if (mode === "view" && galleryVisualMode === "s1-index") return `S1GRD_VHVV_${start}_${end} ${proj}`;
  return `GALERIA_${pv}_${start}_${end} ${proj}`;
}

async function exportGalleryMosaicJpeg({ items, basenameNoExt }) {
  const GAP = 20;
  const CAPTION_H = 28;
  const images = [];
  for (const it of items) {
    try {
      const im = await loadImageElement(it.src || "");
      images.push({ img: im, label: it.label || "—" });
    } catch {
      images.push({ img: null, label: it.label || "—" });
    }
  }
  let maxW = 1;
  let maxH = 1;
  for (const { img } of images) {
    if (!img) continue;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    maxW = Math.max(maxW, w);
    maxH = Math.max(maxH, h);
  }
  const n = images.length;
  const cols = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols) || 1;
  const cellW = maxW + GAP;
  const cellH = maxH + CAPTION_H + GAP;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cellW + GAP;
  canvas.height = rows * cellH + GAP;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  images.forEach(({ img, label }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const iw = img ? img.naturalWidth || img.width : 0;
    const ih = img ? img.naturalHeight || img.height : 0;
    const x0 = GAP + col * cellW + (maxW - iw) / 2;
    const y0 = GAP + row * cellH;
    if (img) {
      ctx.drawImage(img, x0, y0, iw, ih);
    } else {
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(x0, y0, maxW, maxH);
    }
    ctx.fillStyle = "#222";
    ctx.font = "600 12px system-ui,sans-serif";
    const tx = GAP + col * cellW + maxW / 2;
    const line = String(label).replace(/\s+/g, " ").trim();
    const short = line.length > 44 ? `${line.slice(0, 42)}…` : line;
    ctx.fillText(short, tx, y0 + maxH + 18);
  });
  const file = `${basenameNoExt}.jpg`;
  const blob = await new Promise((res) => {
    canvas.toBlob((b) => res(b), "image/jpeg", 0.98);
  });
  if (!blob) throw new Error("blob");
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: file,
        types: [{ description: "JPEG", accept: { "image/jpeg": [".jpg", ".jpeg"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.replace(/[/\\?%*:|"<>]/g, "_");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Orden de índices en la galería (mismo que estimación). */
const GALLERY_INDEX_KEYS = ["NDVI", "EVI", "NDWI", "CIre", "MCARI"];

/** PlanetScope ``indecesPS/`` (mismo orden que catálogo estimación). */
const GALLERY_INDEX_KEYS_PS = [
  "NDVI",
  "NDWI",
  "MSAVI2",
  "MTVI2",
  "VARI",
  "TGI",
  "KNDVI",
  "GIYI",
  "MCARI",
  "NDRE",
  "RSTRUCTURE",
];

/** Orden de índices SAR en galería (carpetas bajo ``s1indices/``). */
const GALLERY_S1_SAR_INDEX_KEYS = ["RVI", "RFDI", "VV_VH", "VH_VV", "NRPB"];

function labelS1SarIndexTab(key) {
  if (key === "VV_VH") return "VV/VH";
  if (key === "VH_VV") return "VH/VV";
  return key;
}

function labelIndexGalleryTab(galleryVisualMode, key) {
  if (galleryVisualMode === "s1-sar-index") return labelS1SarIndexTab(key);
  if (key === "RSTRUCTURE") return "R_structure";
  return key;
}

/** Claves SAR para intersección de fechas en series de tiempo (``s1indices/``). */
const S1_SAR_TS_INDEX_KEYS = ["RVI", "RFDI", "VV_VH", "VH_VV", "NRPB"];

function pickPrimarySarStacksByKey(items) {
  const map = new Map();
  for (const k of S1_SAR_TS_INDEX_KEYS) {
    const rows = (items || []).filter((r) => String(r.index_key || "").toUpperCase() === k);
    if (!rows.length) continue;
    const best = rows.reduce((a, b) => (Number(b.bands) > Number(a.bands) ? b : a));
    map.set(k, best);
  }
  return map;
}

function intersectionSarDatesFromStacks(map) {
  if (map.size < S1_SAR_TS_INDEX_KEYS.length) return [];
  const sets = S1_SAR_TS_INDEX_KEYS.map((k) => {
    const dates = map.get(k)?.band_dates || [];
    return new Set(dates.map((d) => String(d).slice(0, 10)));
  });
  let inter = sets[0];
  for (let i = 1; i < sets.length; i += 1) {
    inter = new Set([...inter].filter((x) => sets[i].has(x)));
  }
  return [...inter].sort();
}

function bandIndexForIsoDate(bandDates, iso) {
  const w = String(iso).slice(0, 10);
  const idx = (bandDates || []).findIndex((d) => String(d).slice(0, 10) === w);
  return idx >= 0 ? idx + 1 : null;
}

function withPipelineVariant(url, pipelineVariant) {
  const v = pipelineVariant === "ps" ? "ps" : "s2";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}pipeline_variant=${encodeURIComponent(v)}`;
}

/**
 * @param {"view" | "indexSelect" | "timeSeriesSelect" | "s1SarIndexSelect" | "s1SarTimeSeriesSelect"} mode - view: galería; indexSelect: S2 índices; s1SarIndexSelect: índices SAR (s1prepoceso); s1SarTimeSeriesSelect: fechas desde s1indices/
 * @param {"rgb" | "index" | "s1-sar-index" | "s1-vv" | "s1-vh" | "s1-index"} [galleryVisualMode] - view: RGB L2A, índices S2, índices SAR (``s1indices/``), o VV/VH/índice S1
 */
export default function RgbTimeSeriesGallery({
  open,
  onClose,
  mode = "view",
  onEstimateIndices,
  onTimeSeries,
  canEstimate = true,
  galleryVisualMode = "rgb",
  /** Catálogo de índices (paso 3): checkboxes en la ventana si mode === indexSelect */
  indexCatalog = null,
  selectedIndices = [],
  onSelectedIndicesChange,
  projectId,
  token,
  pipelineVariant = "s2",
  /** Nombre del proyecto para nombre sugerido al exportar JPEG */
  projectName = "",
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [activeIndexKey, setActiveIndexKey] = useState("NDVI");
  const [indexInfoKey, setIndexInfoKey] = useState(null);
  /** null | clave de ayuda contextual (vista galería RGB / índices / S1). */
  const [galleryHelpKey, setGalleryHelpKey] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  /** Paleta matplotlib para galería Visual VV (s1prepoceso Sigma0 dB). */
  const [s1VvPalette, setS1VvPalette] = useState("spectral");
  /** Sigma0 en s1prepoceso: VV → Sigma0_VV_db.img, VH → Sigma0_VH_db.img */
  const [s1PrepSigmaPol, setS1PrepSigmaPol] = useState("vv");
  const blobUrlsRef = useRef([]);
  const scrollRef = useRef(null);

  const mainIndexIds =
    indexCatalog?.filter((o) => o.id !== "TODOS").map((o) => o.id) ?? [];
  const allMainIndicesSelected =
    mainIndexIds.length > 0 && mainIndexIds.every((id) => selectedIndices.includes(id));

  function toggleTodosIndices() {
    if (!onSelectedIndicesChange) return;
    if (allMainIndicesSelected) {
      onSelectedIndicesChange([]);
    } else {
      onSelectedIndicesChange([...mainIndexIds]);
    }
  }

  function toggleOneIndex(id) {
    if (!onSelectedIndicesChange) return;
    if (id === "TODOS") {
      toggleTodosIndices();
      return;
    }
    if (selectedIndices.includes(id)) {
      onSelectedIndicesChange(selectedIndices.filter((x) => x !== id));
    } else {
      onSelectedIndicesChange([...selectedIndices, id]);
    }
  }

  const indexMode = mode === "indexSelect" || mode === "timeSeriesSelect";
  const s1SarIndexMode = mode === "s1SarIndexSelect";
  const s1SarTsMode = mode === "s1SarTimeSeriesSelect";
  /** Escenas con checkbox (L2A índices, series tiempo, índices SAR, series SAR). */
  const sceneCheckboxMode = indexMode || s1SarIndexMode || s1SarTsMode;
  const showIndexSwitcher =
    !indexMode &&
    !s1SarIndexMode &&
    !s1SarTsMode &&
    (galleryVisualMode === "index" || galleryVisualMode === "s1-sar-index");
  const indexGalleryKeys =
    galleryVisualMode === "s1-sar-index"
      ? GALLERY_S1_SAR_INDEX_KEYS
      : pipelineVariant === "ps"
        ? GALLERY_INDEX_KEYS_PS
        : GALLERY_INDEX_KEYS;
  const s1VizMode = isS1GalleryVisualMode(galleryVisualMode);

  useEffect(() => {
    if (open) setZoom(1);
    if (open && sceneCheckboxMode) setSelectedIds(new Set());
  }, [open, sceneCheckboxMode]);

  useEffect(() => {
    if (!open) setGalleryHelpKey(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setActiveIndexKey("NDVI");
      return;
    }
    if (galleryVisualMode === "s1-sar-index") setActiveIndexKey("RVI");
    else if (galleryVisualMode === "index") setActiveIndexKey("NDVI");
  }, [open, galleryVisualMode]);

  useEffect(() => {
    if (!open || !projectId || !token) return undefined;

    let cancelled = false;
    blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    blobUrlsRef.current = [];
    setItems([]);
    setError("");

    (async () => {
      setLoading(true);
      try {
        setAuthToken(token);
        const base = API_URL.replace(/\/$/, "");
        const loaded = [];

        if (mode === "indexSelect" || mode === "timeSeriesSelect") {
          const invRes = await api.get(
            withPipelineVariant(`/preprocess/recortes-inventory/${projectId}`, pipelineVariant)
          );
          if (cancelled) return;
          let rows = invRes.data?.items || [];
          if (pipelineVariant === "ps") {
            rows = rows.filter((r) => PS_RECORTE_TIF_BASENAME_RE.test(String(r.basename || "")));
          }
          for (const row of rows) {
            if (cancelled) break;
            const basename = row.basename;
            const rel = row.relative_path || basename;
            if (!rel) continue;
            const rid = row.raster_layer_id;
            const sk = row.sort_key || "";
            const url = rid
              ? `${base}/raster/${projectId}/${rid}/preview?v=${rid}`
              : withPipelineVariant(
                  `${base}/preprocess/recortes-preview/${projectId}?path=${encodeURIComponent(rel)}`,
                  pipelineVariant
                );
            let objectUrl = null;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (resp.ok) {
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
              }
            } catch (_) {
              /* se muestra placeholder */
            }
            const label = formatSceneDateLabel(sk);
            loaded.push({
              id: `inv:${rel}`,
              rasterLayerId: rid ?? null,
              basename,
              relativePath: rel,
              label,
              src: objectUrl,
              raw: row,
            });
          }
        } else if (mode === "s1SarIndexSelect") {
          const invRes = await api.get(`/preprocess/s1-prepoceso-sar-scenes-inventory/${projectId}`);
          if (cancelled) return;
          const rows = Array.isArray(invRes.data?.items) ? invRes.data.items : [];
          for (const row of rows) {
            if (cancelled) break;
            const rel = row.scene_vv_relpath;
            if (!rel) continue;
            const url = `${base}/preprocess/s1-prepoceso-sigma0-vv-preview/${projectId}?path=${encodeURIComponent(
              rel
            )}&pol=vv&palette=spectral`;
            let objectUrl = null;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (resp.ok) {
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
              }
            } catch (_) {
              /* placeholder */
            }
            const label = formatSceneDateLabel(row.sort_key || "");
            loaded.push({
              id: `s1sar:${rel}`,
              rasterLayerId: null,
              basename: "Sigma0_VV_db.img",
              relativePath: rel,
              label,
              src: objectUrl,
              raw: row,
            });
          }
        } else if (mode === "s1SarTimeSeriesSelect") {
          const invRes = await api.get(`/preprocess/s1-sar-index-stacks-inventory/${projectId}`);
          if (cancelled) return;
          const rows = Array.isArray(invRes.data?.items) ? invRes.data.items : [];
          const byKey = pickPrimarySarStacksByKey(rows);
          const dateList = intersectionSarDatesFromStacks(byKey);
          const rvi = byKey.get("RVI");
          for (const iso of dateList) {
            if (cancelled) break;
            if (!rvi?.relative_path) continue;
            const bi = bandIndexForIsoDate(rvi.band_dates, iso);
            if (bi == null) continue;
            const url = `${base}/preprocess/s1-sar-index-stacks-preview/${projectId}?path=${encodeURIComponent(
              rvi.relative_path
            )}&band=${bi}&index_palette=1`;
            let objectUrl = null;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (resp.ok) {
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
              }
            } catch (_) {
              /* placeholder */
            }
            const label = formatIsoDateDdMmYyyy(iso);
            loaded.push({
              id: `sarts:${iso}`,
              rasterLayerId: null,
              label,
              src: objectUrl,
              raw: { iso_date: iso, preview_index: "RVI" },
            });
          }
        } else if (mode === "view" && galleryVisualMode === "index") {
          const invRes = await api.get(
            withPipelineVariant(`/preprocess/index-stacks-inventory/${projectId}`, pipelineVariant)
          );
          if (cancelled) return;
          const allRows = invRes.data?.items || [];
          const normIdx = (k) => String(k || "").toUpperCase();
          const ak = normIdx(activeIndexKey);
          const rows = dedupeIndexInventoryRows(allRows.filter((row) => normIdx(row.index_key) === ak));
          for (const row of rows) {
            if (cancelled) break;
            const nb = Number(row.bands);
            const dates = Array.isArray(row.band_dates) ? row.band_dates : [];
            const specs = specsUniqueByBandDate(nb, dates);
            const idxName = row.index_key || activeIndexKey || "";
            for (const spec of specs) {
              if (cancelled) break;
              const bandQ = spec.band != null ? `&band=${spec.band}` : "";
              const url = withPipelineVariant(
                `${base}/preprocess/index-stacks-preview/${projectId}?path=${encodeURIComponent(
                  row.relative_path
                )}${bandQ}&index_palette=1`,
                pipelineVariant
              );
              try {
                const resp = await fetch(url, {
                  headers: { Authorization: `Bearer ${token}` },
                  cache: "no-store",
                });
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
                const label =
                  spec.labelSuffix && idxName
                    ? `${idxName} · ${spec.labelSuffix}`
                    : idxName || spec.labelSuffix;
                loaded.push({
                  id: `idx:${row.relative_path}-b${spec.band}`,
                  rasterLayerId: null,
                  label,
                  src: objectUrl,
                  raw: row,
                });
              } catch (_) {
                /* omitir */
              }
            }
          }
        } else if (mode === "view" && galleryVisualMode === "s1-sar-index") {
          const invRes = await api.get(`/preprocess/s1-sar-index-stacks-inventory/${projectId}`);
          if (cancelled) return;
          const allRows = invRes.data?.items || [];
          const normIdx = (k) => String(k || "").toUpperCase();
          const sarActiveKey = GALLERY_S1_SAR_INDEX_KEYS.includes(activeIndexKey)
            ? activeIndexKey
            : "RVI";
          const ak = normIdx(sarActiveKey);
          const rows = dedupeIndexInventoryRows(allRows.filter((row) => normIdx(row.index_key) === ak));
          for (const row of rows) {
            if (cancelled) break;
            const nb = Number(row.bands);
            const dates = Array.isArray(row.band_dates) ? row.band_dates : [];
            const specs = specsUniqueByBandDate(nb, dates);
            const idxName = labelS1SarIndexTab(row.index_key || sarActiveKey || "");
            for (const spec of specs) {
              if (cancelled) break;
              const bandQ = spec.band != null ? `&band=${spec.band}` : "";
              const url = `${base}/preprocess/s1-sar-index-stacks-preview/${projectId}?path=${encodeURIComponent(
                row.relative_path
              )}${bandQ}&index_palette=1`;
              try {
                const resp = await fetch(url, {
                  headers: { Authorization: `Bearer ${token}` },
                  cache: "no-store",
                });
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
                const label =
                  spec.labelSuffix && idxName
                    ? `${idxName} · ${spec.labelSuffix}`
                    : idxName || spec.labelSuffix;
                loaded.push({
                  id: `idx:${row.relative_path}-b${spec.band}`,
                  rasterLayerId: null,
                  label,
                  src: objectUrl,
                  raw: row,
                });
              } catch (_) {
                /* omitir */
              }
            }
          }
        } else if (mode === "view" && galleryVisualMode === "s1-vv") {
          const pol = s1PrepSigmaPol === "vh" ? "vh" : "vv";
          const invRes = await api.get(
            `/preprocess/s1-prepoceso-sigma0-vv-inventory/${projectId}?pol=${encodeURIComponent(pol)}`
          );
          if (cancelled) return;
          const rows = Array.isArray(invRes.data?.items) ? invRes.data.items : [];
          for (const row of rows) {
            if (cancelled) break;
            const rel = row.relative_path;
            if (!rel) continue;
            const url = `${base}/preprocess/s1-prepoceso-sigma0-vv-preview/${projectId}?path=${encodeURIComponent(
              rel
            )}&pol=${encodeURIComponent(pol)}&palette=${encodeURIComponent(s1VvPalette)}`;
            let objectUrl = null;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (resp.ok) {
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
              }
            } catch (_) {
              /* placeholder */
            }
            const label = formatSceneDateLabel(row.sort_key || "");
            loaded.push({
              id: `s1prep:${pol}:${rel}`,
              rasterLayerId: null,
              basename: row.basename,
              relativePath: rel,
              label,
              src: objectUrl,
              raw: row,
            });
          }
        } else if (mode === "view" && s1VizMode) {
          const res = await api.get(`/raster/${projectId}`);
          if (cancelled) return;
          const raw = res.data || [];
          let rows = filterS1GrdRecortes(raw);
          rows = [...rows].sort((a, b) => {
            const ka = rasterSortKeyFromMetadata(a.metadata);
            const kb = rasterSortKeyFromMetadata(b.metadata);
            const c = ka.localeCompare(kb);
            if (c !== 0) return c;
            return (a.id || 0) - (b.id || 0);
          });
          let s1PreviewExtra = "&s1_derived=vh_vv_ratio";
          if (galleryVisualMode === "s1-vh") {
            s1PreviewExtra = "&band=2";
          }

          for (const r of rows) {
            if (cancelled) break;
            const url = `${base}/raster/${projectId}/${r.id}/preview?v=${r.id}${s1PreviewExtra}`;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (!resp.ok) continue;
              const blob = await resp.blob();
              const objectUrl = URL.createObjectURL(blob);
              blobUrlsRef.current.push(objectUrl);
              const label = formatRecorteDisplayName(r.metadata, r.name) || r.name;
              loaded.push({
                id: r.id,
                rasterLayerId: r.id,
                label,
                src: objectUrl,
                raw: r,
              });
            } catch (_) {
              /* omitir capa sin preview */
            }
          }
        } else if (mode === "view" && galleryVisualMode === "rgb" && pipelineVariant === "ps") {
          const invRes = await api.get(
            withPipelineVariant(`/preprocess/recortes-inventory/${projectId}`, "ps")
          );
          if (cancelled) return;
          const rowsRaw = invRes.data?.items || [];
          const rows = [...rowsRaw]
            .filter((r) => PS_RECORTE_TIF_BASENAME_RE.test(String(r.basename || "")))
            .sort((a, b) => {
            const ka = String(a.sort_key || "").slice(0, 10);
            const kb = String(b.sort_key || "").slice(0, 10);
            const c = ka.localeCompare(kb);
            if (c !== 0) return c;
            return String(a.relative_path || "").localeCompare(String(b.relative_path || ""));
          });
          for (const row of rows) {
            if (cancelled) break;
            const basename = row.basename;
            const rel = row.relative_path || basename;
            if (!rel) continue;
            const rid = row.raster_layer_id;
            // Siempre ``recortes-preview`` + pipeline PS: enlaza por ``source_name`` al COG de la capa
            // (mismo GeoTIFF que el mapa) y unifica estirado RGB con el backend de preproceso.
            const url = withPipelineVariant(
              `${base}/preprocess/recortes-preview/${projectId}?path=${encodeURIComponent(rel)}`,
              "ps"
            );
            let objectUrl = null;
            try {
              const resp = await fetch(url, {
                headers: { Authorization: `Bearer ${token}` },
                cache: "no-store",
              });
              if (resp.ok) {
                const blob = await resp.blob();
                objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
              }
            } catch (_) {
              /* placeholder */
            }
            const label = labelPsRgbFromBasename(basename);
            loaded.push({
              id: `psrgb:${rel}`,
              rasterLayerId: rid ?? null,
              basename,
              relativePath: rel,
              label,
              src: objectUrl,
              raw: row,
            });
          }
        } else {
          const res = await api.get(`/raster/${projectId}`);
          if (cancelled) return;
          const raw = res.data || [];
          let rows;
          if (indexMode) {
            rows = filterSixBandStackRasters(raw);
          } else if (pipelineVariant === "s2") {
            rows = filterGalleryRastersS2Pipeline(raw);
          } else {
            rows = filterGalleryRasters(raw);
          }
          rows = [...rows].sort((a, b) => {
            const ka = rasterSortKeyFromMetadata(a.metadata);
            const kb = rasterSortKeyFromMetadata(b.metadata);
            const c = ka.localeCompare(kb);
            if (c !== 0) return c;
            return (a.id || 0) - (b.id || 0);
          });

          for (const r of rows) {
            if (cancelled) break;
            const specs = previewSpecsForRaster(r);
            const m = r.metadata || {};
            const idxName = m.vegetation_index_key || activeIndexKey || "";

            for (const spec of specs) {
              if (cancelled) break;
              const bandQ =
                spec.band != null ? `&band=${spec.band}` : "";
              const paletteQ =
                galleryVisualMode === "index" || galleryVisualMode === "s1-sar-index"
                  ? "&index_palette=1"
                  : "";
              const url = `${base}/raster/${projectId}/${r.id}/preview?v=${r.id}${bandQ}${paletteQ}`;
              try {
                const resp = await fetch(url, {
                  headers: { Authorization: `Bearer ${token}` },
                  cache: "no-store",
                });
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const objectUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(objectUrl);
                let label =
                  formatRecorteDisplayName(r.metadata, r.name) || r.name;
                if (m.s2_index_stack && spec.labelSuffix) {
                  label = `${idxName} · ${spec.labelSuffix}`;
                }
                const itemId =
                  spec.band != null ? `${r.id}-b${spec.band}` : r.id;
                loaded.push({
                  id: itemId,
                  rasterLayerId: r.id,
                  label,
                  src: objectUrl,
                  raw: r,
                });
              } catch (_) {
                /* omitir capa sin preview */
              }
            }
          }
        }

        let galleryItems = loaded;
        if (
          mode === "view" &&
          (galleryVisualMode === "index" || galleryVisualMode === "s1-sar-index")
        ) {
          galleryItems = dedupeAndSortIndexGalleryItems(loaded);
        }
        if (!cancelled) setItems(galleryItems);
      } catch (e) {
        if (!cancelled) {
          setError(formatApiErrorDetail(e) || "Error al cargar capas");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrlsRef.current = [];
    };
  }, [
    open,
    projectId,
    token,
    mode,
    indexMode,
    s1SarIndexMode,
    s1SarTsMode,
    galleryVisualMode,
    activeIndexKey,
    s1VvPalette,
    s1PrepSigmaPol,
    pipelineVariant,
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open) return undefined;

    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)));
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, items.length]);

  function adjustZoom(delta) {
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)));
  }

  const handleDownloadJpeg = useCallback(async () => {
    if (!items.length) return;
    setExportBusy(true);
    try {
      const basenameNoExt = buildGalleryJpegBasename({
        mode,
        galleryVisualMode,
        pipelineVariant,
        activeIndexKey,
        s1PrepSigmaPol,
        s1VvPalette,
        items,
        projectName,
      });
      await exportGalleryMosaicJpeg({ items, basenameNoExt });
    } catch (e) {
      console.error(e);
      window.alert(
        "No se pudo exportar el JPEG. Comprueba que las miniaturas hayan cargado. En algunos navegadores la descarga va a la carpeta de descargas con el nombre sugerido."
      );
    } finally {
      setExportBusy(false);
    }
  }, [
    items,
    mode,
    galleryVisualMode,
    pipelineVariant,
    activeIndexKey,
    s1PrepSigmaPol,
    s1VvPalette,
    projectName,
  ]);

  function stepActiveIndex(delta) {
    setActiveIndexKey((prev) => {
      const keys = indexGalleryKeys;
      const i = keys.indexOf(prev);
      const n = keys.length;
      const start = i >= 0 ? i : 0;
      const j = (start + delta + n * 10) % n;
      return keys[j];
    });
  }

  useEffect(() => {
    if (!open || !showIndexSwitcher) return undefined;
    const keys = indexGalleryKeys;
    function onKey(e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setActiveIndexKey((prev) => {
          const i = keys.indexOf(prev);
          const n = keys.length;
          const start = i >= 0 ? i : 0;
          const d = e.key === "ArrowLeft" ? -1 : 1;
          const j = (start + d + n * 10) % n;
          return keys[j];
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, showIndexSwitcher, indexGalleryKeys]);

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllScenes() {
    setSelectedIds(new Set(items.map((it) => it.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function handleEstimate() {
    if (!onEstimateIndices || !canEstimate) return;
    if (mode === "s1SarIndexSelect") {
      const paths = [...selectedIds]
        .map((id) => {
          const s = String(id);
          return s.startsWith("s1sar:") ? s.slice("s1sar:".length) : null;
        })
        .filter(Boolean);
      const uniq = [...new Set(paths)];
      if (uniq.length === 0) return;
      onEstimateIndices({ s1SarSceneVvRelpaths: uniq, s1SarIndices: [...selectedIndices] });
      return;
    }
    if (mode === "indexSelect") {
      const names = [...selectedIds]
        .map((id) => {
          const s = String(id);
          return s.startsWith("inv:") ? s.slice(4) : null;
        })
        .filter(Boolean);
      const uniq = [...new Set(names)];
      if (uniq.length === 0) return;
      onEstimateIndices({ recorteFilenames: uniq });
      return;
    }
    const raw = [...selectedIds].map((id) => Number(id));
    const uniq = [...new Set(raw.filter((n) => Number.isFinite(n) && n >= 1))].sort((a, b) => a - b);
    if (uniq.length === 0) return;
    onEstimateIndices(uniq);
  }

  function handleTimeSeriesClick() {
    if (!onTimeSeries) return;
    if (mode === "s1SarTimeSeriesSelect") {
      const dates = [...selectedIds]
        .map((id) => {
          const s = String(id);
          return s.startsWith("sarts:") ? s.slice("sarts:".length) : null;
        })
        .filter(Boolean);
      const uniq = [...new Set(dates)].sort();
      if (uniq.length === 0) return;
      onTimeSeries({ s1SarDates: uniq });
      return;
    }
    if (mode === "timeSeriesSelect") {
      const rasterLayerIds = [];
      const recorteRelativePaths = [];
      for (const sid of selectedIds) {
        const item = items.find((i) => i.id === sid);
        if (!item) continue;
        if (item.rasterLayerId != null && Number.isFinite(Number(item.rasterLayerId))) {
          rasterLayerIds.push(Number(item.rasterLayerId));
        }
        if (item.relativePath) {
          recorteRelativePaths.push(String(item.relativePath));
        }
      }
      const uniqIds = [...new Set(rasterLayerIds)].sort((a, b) => a - b);
      const uniqPaths = [...new Set(recorteRelativePaths)];
      if (uniqIds.length === 0 && uniqPaths.length === 0) return;
      onTimeSeries({
        rasterLayerIds: uniqIds,
        recorteRelativePaths: uniqPaths,
        pipelineVariant: pipelineVariant === "ps" ? "ps" : "s2",
      });
      return;
    }
    const ids = [];
    for (const sid of selectedIds) {
      const item = items.find((i) => i.id === sid);
      if (item?.rasterLayerId != null && Number.isFinite(Number(item.rasterLayerId))) {
        ids.push(Number(item.rasterLayerId));
        continue;
      }
      const s = String(sid);
      const m = s.match(/^(\d+)-b\d+$/);
      const n = Number(m ? m[1] : s);
      if (Number.isFinite(n) && n >= 1) ids.push(n);
    }
    const uniq = [...new Set(ids)].sort((a, b) => a - b);
    if (uniq.length === 0) return;
    onTimeSeries(uniq);
  }

  if (!open) return null;

  const title =
    mode === "timeSeriesSelect"
      ? pipelineVariant === "ps"
        ? "Escenas PlanetScope (8 bandas) — series de tiempo"
        : "Escenas L2A (6 bandas) — series de tiempo"
      : mode === "s1SarTimeSeriesSelect"
        ? "Fechas índices SAR (s1indices/) — series de tiempo"
        : mode === "s1SarIndexSelect"
          ? "Escenas Sentinel-1 (sigma0) — estimar índices SAR"
        : mode === "indexSelect"
            ? "Escenas L2A (6 bandas) — selección para índices"
            : showIndexSwitcher
          ? galleryVisualMode === "s1-sar-index"
            ? "Visual índices SAR — serie temporal"
            : "Visual índices — serie temporal"
          : mode === "view" && galleryVisualMode === "s1-vv"
            ? "Visual VV/VH — serie temporal"
            : mode === "view" && galleryVisualMode === "s1-vh"
              ? "Visual VH — serie temporal"
              : mode === "view" && galleryVisualMode === "s1-index"
                ? "Visual índice S1 (VH/VV) — serie temporal"
                : "Visual RGB — serie temporal";

  const subtitle =
    mode === "timeSeriesSelect" ? (
      pipelineVariant === "ps" ? (
        <>
          Mismo flujo que Sentinel-2: elige escenas en <code>recortesPS/</code>, luego pulsa{" "}
          <strong>Series de tiempo</strong>. Se grafican los índices del catálogo PS (NDVI, NDWI, MSAVI2, …) con
          valores 0–1 (min-max por escena) y fechas en el eje X.
        </>
      ) : (
        <>
          Pulsa cada miniatura para incluir o excluir escenas. Cuando termines, pulsa{" "}
          <strong>Series de tiempo</strong> para graficar NDVI, EVI, NDWI, CIre y MCARI (fechas en el eje X).
        </>
      )
    ) : mode === "s1SarTimeSeriesSelect" ? (
      <>
        Selecciona las <strong>fechas</strong> presentes en <strong>los cinco</strong> stacks bajo{" "}
        <code>s1indices/</code> (intersección de fechas). La miniatura usa el stack <strong>RVI</strong> por banda.
        Al finalizar, pulsa <strong>Series de tiempo</strong> para graficar RVI, RFDI, VV/VH, VH/VV y NRPB (valores
        normalizados 0–1 por fecha, como en Sentinel-2).
      </>
    ) : mode === "s1SarIndexSelect" ? (
      <>
        Marca los <strong>índices SAR</strong> (RVI, RFDI, …) y las <strong>escenas</strong>. Cada escena usa en la
        misma carpeta: <strong>VV</strong> = <code>Sigma0_VV_db.img</code>, <strong>VH</strong> ={" "}
        <code>Sigma0_VH_db.img</code> (sigma0 dB bajo <code>s1prepoceso/</code>). Por cada índice, un stack en{" "}
        <code>s1indices/&lt;ÍNDICE&gt;/</code> con <strong>una banda por fecha</strong> (orden cronológico).
      </>
    ) : indexMode ? (
      <>
        Marca los <strong>índices</strong> (arriba) y las <strong>escenas</strong> (cada una corresponde a un GeoTIFF
        en <code>recortes/</code>). La estimación usa <strong>solo las escenas seleccionadas</strong>.
      </>
    ) : showIndexSwitcher ? null
    : mode === "view" && galleryVisualMode === "s1-index"
      ? null
      : mode === "view" && galleryVisualMode === "s1-vv"
        ? null
        : mode === "view" && galleryVisualMode === "s1-vh"
          ? null
          : null;

  const emptyMsg =
    mode === "s1SarTimeSeriesSelect"
      ? "No hay cinco stacks SAR con al menos una fecha en común en s1indices/. Ejecuta el paso 3 (Estimar índices SAR) primero."
      : mode === "indexSelect" || mode === "timeSeriesSelect"
        ? pipelineVariant === "ps"
          ? "No hay GeoTIFF PlanetScope (8+ bandas, nombre PS_*.tif) en recortesPS/. Ejecuta el paso 1 (recortes PS)."
          : "No hay GeoTIFF L2A (6+ bandas) en la carpeta recortes/. Ejecuta el paso 1 (Procesar recortes L2A)."
        : mode === "s1SarIndexSelect"
          ? "No hay escenas con par VV+VH (Sigma0_VV_db.img y Sigma0_VH_db.img en la misma carpeta) en s1prepoceso/."
        : showIndexSwitcher
          ? galleryVisualMode === "s1-sar-index"
            ? `No hay stack de ${labelS1SarIndexTab(activeIndexKey)} en disco (carpeta s1indices/${activeIndexKey}/). Estima índices SAR en la pestaña Sentinel-1 (paso 3).`
            : pipelineVariant === "ps"
              ? `No hay stack de ${activeIndexKey} en disco (carpeta indecesPS/${activeIndexKey}/). Usa el paso 3 (Estimar índices) en esta pestaña Planet.`
              : `No hay stack de ${activeIndexKey} en disco (carpeta indices/${activeIndexKey}/). Usa el paso 3 (Estimar índices).`
          : mode === "view" && galleryVisualMode === "s1-vv"
            ? s1PrepSigmaPol === "vh"
              ? "No hay Sigma0_VH_db.img en la carpeta s1prepoceso/ del proyecto (o no se pudo leer ninguno)."
              : "No hay Sigma0_VV_db.img en la carpeta s1prepoceso/ del proyecto (o no se pudo leer ninguno)."
            : mode === "view" && s1VizMode
              ? "No hay recortes Sentinel-1 (VV+VH) en el proyecto. Lista productos GRD en la pestaña SI y ejecuta recortes."
              : "No hay capas raster con vista RGB en este proyecto. Procesa recortes L2A en el paso 1 o sube un GeoTIFF Sentinel-2.";

  const infoEntry =
    indexInfoKey && indexCatalog?.length
      ? indexCatalog.find((x) => x.id === indexInfoKey)
      : null;

  const showViewGalleryInfoBtn =
    mode === "view" &&
    (galleryVisualMode === "rgb" ||
      showIndexSwitcher ||
      galleryVisualMode === "s1-index" ||
      galleryVisualMode === "s1-vv" ||
      galleryVisualMode === "s1-vh");

  function openViewGalleryHelp() {
    if (showIndexSwitcher) {
      setGalleryHelpKey(galleryVisualMode === "s1-sar-index" ? "sarIdxTabs" : "idxTabs");
    } else if (galleryVisualMode === "rgb") setGalleryHelpKey("rgb");
    else if (galleryVisualMode === "s1-vv") setGalleryHelpKey("s1vv");
    else if (galleryVisualMode === "s1-vh") setGalleryHelpKey("s1vh");
    else if (galleryVisualMode === "s1-index") setGalleryHelpKey("s1grdIdx");
  }

  const headerZoomToolbar =
    !loading && items.length > 0 ? (
      <div className="rgb-gallery-header-toolbar" role="group" aria-label="Zoom y exportación">
        <button
          type="button"
          className="rgb-gallery-zoom-btn"
          onClick={() => adjustZoom(-ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN + 1e-6}
          aria-label="Alejar"
        >
          −
        </button>
        <input
          type="range"
          className="rgb-gallery-zoom-range rgb-gallery-zoom-range--header"
          min={ZOOM_MIN * 100}
          max={ZOOM_MAX * 100}
          step={5}
          value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          aria-label="Nivel de zoom"
        />
        <button
          type="button"
          className="rgb-gallery-zoom-btn"
          onClick={() => adjustZoom(ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX - 1e-6}
          aria-label="Acercar"
        >
          +
        </button>
        <span className="rgb-gallery-zoom-pct">{Math.round(zoom * 100)}%</span>
        <button type="button" className="rgb-gallery-zoom-reset" onClick={() => setZoom(1)}>
          Restablecer
        </button>
        <button
          type="button"
          className="rgb-gallery-download-btn"
          onClick={() => void handleDownloadJpeg()}
          disabled={exportBusy}
          title="Mosaico JPEG a resolución nativa de las miniaturas (calidad 98 %). Nombre sugerido con rango de fechas."
        >
          {exportBusy ? "Exportando…" : "Descargar"}
        </button>
      </div>
    ) : null;

  return (
    <div className="rgb-gallery-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="rgb-gallery-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="rgb-gallery-window">
        <div className="rgb-gallery-header">
          <h2 className="rgb-gallery-title">{title}</h2>
          {headerZoomToolbar}
          <div className="rgb-gallery-header-actions">
            {showViewGalleryInfoBtn ? (
              <button
                type="button"
                className="rgb-gallery-info-btn"
                onClick={openViewGalleryHelp}
                aria-label="Información sobre esta galería y controles"
                title="Información"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                  <path d="M12 16v-4M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            ) : null}
            <button type="button" className="rgb-gallery-close" onClick={onClose} aria-label="Cerrar">
              ×
            </button>
          </div>
        </div>
        {subtitle ? <p className="rgb-gallery-sub">{subtitle}</p> : null}
        {(mode === "indexSelect" || mode === "s1SarIndexSelect") && indexCatalog?.length ? (
          <div
            className="rgb-gallery-index-picker"
            role="group"
            aria-label={mode === "s1SarIndexSelect" ? "Índices SAR a estimar" : "Índices de vegetación a estimar"}
          >
            <div className="rgb-gallery-index-picker-title">
              {mode === "s1SarIndexSelect" ? "Índices SAR a incluir en el stack" : "Índices a incluir en el stack"}
            </div>
            <div className="rgb-gallery-index-picker-grid">
              {indexCatalog.map((opt) => (
                <label key={opt.id} className="rgb-gallery-index-option">
                  <input
                    type="checkbox"
                    checked={
                      opt.id === "TODOS" ? allMainIndicesSelected : selectedIndices.includes(opt.id)
                    }
                    onChange={() => toggleOneIndex(opt.id)}
                  />
                  <span className="rgb-gallery-index-option-label">{opt.label}</span>
                  <button
                    type="button"
                    className="indices-info-btn"
                    title="Descripción técnica"
                    aria-label={`Información sobre ${opt.label}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIndexInfoKey(opt.id);
                    }}
                  >
                    i
                  </button>
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {showIndexSwitcher && (
          <div
            className="rgb-gallery-index-switcher"
            role="toolbar"
            aria-label={galleryVisualMode === "s1-sar-index" ? "Índice SAR a visualizar" : "Índice a visualizar"}
          >
            <button
              type="button"
              className="rgb-gallery-index-nav"
              onClick={() => stepActiveIndex(-1)}
              aria-label="Índice anterior"
            >
              ← Anterior
            </button>
            <div className="rgb-gallery-index-tabs">
              {indexGalleryKeys.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={
                    key === activeIndexKey
                      ? "rgb-gallery-index-tab rgb-gallery-index-tab--active"
                      : "rgb-gallery-index-tab"
                  }
                  onClick={() => setActiveIndexKey(key)}
                >
                  {labelIndexGalleryTab(galleryVisualMode, key)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="rgb-gallery-index-nav"
              onClick={() => stepActiveIndex(1)}
              aria-label="Siguiente índice"
            >
              Siguiente →
            </button>
          </div>
        )}
        {loading && <div className="rgb-gallery-status">Cargando vistas…</div>}
        {error && <div className="rgb-gallery-error">{error}</div>}
        {!loading && !error && items.length === 0 && (
          <div className="rgb-gallery-empty">{emptyMsg}</div>
        )}
        {!loading && items.length > 0 && (
          <>
            {!loading && items.length > 0 && mode === "view" && galleryVisualMode === "s1-vv" ? (
              <div
                className="rgb-gallery-toolbar rgb-gallery-toolbar--s1-only"
                aria-label="Polarización y paleta sigma0"
              >
                <div className="rgb-gallery-s1-pol" role="group" aria-label="Polarización sigma0">
                  <button
                    type="button"
                    className={
                      s1PrepSigmaPol === "vv"
                        ? "rgb-gallery-s1-pol-btn rgb-gallery-s1-pol-btn--active"
                        : "rgb-gallery-s1-pol-btn"
                    }
                    onClick={() => setS1PrepSigmaPol("vv")}
                  >
                    VV
                  </button>
                  <button
                    type="button"
                    className={
                      s1PrepSigmaPol === "vh"
                        ? "rgb-gallery-s1-pol-btn rgb-gallery-s1-pol-btn--active"
                        : "rgb-gallery-s1-pol-btn"
                    }
                    onClick={() => setS1PrepSigmaPol("vh")}
                  >
                    VH
                  </button>
                </div>
                <div className="rgb-gallery-s1-palette-inline" role="group" aria-label="Paleta de color">
                  <label className="rgb-gallery-s1-palette-inline-label">
                    <span>Paleta (sigma0 dB)</span>
                    <select
                      className="rgb-gallery-s1-palette-select"
                      value={s1VvPalette}
                      onChange={(e) => setS1VvPalette(e.target.value)}
                    >
                      <option value="spectral">Spectral</option>
                      <option value="jet">Jet</option>
                      <option value="turbo">Turbo</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : null}
            {sceneCheckboxMode && (
              <div className="rgb-gallery-index-bar">
                <span className="rgb-gallery-index-count">
                  Seleccionadas: {selectedIds.size} / {items.length}
                </span>
                <button type="button" className="rgb-gallery-index-action" onClick={selectAllScenes}>
                  Todas
                </button>
                <button type="button" className="rgb-gallery-index-action" onClick={clearSelection}>
                  Ninguna
                </button>
              </div>
            )}
            <div className="rgb-gallery-scroll" ref={scrollRef} tabIndex={0}>
              <div
                className="rgb-gallery-zoom-inner"
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                  width: `${100 / zoom}%`,
                }}
              >
                <div className="rgb-gallery-grid">
                  {items.map((it) => {
                    const selId = it.id;
                    const sel = sceneCheckboxMode && selectedIds.has(selId);
                    return (
                      <figure
                        key={it.id}
                        className={`rgb-gallery-cell${sel ? " rgb-gallery-cell--selected" : ""}${sceneCheckboxMode ? " rgb-gallery-cell--selectable" : ""}`}
                      >
                        <figcaption className="rgb-gallery-label">
                          {sceneCheckboxMode && (
                            <input
                              type="checkbox"
                              className="rgb-gallery-cell-check"
                              checked={sel}
                              onChange={() => toggleSelect(selId)}
                              aria-label={`Incluir escena ${it.label}`}
                            />
                          )}
                          <span>{it.label}</span>
                        </figcaption>
                        <div
                          className="rgb-gallery-thumb-wrap"
                          role={sceneCheckboxMode ? "button" : undefined}
                          tabIndex={sceneCheckboxMode ? 0 : undefined}
                          onClick={
                            sceneCheckboxMode ? () => toggleSelect(selId) : undefined
                          }
                          onKeyDown={
                            sceneCheckboxMode
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleSelect(selId);
                                  }
                                }
                              : undefined
                          }
                        >
                          <img
                            src={it.src || RECORTE_PREVIEW_PLACEHOLDER}
                            alt={it.label}
                            className="rgb-gallery-thumb"
                            loading="lazy"
                          />
                          {sceneCheckboxMode && (
                            <span className="rgb-gallery-select-hint" aria-hidden>
                              {sel ? "✓ Incluida" : "Clic para incluir"}
                            </span>
                          )}
                        </div>
                      </figure>
                    );
                  })}
                </div>
              </div>
            </div>
            {(mode === "timeSeriesSelect" || mode === "s1SarTimeSeriesSelect") && (
              <div className="rgb-gallery-footer-actions">
                <button type="button" className="rgb-gallery-btn-secondary" onClick={onClose}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="rgb-gallery-btn-primary"
                  onClick={handleTimeSeriesClick}
                  disabled={selectedIds.size === 0 || !onTimeSeries}
                  title={
                    selectedIds.size === 0
                      ? mode === "s1SarTimeSeriesSelect"
                        ? "Selecciona al menos una fecha"
                        : "Selecciona al menos una escena"
                      : undefined
                  }
                >
                  Series de tiempo
                </button>
              </div>
            )}
          </>
        )}
        {(mode === "indexSelect" || mode === "s1SarIndexSelect") && (
          <div className="rgb-gallery-footer-actions">
            <button type="button" className="rgb-gallery-btn-secondary" onClick={onClose}>
              Cancelar
            </button>
            <button
              type="button"
              className="rgb-gallery-btn-primary"
              onClick={handleEstimate}
              disabled={
                loading || !canEstimate || selectedIds.size === 0 || !onEstimateIndices
              }
              title={
                loading
                  ? "Cargando vistas…"
                  : !canEstimate
                    ? mode === "s1SarIndexSelect"
                      ? "Marca al menos un índice SAR arriba (RVI, RFDI, …)"
                      : "Marca al menos un índice arriba (NDVI, EVI, …)"
                    : selectedIds.size === 0
                      ? mode === "s1SarIndexSelect"
                        ? "Selecciona al menos una escena (VV+VH en s1prepoceso/)"
                        : "Selecciona al menos una escena (recorte L2A en recortes/)"
                      : undefined
              }
            >
              {mode === "s1SarIndexSelect" ? "Estimar índices SAR" : "Estimar índice"}
            </button>
          </div>
        )}
      </div>
      {infoEntry ? (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rgb-gallery-info-title"
          onClick={() => setIndexInfoKey(null)}
        >
          <div className="index-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="rgb-gallery-info-title">{infoEntry.label}</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setIndexInfoKey(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <p className="index-modal-body">{infoEntry.description}</p>
          </div>
        </div>
      ) : null}
      {galleryHelpKey ? (
        <div
          className="index-modal-overlay rgb-gallery-help-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rgb-gallery-view-help-title"
          onClick={() => setGalleryHelpKey(null)}
        >
          <div className="index-modal index-modal--gallery-help" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="rgb-gallery-view-help-title">
                {galleryHelpKey === "rgb"
                  ? "Visual RGB — serie temporal"
                  : galleryHelpKey === "idxTabs"
                    ? pipelineVariant === "ps"
                      ? "Visual índices PlanetScope — serie temporal"
                      : "Visual índices — serie temporal"
                    : galleryHelpKey === "sarIdxTabs"
                      ? "Visual índices SAR — serie temporal"
                      : galleryHelpKey === "s1vv"
                        ? "Visual VV/VH (sigma0) — serie temporal"
                        : galleryHelpKey === "s1vh"
                          ? "Visual VH — serie temporal"
                          : "Visual índice S1 (VH/VV) — serie temporal"}
              </h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setGalleryHelpKey(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body rgb-gallery-help-body">
              {galleryHelpKey === "rgb" ? (
                <>
                  <p>
                    Recortes con vista color natural (orden cronológico). Etiqueta: <code>dd/mm/aaaa_clip</code>{" "}
                    (desde la fecha de la escena).
                  </p>
                  <p>Zoom: Ctrl + rueda, botones +/− o la barra. Arrastra las barras para desplazarte.</p>
                  <p>
                    <strong>Descargar:</strong> genera un mosaico JPEG con cada miniatura a su resolución nativa
                    (calidad 98 %). Si el navegador lo permite, podrás elegir carpeta y nombre; el nombre sugerido
                    incluye mes/año de inicio y fin y el proyecto.
                  </p>
                </>
              ) : null}
              {galleryHelpKey === "idxTabs" ? (
                <>
                  <p>
                    Elige el índice abajo. Paleta <strong>RdYlGn</strong> (rojo = bajo, verde = alto) para{" "}
                    <strong>{labelIndexGalleryTab(galleryVisualMode, activeIndexKey)}</strong>. Una miniatura por
                    fecha.
                  </p>
                  <p>
                    Zoom: se mantiene al cambiar de índice. <strong>Ctrl + rueda</strong> o la barra. Flechas{" "}
                    <strong>← →</strong> entre índices. Arrastra las barras de desplazamiento para moverte por la
                    cuadrícula.
                  </p>
                  <p>
                    <strong>Descargar:</strong> mosaico JPEG a resolución nativa de las miniaturas del índice activo.
                  </p>
                </>
              ) : null}
              {galleryHelpKey === "sarIdxTabs" ? (
                <>
                  <p>
                    Elige el índice SAR abajo. Paleta <strong>RdYlGn</strong> para{" "}
                    <strong>{labelS1SarIndexTab(activeIndexKey)}</strong>. Una miniatura por fecha.
                  </p>
                  <p>
                    Zoom: se mantiene al cambiar de índice. <strong>Ctrl + rueda</strong> o la barra. Flechas{" "}
                    <strong>← →</strong> entre índices.
                  </p>
                  <p>
                    <strong>Descargar:</strong> mosaico JPEG a resolución nativa de las miniaturas del índice SAR
                    activo.
                  </p>
                </>
              ) : null}
              {galleryHelpKey === "s1vv" ? (
                <>
                  <p>
                    En la barra inferior: <strong>VV</strong> o <strong>VH</strong> elige{" "}
                    <code>Sigma0_VV_db.img</code> / <code>Sigma0_VH_db.img</code> bajo <code>s1prepoceso/</code>.
                    Paleta matplotlib (Spectral, Jet o Turbo) y etiqueta <code>dd/mm/aaaa</code> desde{" "}
                    <code>…_S1A_IW_GRDH_1SDV_YYYYMMDD</code>…
                  </p>
                  <p>Zoom: Ctrl + rueda, botones +/− o la barra. Arrastra las barras para desplazarte.</p>
                  <p>
                    <strong>Descargar:</strong> mosaico JPEG con la polarización y paleta actuales.
                  </p>
                </>
              ) : null}
              {galleryHelpKey === "s1vh" ? (
                <>
                  <p>
                    Amplitud (sigma0 en dB o lineal según el GeoTIFF) de la banda VH; estiramiento para
                    visualización.
                  </p>
                  <p>Zoom: Ctrl + rueda, botones +/− o la barra. Arrastra las barras para desplazarte.</p>
                  <p>
                    <strong>Descargar:</strong> mosaico JPEG a resolución nativa de las miniaturas.
                  </p>
                </>
              ) : null}
              {galleryHelpKey === "s1grdIdx" ? (
                <>
                  <p>
                    Cociente VH/VV en escala lineal (desde sigma0 dB del recorte GRD IW), normalizado y con paleta{" "}
                    <strong>RdYlGn</strong>. Banda 1 = VV, banda 2 = VH.
                  </p>
                  <p>Zoom: Ctrl + rueda, botones +/− o la barra. Arrastra las barras para desplazarte.</p>
                  <p>
                    <strong>Descargar:</strong> mosaico JPEG a resolución nativa de las miniaturas.
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
