import { useEffect, useRef, useState } from "react";
import api from "../api";
import RgbTimeSeriesGallery from "./RgbTimeSeriesGallery";

/** Opciones de índice (sin TODOS en el payload; TODOS solo UI). */
export const INDEX_CATALOG = [
  {
    id: "TODOS",
    label: "TODOS",
    description:
      "Marca automáticamente NDVI, EVI, NDWI, CIre y MCARI para generar todos los stacks en un solo proceso.",
  },
  {
    id: "NDVI",
    label: "NDVI",
    description:
      "Índice de vegetación de diferencia normalizada (estimación de verdor). NDVI = (B8 − B4) / (B8 + B4).",
  },
  {
    id: "EVI",
    label: "EVI",
    description:
      "Índice mejorado; reduce efectos atmosféricos y del suelo. Fórmula Sentinel-2 con B2, B4, B8.",
  },
  {
    id: "NDWI",
    label: "NDWI",
    description:
      "Estima contenido de agua en el dosel. NDWI = (B8 − B11) / (B8 + B11).",
  },
  {
    id: "CIre",
    label: "CIre",
    description:
      "Relacionado con contenido de clorofila (red-edge). CIre = (B8 / B5) − 1.",
  },
  {
    id: "MCARI",
    label: "MCARI",
    description:
      "Sensible a absorción de clorofila con corrección de suelo. Fórmula con B3, B4, B5.",
  },
];

const INDEX_IDS = ["NDVI", "EVI", "NDWI", "CIre", "MCARI"];

function stackModeOpensGallery(mode) {
  return mode === "visual-rgb" || mode === "visual-index";
}

