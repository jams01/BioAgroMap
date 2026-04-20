import { useEffect, useRef, useState } from "react";
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

const RECORTE_PREVIEW_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect fill="#2a2a2a" width="100%" height="100%"/><text x="50%" y="50%" fill="#999" font-size="12" text-anchor="middle" font-family="system-ui,sans-serif">Sin vista previa</text></svg>'
  );

/** Miniaturas a pedir: una por banda/fecha en stacks de índice; una por capa en RGB. */
function previewSpecsForRaster(r) {
  const m = r.metadata || {};
  const n = m.index_stack_band_count;
  const dates = m.index_band_dates;
  if (m.s2_index_stack && typeof n === "number" && n >= 1 && Array.isArray(dates) && dates.length >= n) {
    return Array.from({ length: n }, (_, i) => ({
      band: i + 1,
      labelSuffix: formatIsoDateDdMmYyyy(dates[i]),
    }));
  }
  if (m.s2_index_stack && typeof n === "number" && n >= 1) {
    return Array.from({ length: n }, (_, i) => ({
      band: i + 1,
      labelSuffix: `banda ${i + 1}`,
    }));
  }
  return [{ band: null, labelSuffix: null }];
}

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.1;

/** Orden de índices en la galería (mismo que estimación). */
const GALLERY_INDEX_KEYS = ["NDVI", "EVI", "NDWI", "CIre", "MCARI"];

