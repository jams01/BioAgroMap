import { useEffect, useRef, useState } from "react";
import api, { API_URL, setAuthToken } from "../api";
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
    if (m.source === "sentinel-2" && m.type === "download") return false;
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    if (m.composite_kind === "false_color_nir") return false;
    return (
      m.s2_l2a_recorte ||
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
    if (m.source === "sentinel-2" && m.type === "download") return false;
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    if (m.composite_kind === "false_color_nir") return false;
    return !!(m.s2_six_band_stack || m.s2_l2a_recorte);
  });
}

/** Stacks multibanda de un índice (capa registrada tras «Estimar índice»). */
function filterIndexVisualRasters(rows, indexKey) {
  if (!indexKey) return [];
  return rows.filter((r) => {
    const m = r.metadata || {};
    if (isLegacyS2ZipBandRaster(m)) return false;
    if (!m.bounds_wgs84) return false;
    return m.s2_index_stack === true && m.vegetation_index_key === indexKey;
  });
}

function formatIsoDateDdMmYyyy(iso) {
  if (typeof iso !== "string" || iso.length < 10) return iso || "";
  const [y, mo, d] = iso.split("-");
  if (!y || !mo || !d) return iso;
  return `${d.padStart(2, "0")}/${mo.padStart(2, "0")}/${y}`;
}

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
 * @param {"view" | "indexSelect"} mode - view: galería; indexSelect: elegir escenas y estimar índices
 * @param {"rgb" | "index"} [galleryVisualMode] - view: RGB L2A vs stacks de índice (pestañas NDVI…)
 */
export default function RgbTimeSeriesGallery({
  open,
  onClose,
  mode = "view",
  onEstimateIndices,
  canEstimate = true,
  galleryVisualMode = "rgb",
  projectId,
  token,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [activeIndexKey, setActiveIndexKey] = useState("NDVI");
  const blobUrlsRef = useRef([]);
  const scrollRef = useRef(null);

  const indexMode = mode === "indexSelect";
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
        const res = await api.get(`/raster/${projectId}`);
        if (cancelled) return;
        const raw = res.data || [];
        let rows;
        if (indexMode) {
          rows = filterSixBandStackRasters(raw);
        } else if (galleryVisualMode === "index" && activeIndexKey) {
          rows = filterIndexVisualRasters(raw, activeIndexKey);
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

        const base = API_URL.replace(/\/$/, "");
        const loaded = [];

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

        if (!cancelled) setItems(loaded);
      } catch (e) {
        if (!cancelled) {
          setError(e?.response?.data?.detail || e.message || "Error al cargar capas");
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
  }, [open, projectId, token, indexMode, galleryVisualMode, activeIndexKey]);

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
    setSelectedIds(new Set(items.map((it) => it.rasterLayerId ?? it.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function handleEstimate() {
    if (!onEstimateIndices || !canEstimate) return;
    const ids = [...selectedIds].sort((a, b) => a - b);
    if (ids.length === 0) return;
    onEstimateIndices(ids);
  }

  if (!open) return null;

  const title = indexMode
    ? "Escenas L2A (6 bandas) — selección para índices"
    : showIndexSwitcher
      ? "Visual índices — serie temporal"
      : "Visual RGB — serie temporal";

  const subtitle = indexMode ? (
    <>
      Pulsa cada miniatura para incluir o excluir la escena. Solo se listan capas con recorte L2A de 6
      bandas (mismo <code>.tif</code> que usa el backend). Luego pulsa <strong>Estimar índice</strong>.
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

  const emptyMsg = indexMode
    ? "No hay capas de recorte L2A (6 bandas) en el proyecto. Ejecuta el paso 1 (Procesar recortes L2A)."
    : showIndexSwitcher
      ? `No hay stack de ${activeIndexKey}. En el paso 3, selecciona escenas, marca ese índice y pulsa Estimar índice.`
      : "No hay capas raster con vista RGB en este proyecto. Procesa recortes L2A en el paso 1 o sube un GeoTIFF Sentinel-2.";

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
                    const sel = indexMode && selectedIds.has(it.rasterLayerId ?? it.id);
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
                              onChange={() => toggleSelect(it.rasterLayerId ?? it.id)}
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
                            indexMode ? () => toggleSelect(it.rasterLayerId ?? it.id) : undefined
                          }
                          onKeyDown={
                            indexMode
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleSelect(it.rasterLayerId ?? it.id);
                                  }
                                }
                              : undefined
                          }
                        >
                          <img
                            src={it.src}
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
            {indexMode && (
              <div className="rgb-gallery-footer-actions">
                <button type="button" className="rgb-gallery-btn-secondary" onClick={onClose}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="rgb-gallery-btn-primary"
                  onClick={handleEstimate}
                  disabled={
                    !canEstimate || selectedIds.size === 0 || !onEstimateIndices
                  }
                  title={
                    !canEstimate
                      ? "Elige al menos un índice (NDVI, EVI, …) en el panel Procesos"
                      : selectedIds.size === 0
                        ? "Selecciona al menos una escena"
                        : undefined
                  }
                >
                  Estimar índice
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