export default function PreprocessPanel({
  token,
  projectId,
  loading,
  stackMode,
  setStackMode,
  mapLayers,
  recortePipelineBusy,
  indexStacksBusy,
  selectedIndices,
  setSelectedIndices,
  onFetchS2Inventory,
  onS2L2aRecortes,
  onS2IndexStacks,
  onStack,
  clusterElbowLoading,
  clusterGmmLoading,
  clusterElbowResults,
  clusterGmmResults,
  onClusterElbow,
  onClusterGmm,
}) {
  const [recorteLayerId, setRecorteLayerId] = useState("");
  const [clusterModalOpen, setClusterModalOpen] = useState(false);
  const [clusterResultsModalOpen, setClusterResultsModalOpen] = useState(false);
  const [clusterApiBuild, setClusterApiBuild] = useState("");
  const [clusterFlowZoom, setClusterFlowZoom] = useState(100);
  const [clusterResultsZoom, setClusterResultsZoom] = useState(100);
  const [kByKey, setKByKey] = useState({});
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryMode, setGalleryMode] = useState("view");
  const [infoKey, setInfoKey] = useState(null);
  const [indicesDropdownOpen, setIndicesDropdownOpen] = useState(false);
  const indicesDropdownRef = useRef(null);
  const vectorLayers = mapLayers.filter((l) => l.kind === "vector");
  const hasVectors = vectorLayers.length > 0;
  const busy = loading || recortePipelineBusy || indexStacksBusy;

  useEffect(() => {
    const ds = clusterElbowResults?.datasets;
    if (!ds?.length) return;
    const next = {};
    ds.forEach((d) => {
      next[d.key] = d.suggested_k;
    });
    setKByKey(next);
  }, [clusterElbowResults]);

  useEffect(() => {
    setClusterModalOpen(false);
    setClusterResultsModalOpen(false);
    setClusterFlowZoom(100);
    setClusterResultsZoom(100);
  }, [projectId]);

  useEffect(() => {
    if (!clusterModalOpen) return;
    api
      .get("/cluster-analysis/capabilities")
      .then((res) => setClusterApiBuild(res.data?.build ?? ""))
      .catch(() => setClusterApiBuild("(no se pudo leer el API)"));
  }, [clusterModalOpen]);

  useEffect(() => {
    const n = clusterGmmResults?.results?.length ?? 0;
    if (n > 0) {
      setClusterResultsModalOpen(true);
      setClusterModalOpen(false);
    } else {
      setClusterResultsModalOpen(false);
    }
  }, [clusterGmmResults]);

  const allMainSelected =
    INDEX_IDS.length > 0 && INDEX_IDS.every((id) => selectedIndices.includes(id));

  const gmmIndexResults =
    clusterGmmResults?.results?.filter((r) => r.kind === "index") ?? [];
  const gmmMultibandResults =
    clusterGmmResults?.results?.filter((r) => r.kind === "multiband") ?? [];

  function toggleTodos() {
    if (allMainSelected) {
      setSelectedIndices([]);
    } else {
      setSelectedIndices([...INDEX_IDS]);
    }
  }

  function toggleIndex(id) {
    if (id === "TODOS") {
      toggleTodos();
      return;
    }
    setSelectedIndices((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  }

  const infoEntry = infoKey ? INDEX_CATALOG.find((x) => x.id === infoKey) : null;

  useEffect(() => {
    if (!indicesDropdownOpen) return undefined;
    function onDocMouseDown(e) {
      if (indicesDropdownRef.current && !indicesDropdownRef.current.contains(e.target)) {
        setIndicesDropdownOpen(false);
      }
    }
    function onKey(e) {
      if (e.key === "Escape") setIndicesDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [indicesDropdownOpen]);

  let indicesSummary = "Selecciona índices…";
  if (allMainSelected) {
    indicesSummary = "TODOS (NDVI, EVI, NDWI, CIre, MCARI)";
  } else if (selectedIndices.length > 0) {
    indicesSummary = selectedIndices.join(", ");
  }

  return (
    <>
      <p className="prepro-hint">
        <strong>1) Sentinel-2 L2A en descargas:</strong> lista los ZIP/carpetas .SAFE, apila B02,B03,B04,B05
        (10 m),B08,B11 (10 m) en un solo GeoTIFF, recorta al lote, guarda en{" "}
        <code>recortes/</code> (raíz de recortes del proyecto). El mapa usa color
        natural R=B04, G=B03, B=B02.
      </p>

      <label>
        Polígono para recorte (opcional)
        <select
          value={recorteLayerId}
          onChange={(e) => setRecorteLayerId(e.target.value)}
          disabled={busy}
        >
          <option value="">Todos los lotes del proyecto (unión)</option>
          {vectorLayers
            .filter((l) => l.serverId != null && Number.isFinite(Number(l.serverId)))
            .map((l) => (
              <option key={l.id} value={String(l.serverId)}>
                {l.name}
              </option>
            ))}
        </select>
      </label>

      <button
        type="button"
        onClick={() => onFetchS2Inventory?.()}
        disabled={busy || !projectId || !token}
      >
        Listar archivos L2A en descargas
      </button>
      <button
        type="button"
        onClick={() =>
          onS2L2aRecortes?.(recorteLayerId ? Number(recorteLayerId) : undefined)
        }
        disabled={busy || !projectId || !token || !hasVectors}
        title={!hasVectors ? "Carga un lote vectorial en la pestaña Cargar" : undefined}
      >
        Procesar recortes L2A (6 bandas + polígono + capa)
      </button>

      <label>
        2) Visualización
        <select
          value={stackMode}
          onChange={(e) => setStackMode(e.target.value)}
        >
          <option value="visualizar">Visualizar (lista stack)</option>
          <option value="gif">Gif</option>
          <option value="visual-rgb">Visual RGB (serie temporal)</option>
          <option value="visual-index">Visual índices (serie temporal)</option>
        </select>
      </label>
      {stackModeOpensGallery(stackMode) ? (
        <button
          type="button"
          onClick={() => {
            setGalleryMode("view");
            setGalleryOpen(true);
          }}
          disabled={!projectId || !token}
        >
          {stackMode === "visual-rgb"
            ? "Abrir galería RGB (serie temporal)"
            : "Abrir galería de índices (serie temporal)"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onStack}
          disabled={loading || !projectId || !token}
        >
          Procesar stack
        </button>
      )}

      <div className="indices-section">
        <div className="indices-section-title">
          <strong>3) Índices (Sentinel-2)</strong>
          <span className="indices-section-hint">
            Desde recortes L2A (6 bandas): stacks en <code>indices/&lt;INDICE&gt;/</code>, una banda por
            fecha.
          </span>
        </div>

        <div className="indices-dropdown-wrap" ref={indicesDropdownRef}>
          <button
            type="button"
            className="indices-dropdown-trigger"
            aria-expanded={indicesDropdownOpen}
            aria-haspopup="listbox"
            disabled={busy || !projectId || !token}
            onClick={() => setIndicesDropdownOpen((o) => !o)}
          >
            <span className="indices-dropdown-summary">{indicesSummary}</span>
            <span className="indices-dropdown-caret" aria-hidden>
              {indicesDropdownOpen ? "▲" : "▼"}
            </span>
          </button>
          {indicesDropdownOpen ? (
            <div
              className="indices-dropdown-panel"
              role="listbox"
              aria-label="Índices de vegetación"
            >
              {INDEX_CATALOG.map((opt) => (
                <label key={opt.id} className="indices-row">
                  <input
                    type="checkbox"
                    checked={
                      opt.id === "TODOS" ? allMainSelected : selectedIndices.includes(opt.id)
                    }
                    onChange={() => toggleIndex(opt.id)}
                    disabled={busy || !projectId || !token}
                  />
                  <span className="indices-label">{opt.label}</span>
                  <button
                    type="button"
                    className="indices-info-btn"
                    title="Descripción técnica"
                    aria-label={`Información sobre ${opt.label}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIndicesDropdownOpen(false);
                      setInfoKey(opt.id);
                    }}
                  >
                    i
                  </button>
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="indices-run-btn"
          onClick={() => {
            setGalleryMode("indexSelect");
            setGalleryOpen(true);
          }}
          disabled={busy || !projectId || !token}
        >
          Seleccionar escenas e estimar índices
        </button>
      </div>

      {infoEntry && (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="index-modal-title"
          onClick={() => setInfoKey(null)}
        >
          <div className="index-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="index-modal-title">{infoEntry.label}</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setInfoKey(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <p className="index-modal-body">{infoEntry.description}</p>
          </div>
        </div>
      )}

      <div className="cluster-actions-row">
        <button
          type="button"
          onClick={() => setClusterModalOpen(true)}
          disabled={busy || !projectId || !token}
        >
          4) Cluster
        </button>
        {clusterGmmResults?.results?.length ? (
          <button
            type="button"
            className="cluster-open-results-btn"
            onClick={() => setClusterResultsModalOpen(true)}
          >
            Ver resultados GMM
          </button>
        ) : null}
      </div>

      {clusterModalOpen ? (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cluster-modal-title"
          onClick={() => setClusterModalOpen(false)}
        >
          <div className="index-modal cluster-flow-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header cluster-modal-header-tools">
              <div>
                <h3 id="cluster-modal-title">4) Cluster (codo + GMM)</h3>
                {clusterApiBuild ? (
                  <p className="cluster-api-build">API: {clusterApiBuild}</p>
                ) : null}
              </div>
              <div
                className="cluster-zoom-toolbar"
                onClick={(e) => e.stopPropagation()}
                role="group"
                aria-label="Zoom del contenido"
              >
                <span className="cluster-zoom-label">Zoom</span>
                <button
                  type="button"
                  className="cluster-zoom-btn"
                  aria-label="Reducir zoom"
                  onClick={() => setClusterFlowZoom((z) => Math.max(50, z - 10))}
                >
                  −
                </button>
                <input
                  className="cluster-zoom-range"
                  type="range"
                  min={50}
                  max={200}
                  step={5}
                  value={clusterFlowZoom}
                  onChange={(e) => setClusterFlowZoom(Number(e.target.value))}
                />
                <span className="cluster-zoom-pct">{clusterFlowZoom}%</span>
                <button
                  type="button"
                  className="cluster-zoom-btn"
                  aria-label="Aumentar zoom"
                  onClick={() => setClusterFlowZoom((z) => Math.min(200, z + 10))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="cluster-zoom-reset"
                  onClick={() => setClusterFlowZoom(100)}
                >
                  100%
                </button>
              </div>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setClusterModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div
              className="index-modal-body cluster-flow-body cluster-zoom-inner"
              style={{ zoom: clusterFlowZoom / 100 }}
            >
              <p className="cluster-flow-intro">
                Se analiza cada stack de índices (NDVI, EVI, …) y{" "}
                <strong>todos</strong> los GeoTIFF con ≥6 bandas en <code>recortes/</code>. Primero
                el método del codo (KMeans) en una sola fila; luego GMM con la K que elijas. Los
                mapas de salida se abren en otra ventana al terminar.
              </p>
              <div className="cluster-flow-actions">
                <button
                  type="button"
                  className="indices-run-btn"
                  onClick={() => onClusterElbow?.()}
                  disabled={clusterElbowLoading || !projectId || !token}
                >
                  {clusterElbowLoading ? "Calculando codo…" : "Calcular método del codo"}
                </button>
                <button
                  type="button"
                  className="indices-run-btn"
                  onClick={async () => {
                    if (!onClusterGmm) return;
                    await onClusterGmm(kByKey);
                  }}
                  disabled={
                    clusterGmmLoading ||
                    !clusterElbowResults?.datasets?.length ||
                    !Object.keys(kByKey).length
                  }
                >
                  {clusterGmmLoading ? "Ejecutando GMM…" : "Ejecutar GMM"}
                </button>
              </div>

              {clusterElbowResults?.datasets?.length ? (
                <div className="cluster-elbow-row">
                  {clusterElbowResults.datasets.map((d) => (
                    <div key={d.key} className="cluster-elbow-cell">
                      <h4>{d.label}</h4>
                      {d.elbow_plot_png_base64 ? (
                        <img
                          className="cluster-elbow-img"
                          alt={`Codo ${d.key}`}
                          src={`data:image/png;base64,${d.elbow_plot_png_base64}`}
                        />
                      ) : null}
                      <label className="cluster-k-label">
                        K sugerido {d.suggested_k} → ajustar:{" "}
                        <input
                          type="number"
                          min={1}
                          max={30}
                          value={kByKey[d.key] ?? d.suggested_k}
                          onChange={(e) =>
                            setKByKey((prev) => ({
                              ...prev,
                              [d.key]: Number(e.target.value) || 1,
                            }))
                          }
                        />
                      </label>
                      <p className="cluster-meta">
                        Train: {d.n_train_pixels} px · {d.n_features} feat.
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {clusterResultsModalOpen && clusterGmmResults?.results?.length ? (
        <div
          className="cluster-results-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cluster-results-title"
          onClick={() => setClusterResultsModalOpen(false)}
        >
          <div className="cluster-results-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header cluster-modal-header-tools">
              <h3 id="cluster-results-title">Resultados — clusters GMM</h3>
              <div
                className="cluster-zoom-toolbar"
                onClick={(e) => e.stopPropagation()}
                role="group"
                aria-label="Zoom de las vistas"
              >
                <span className="cluster-zoom-label">Zoom</span>
                <button
                  type="button"
                  className="cluster-zoom-btn"
                  aria-label="Reducir zoom"
                  onClick={() => setClusterResultsZoom((z) => Math.max(50, z - 10))}
                >
                  −
                </button>
                <input
                  className="cluster-zoom-range"
                  type="range"
                  min={50}
                  max={200}
                  step={5}
                  value={clusterResultsZoom}
                  onChange={(e) => setClusterResultsZoom(Number(e.target.value))}
                />
                <span className="cluster-zoom-pct">{clusterResultsZoom}%</span>
                <button
                  type="button"
                  className="cluster-zoom-btn"
                  aria-label="Aumentar zoom"
                  onClick={() => setClusterResultsZoom((z) => Math.min(200, z + 10))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="cluster-zoom-reset"
                  onClick={() => setClusterResultsZoom(100)}
                >
                  100%
                </button>
              </div>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setClusterResultsModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body cluster-results-body">
              {clusterGmmResults.pipeline_build ? (
                <p className="cluster-meta cluster-pipeline-build">
                  Pipeline: <code>{clusterGmmResults.pipeline_build}</code>
                </p>
              ) : null}
              {typeof clusterGmmResults.cluster_gmm_cleared_count === "number" ? (
                <p className="cluster-meta">
                  Archivos eliminados en carpeta cluster antes de escribir:{" "}
                  <strong>{clusterGmmResults.cluster_gmm_cleared_count}</strong>
                </p>
              ) : null}
              {clusterGmmResults.cluster_gmm_absolute_path ? (
                <p className="cluster-meta">
                  Carpeta de salida (contenedor/host según volumen):{" "}
                  <code>{clusterGmmResults.cluster_gmm_absolute_path}</code>
                </p>
              ) : null}

              <div
                className="cluster-results-zoom-inner"
                style={{ zoom: clusterResultsZoom / 100 }}
              >
              {gmmIndexResults.length ? (
                <>
                  <h4 className="cluster-results-section-title">Índices espectrales</h4>
                  <div className="cluster-gmm-grid cluster-gmm-grid--row1">
                    {gmmIndexResults.map((r) => (
                      <div key={r.key} className="cluster-gmm-tile">
                        <h5 className="cluster-gmm-tile-title">
                          <code>{r.output_basename ?? r.key}</code>
                          <span className="cluster-gmm-k"> · K={r.k_used ?? "—"}</span>
                        </h5>
                        <p className="cluster-meta">{r.label}</p>
                        {r.preview_png_base64 ? (
                          <img
                            className="cluster-elbow-img"
                            alt={`Clusters ${r.key}`}
                            src={`data:image/png;base64,${r.preview_png_base64}`}
                          />
                        ) : null}
                        {typeof r.labeled_fraction === "number" ? (
                          <p className="cluster-meta">
                            Píxeles con cluster: {(r.labeled_fraction * 100).toFixed(1)}% del área
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              {gmmMultibandResults.length ? (
                <>
                  <h4 className="cluster-results-section-title">Recortes multibanda (6+ bandas)</h4>
                  <div className="cluster-gmm-grid">
                    {gmmMultibandResults.map((r) => (
                      <div key={r.key} className="cluster-gmm-tile">
                        <h5 className="cluster-gmm-tile-title">
                          <code>{r.output_basename ?? r.key}</code>
                          <span className="cluster-gmm-k"> · K={r.k_used ?? "—"}</span>
                        </h5>
                        {r.preview_png_base64 ? (
                          <img
                            className="cluster-elbow-img"
                            alt={`Clusters ${r.key}`}
                            src={`data:image/png;base64,${r.preview_png_base64}`}
                          />
                        ) : null}
                        {typeof r.labeled_fraction === "number" ? (
                          <p className="cluster-meta">
                            Píxeles con cluster: {(r.labeled_fraction * 100).toFixed(1)}% del área
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}

              <p className="cluster-out-dir">
                Salidas GeoTIFF: <code>{clusterGmmResults.output_dir}</code>
              </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <RgbTimeSeriesGallery
        open={galleryOpen}
        mode={galleryMode}
        galleryVisualMode={
          galleryMode === "view" && stackMode === "visual-index" ? "index" : "rgb"
        }
        onClose={() => setGalleryOpen(false)}
        canEstimate={selectedIndices.length > 0}
        onEstimateIndices={(ids) => {
          onS2IndexStacks?.(ids);
          setGalleryOpen(false);
        }}
        projectId={projectId}
        token={token}
      />
    </>
  );
}