/**
 * @param {"view" | "indexSelect" | "timeSeriesSelect"} mode - view: galería; indexSelect: escenas → índices; timeSeriesSelect: escenas → series de tiempo
 * @param {"rgb" | "index"} [galleryVisualMode] - view: RGB L2A vs stacks de índice (pestañas NDVI…)
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
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [activeIndexKey, setActiveIndexKey] = useState("NDVI");
  const [indexInfoKey, setIndexInfoKey] = useState(null);
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
  const showIndexSwitcher = !indexMode && galleryVisualMode === "index";

  useEffect(() => {
    if (open) setZoom(1);
    if (open && indexMode) setSelectedIds(new Set());
  }, [open, indexMode]);

  useEffect(() => {
    if (!open) {
      setActiveIndexKey("NDVI");
    }
  }, [open]);

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
          const invRes = await api.get(`/preprocess/recortes-inventory/${projectId}`);
          if (cancelled) return;
          const rows = invRes.data?.items || [];
          for (const row of rows) {
            if (cancelled) break;
            const basename = row.basename;
            const rel = row.relative_path || basename;
            if (!rel) continue;
            const rid = row.raster_layer_id;
            const sk = row.sort_key || "";
            const url = rid
              ? `${base}/raster/${projectId}/${rid}/preview?v=${rid}`
              : `${base}/preprocess/recortes-preview/${projectId}?path=${encodeURIComponent(rel)}`;
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
        } else if (mode === "view" && galleryVisualMode === "index") {
          const invRes = await api.get(`/preprocess/index-stacks-inventory/${projectId}`);
          if (cancelled) return;
          const allRows = invRes.data?.items || [];
          const normIdx = (k) => String(k || "").toUpperCase();
          const ak = normIdx(activeIndexKey);
          const rows = allRows.filter((row) => normIdx(row.index_key) === ak);
          for (const row of rows) {
            if (cancelled) break;
            const nb = Number(row.bands);
            const dates = Array.isArray(row.band_dates) ? row.band_dates : [];
            const specs =
              Number.isFinite(nb) && nb >= 1
                ? Array.from({ length: nb }, (_, i) => {
                    const d = dates[i];
                    let labelSuffix = `banda ${i + 1}`;
                    if (typeof d === "string" && d.length >= 10) {
                      labelSuffix = formatIsoDateDdMmYyyy(d.slice(0, 10));
                    }
                    return { band: i + 1, labelSuffix };
                  })
                : [{ band: 1, labelSuffix: "" }];
            const idxName = row.index_key || activeIndexKey || "";
            for (const spec of specs) {
              if (cancelled) break;
              const bandQ = spec.band != null ? `&band=${spec.band}` : "";
              const url = `${base}/preprocess/index-stacks-preview/${projectId}?path=${encodeURIComponent(
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
        } else {
          const res = await api.get(`/raster/${projectId}`);
          if (cancelled) return;
          const raw = res.data || [];
          let rows;
          if (indexMode) {
            rows = filterSixBandStackRasters(raw);
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
                galleryVisualMode === "index" ? "&index_palette=1" : "";
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

        if (!cancelled) setItems(loaded);
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
  }, [open, projectId, token, mode, indexMode, galleryVisualMode, activeIndexKey]);

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

  function stepActiveIndex(delta) {
    setActiveIndexKey((prev) => {
      const i = GALLERY_INDEX_KEYS.indexOf(prev);
      const n = GALLERY_INDEX_KEYS.length;
      const start = i >= 0 ? i : 0;
      const j = (start + delta + n * 10) % n;
      return GALLERY_INDEX_KEYS[j];
    });
  }

  useEffect(() => {
    if (!open || !showIndexSwitcher) return undefined;
    function onKey(e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setActiveIndexKey((prev) => {
          const i = GALLERY_INDEX_KEYS.indexOf(prev);
          const n = GALLERY_INDEX_KEYS.length;
          const start = i >= 0 ? i : 0;
          const d = e.key === "ArrowLeft" ? -1 : 1;
          const j = (start + d + n * 10) % n;
          return GALLERY_INDEX_KEYS[j];
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, showIndexSwitcher]);

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
      ? "Escenas L2A (6 bandas) — series de tiempo"
      : mode === "indexSelect"
        ? "Escenas L2A (6 bandas) — selección para índices"
        : showIndexSwitcher
          ? "Visual índices — serie temporal"
          : "Visual RGB — serie temporal";

  const subtitle =
    mode === "timeSeriesSelect" ? (
      <>
        Pulsa cada miniatura para incluir o excluir escenas. Cuando termines, pulsa{" "}
        <strong>Series de tiempo</strong> para graficar NDVI, EVI, NDWI, CIre y MCARI (fechas en el eje X).
      </>
    ) : indexMode ? (
    <>
      Marca los <strong>índices</strong> (arriba) y las <strong>escenas</strong> (cada una corresponde a un
      GeoTIFF en <code>recortes/</code>). La estimación usa <strong>solo las escenas seleccionadas</strong>.
    </>
  ) : showIndexSwitcher ? (
    <>
      Elige el índice abajo. Paleta <strong>RdYlGn</strong> (rojo = bajo, verde = alto) para{" "}
      <strong>{activeIndexKey}</strong>. Una miniatura por fecha.{" "}
      <span className="rgb-gallery-zoom-hint">
        Zoom: se mantiene al cambiar de índice. Ctrl + rueda o barra. Flechas ← → entre índices.
      </span>
    </>
  ) : (
    <>
      Recortes con vista color natural (orden cronológico). Etiqueta: <code>dd/mm/aaaa_clip</code> (desde la
      fecha de la escena){" "}
      <span className="rgb-gallery-zoom-hint">
        Zoom: Ctrl + rueda, botones +/− o la barra. Arrastra las barras para desplazarte.
      </span>
    </>
  );

  const emptyMsg =
    mode === "indexSelect" || mode === "timeSeriesSelect"
      ? "No hay GeoTIFF L2A (6+ bandas) en la carpeta recortes/. Ejecuta el paso 1 (Procesar recortes L2A)."
      : indexMode
        ? "No hay capas de recorte L2A (6 bandas) en el proyecto. Ejecuta el paso 1 (Procesar recortes L2A)."
        : showIndexSwitcher
          ? `No hay stack de ${activeIndexKey} en disco (carpeta indices/${activeIndexKey}/). Usa el paso 3 (Estimar índices).`
          : "No hay capas raster con vista RGB en este proyecto. Procesa recortes L2A en el paso 1 o sube un GeoTIFF Sentinel-2.";

  const infoEntry =
    indexInfoKey && indexCatalog?.length
      ? indexCatalog.find((x) => x.id === indexInfoKey)
      : null;

  return (
    <div className="rgb-gallery-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="rgb-gallery-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="rgb-gallery-window">
        <div className="rgb-gallery-header">
          <h2 className="rgb-gallery-title">{title}</h2>
          <button type="button" className="rgb-gallery-close" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>
        <p className="rgb-gallery-sub">{subtitle}</p>
        {mode === "indexSelect" && indexCatalog?.length ? (
          <div
            className="rgb-gallery-index-picker"
            role="group"
            aria-label="Índices de vegetación a estimar"
          >
            <div className="rgb-gallery-index-picker-title">Índices a incluir en el stack</div>
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
          <div className="rgb-gallery-index-switcher" role="toolbar" aria-label="Índice a visualizar">
            <button
              type="button"
              className="rgb-gallery-index-nav"
              onClick={() => stepActiveIndex(-1)}
              aria-label="Índice anterior"
            >
              ← Anterior
            </button>
            <div className="rgb-gallery-index-tabs">
              {GALLERY_INDEX_KEYS.map((key) => (
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
                  {key}
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
            <div className="rgb-gallery-toolbar" aria-label="Controles de zoom">
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
                className="rgb-gallery-zoom-range"
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
            </div>
            {indexMode && (
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
                    const sel = indexMode && selectedIds.has(selId);
                    return (
                      <figure
                        key={it.id}
                        className={`rgb-gallery-cell${sel ? " rgb-gallery-cell--selected" : ""}${indexMode ? " rgb-gallery-cell--selectable" : ""}`}
                      >
                        <figcaption className="rgb-gallery-label">
                          {indexMode && (
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
                          role={indexMode ? "button" : undefined}
                          tabIndex={indexMode ? 0 : undefined}
                          onClick={
                            indexMode ? () => toggleSelect(selId) : undefined
                          }
                          onKeyDown={
                            indexMode
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
                          {indexMode && (
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
            {mode === "timeSeriesSelect" && (
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
                    selectedIds.size === 0 ? "Selecciona al menos una escena" : undefined
                  }
                >
                  Series de tiempo
                </button>
              </div>
            )}
          </>
        )}
        {mode === "indexSelect" && (
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
                    ? "Marca al menos un índice arriba (NDVI, EVI, …)"
                    : selectedIds.size === 0
                      ? "Selecciona al menos una escena (recorte L2A en recortes/)"
                      : undefined
              }
            >
              Estimar índice
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
    </div>
  );
}
