import { useCallback, useEffect, useState } from "react";
import api, { formatApiErrorDetail, setAuthToken } from "../api";
import RgbTimeSeriesGallery from "./RgbTimeSeriesGallery";
import { INDEX_CATALOG, INDEX_CATALOG_PS } from "./PreprocessPanel";

function stackModeToGalleryVisualMode(stackMode) {
  if (stackMode === "visual-index") return "index";
  if (stackMode === "visual-s1-sar-indices") return "s1-sar-index";
  if (stackMode === "visual-s1-vv") return "s1-vv";
  return "rgb";
}

function s1OpenButtonLabel(mode) {
  if (mode === "visual-s1-vv") return "Abrir galería VV/VH";
  if (mode === "visual-s1-sar-indices") return "Abrir galería de índices SAR (serie temporal)";
  return "Abrir visualización de clusters GMM";
}

function s2PsOpenButtonLabel(mode) {
  if (mode === "visual-rgb") return "Abrir galería RGB (serie temporal)";
  if (mode === "visual-index") return "Abrir galería de índices (serie temporal)";
  return "Abrir visualización de clusters GMM";
}

function pipelineVariantForCluster(sensor) {
  if (sensor === "ps") return "ps";
  if (sensor === "s1") return "s1";
  return "s2";
}

function isoDateFromClusterResult(row) {
  const haystack = [
    row?.output_basename,
    row?.source_basename,
    row?.label,
    row?.key,
  ]
    .filter(Boolean)
    .join(" ");
  const isoLike = haystack.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (isoLike) {
    const [, y, m, d] = isoLike;
    return `${y}-${m}-${d}`;
  }
  const shortLike = haystack.match(/(\d{2})[-/](\d{2})[-/](\d{2})/);
  if (shortLike) {
    const [, d, m, yy] = shortLike;
    return `20${yy}-${m}-${d}`;
  }
  return null;
}

function formatIsoToDdMmYyyy(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function clusterMultibandTitle(row, sensor) {
  const base = row?.output_basename ?? row?.key ?? "—";
  if (sensor !== "s2") return base;
  const iso = isoDateFromClusterResult(row);
  const ddmmyyyy = formatIsoToDdMmYyyy(iso);
  return ddmmyyyy ? `${base} · ${ddmmyyyy}` : base;
}

function sortClusterResultsByDate(rows) {
  return [...rows].sort((a, b) => {
    const da = isoDateFromClusterResult(a);
    const db = isoDateFromClusterResult(b);
    if (da && db) {
      const c = da.localeCompare(db);
      if (c !== 0) return c;
    } else if (da) {
      return -1;
    } else if (db) {
      return 1;
    }
    return String(a?.output_basename || a?.key || "").localeCompare(
      String(b?.output_basename || b?.key || "")
    );
  });
}

export default function ClientVisualizationModal({
  open,
  onClose,
  token,
  projectId,
  projectName = "",
  onStatusMessage,
}) {
  const [s1Mode, setS1Mode] = useState("visual-s1-vv");
  const [s2Mode, setS2Mode] = useState("visual-rgb");
  const [psMode, setPsMode] = useState("visual-rgb");

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryVisualMode, setGalleryVisualMode] = useState("rgb");
  const [galleryPipelineVariant, setGalleryPipelineVariant] = useState("s2");

  const [clusterOpen, setClusterOpen] = useState(false);
  const [clusterLoading, setClusterLoading] = useState(false);
  const [clusterData, setClusterData] = useState(null);
  const [clusterError, setClusterError] = useState("");
  const [clusterZoom, setClusterZoom] = useState(100);
  const [clusterSensor, setClusterSensor] = useState("s2");

  const notify = useCallback(
    (msg) => {
      if (onStatusMessage) onStatusMessage(msg);
    },
    [onStatusMessage]
  );

  useEffect(() => {
    if (!open) {
      setGalleryOpen(false);
      setClusterOpen(false);
      setClusterData(null);
      setClusterError("");
    }
  }, [open]);

  async function openClusterVisualization(sensor) {
    if (!token || !projectId) {
      notify("Seleccione un proyecto.");
      return;
    }
    const pv = pipelineVariantForCluster(sensor);
    setClusterSensor(sensor);
    setClusterLoading(true);
    setClusterError("");
    setClusterData(null);
    try {
      setAuthToken(token);
      const res = await api.get(
        `/cluster-analysis/gmm-results/${projectId}?pipeline_variant=${encodeURIComponent(pv)}`
      );
      const data = res.data;
      if (data?.results?.length) {
        setClusterOpen(true);
        setClusterData(data);
      } else {
        const dir =
          pv === "ps" ? "ClusterPS" : pv === "s1" ? "cluster_s1_gmm" : "cluster_gmm";
        notify(`No se encontraron resultados GMM en ${dir}/ para este proyecto.`);
      }
    } catch (e) {
      setClusterError(formatApiErrorDetail(e));
      setClusterOpen(true);
    } finally {
      setClusterLoading(false);
    }
  }

  function handleOpenColumn(sensor) {
    const mode = sensor === "s1" ? s1Mode : sensor === "s2" ? s2Mode : psMode;
    if (mode === "visual-cluster") {
      void openClusterVisualization(sensor);
      return;
    }
    setGalleryPipelineVariant(sensor === "ps" ? "ps" : "s2");
    setGalleryVisualMode(stackModeToGalleryVisualMode(mode));
    setGalleryOpen(true);
  }

  const gmmIndexResults =
    clusterData?.results?.filter((r) => r.kind === "index") ?? [];
  const gmmMultibandResultsRaw =
    clusterData?.results?.filter((r) => r.kind === "multiband") ?? [];
  const gmmMultibandResults =
    clusterSensor === "s2" ? sortClusterResultsByDate(gmmMultibandResultsRaw) : gmmMultibandResultsRaw;

  /**
   * Mientras una galería o el visor de clusters está abierto ocultamos el diálogo
   * principal de «Visualización» y, al cerrar la galería/cluster, llamamos a
   * `onClose` externo. Así el usuario regresa directamente al dashboard sin pasar
   * de nuevo por esta modal.
   */
  const viewerActive = galleryOpen || clusterOpen;
  if (!open && !viewerActive) return null;

  const closeGalleryAndModal = () => {
    setGalleryOpen(false);
    onClose?.();
  };

  const closeClusterAndModal = () => {
    setClusterOpen(false);
    setClusterData(null);
    setClusterError("");
    onClose?.();
  };

  return (
    <>
      {open && !viewerActive ? (
      <div
        className="client-viz-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-viz-title"
        onClick={onClose}
      >
        <div className="client-viz-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="client-viz-header">
            <h2 id="client-viz-title">Visualización</h2>
            <button type="button" className="index-modal-close" onClick={onClose} aria-label="Cerrar">
              ×
            </button>
          </div>
          <div className="client-viz-columns">
            <div className="client-viz-col">
              <h3 className="client-viz-col-title">Sentinel 1</h3>
              <label className="client-viz-label">
                <span className="client-viz-label-text">2) Visualización</span>
                <select
                  className="client-viz-select"
                  value={s1Mode}
                  onChange={(e) => setS1Mode(e.target.value)}
                >
                  <option value="visual-s1-vv">Visual VV/VH</option>
                  <option value="visual-s1-sar-indices">Visual índices SAR (serie temporal)</option>
                  <option value="visual-cluster">Visual cluster</option>
                </select>
              </label>
              <button
                type="button"
                className="layers-dashboard-btn client-viz-open-btn"
                disabled={!projectId || !token || clusterLoading}
                onClick={() => handleOpenColumn("s1")}
              >
                {s1OpenButtonLabel(s1Mode)}
              </button>
            </div>
            <div className="client-viz-col">
              <h3 className="client-viz-col-title">Sentinel 2</h3>
              <label className="client-viz-label">
                <span className="client-viz-label-text">2) Visualización</span>
                <select
                  className="client-viz-select"
                  value={s2Mode}
                  onChange={(e) => setS2Mode(e.target.value)}
                >
                  <option value="visual-rgb">Visual RGB (serie temporal)</option>
                  <option value="visual-index">Visual índices (serie temporal)</option>
                  <option value="visual-cluster">Visual cluster</option>
                </select>
              </label>
              <button
                type="button"
                className="layers-dashboard-btn client-viz-open-btn"
                disabled={!projectId || !token || clusterLoading}
                onClick={() => handleOpenColumn("s2")}
              >
                {s2PsOpenButtonLabel(s2Mode)}
              </button>
            </div>
            <div className="client-viz-col">
              <h3 className="client-viz-col-title">Alta resolución</h3>
              <label className="client-viz-label">
                <span className="client-viz-label-text">2) Visualización</span>
                <select
                  className="client-viz-select"
                  value={psMode}
                  onChange={(e) => setPsMode(e.target.value)}
                >
                  <option value="visual-rgb">Visual RGB (serie temporal)</option>
                  <option value="visual-index">Visual índices (serie temporal)</option>
                  <option value="visual-cluster">Visual cluster</option>
                </select>
              </label>
              <button
                type="button"
                className="layers-dashboard-btn client-viz-open-btn"
                disabled={!projectId || !token || clusterLoading}
                onClick={() => handleOpenColumn("ps")}
              >
                {s2PsOpenButtonLabel(psMode)}
              </button>
            </div>
          </div>
        </div>
      </div>
      ) : null}

      <RgbTimeSeriesGallery
        open={galleryOpen}
        mode="view"
        galleryVisualMode={galleryVisualMode}
        indexCatalog={galleryPipelineVariant === "ps" ? INDEX_CATALOG_PS : INDEX_CATALOG}
        selectedIndices={[]}
        onSelectedIndicesChange={() => {}}
        onClose={closeGalleryAndModal}
        canEstimate={false}
        onEstimateIndices={undefined}
        projectId={projectId}
        token={token}
        pipelineVariant={galleryPipelineVariant}
        projectName={projectName}
      />

      {clusterOpen ? (
        <div
          className="cluster-results-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="client-cluster-results-title"
          onClick={closeClusterAndModal}
        >
          <div className="cluster-results-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header cluster-modal-header-tools cluster-results-modal-header">
              <h3 id="client-cluster-results-title">
                Resultados — clusters GMM
                {clusterSensor === "s1"
                  ? " (Sentinel-1)"
                  : clusterSensor === "ps"
                    ? " (Alta resolución)"
                    : " (Sentinel-2)"}
              </h3>
              {clusterData?.results?.length ? (
                <div
                  className="cluster-zoom-toolbar cluster-zoom-toolbar--single-line"
                  onClick={(e) => e.stopPropagation()}
                  role="group"
                  aria-label="Zoom de las vistas"
                >
                  <span className="cluster-zoom-label">Zoom</span>
                  <button
                    type="button"
                    className="cluster-zoom-btn"
                    aria-label="Reducir zoom"
                    onClick={() => setClusterZoom((z) => Math.max(50, z - 10))}
                  >
                    −
                  </button>
                  <input
                    className="cluster-zoom-range"
                    type="range"
                    min={50}
                    max={200}
                    step={5}
                    value={clusterZoom}
                    onChange={(e) => setClusterZoom(Number(e.target.value))}
                  />
                  <span className="cluster-zoom-pct">{clusterZoom}%</span>
                  <button
                    type="button"
                    className="cluster-zoom-btn"
                    aria-label="Aumentar zoom"
                    onClick={() => setClusterZoom((z) => Math.min(200, z + 10))}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="cluster-zoom-reset"
                    onClick={() => setClusterZoom(100)}
                  >
                    100%
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className="index-modal-close"
                onClick={closeClusterAndModal}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body cluster-results-body">
              {clusterError ? (
                <p className="rgb-gallery-error" role="alert">
                  {clusterError}
                </p>
              ) : null}
              {clusterData?.results?.length ? (
                <>
                  {clusterData.pipeline_build ? (
                    <p className="cluster-meta cluster-pipeline-build">
                      Pipeline: <code>{clusterData.pipeline_build}</code>
                    </p>
                  ) : null}
                  <div
                    className="cluster-results-zoom-inner"
                    style={{ zoom: clusterZoom / 100 }}
                  >
                    {gmmIndexResults.length ? (
                      <>
                        <h4 className="cluster-results-section-title">Índices espectrales</h4>
                        <div className="cluster-gmm-grid cluster-gmm-grid--row1">
                          {gmmIndexResults.map((r) => (
                            <div key={r.key} className="cluster-gmm-tile">
                              <h5 className="cluster-gmm-tile-title">
                                <code>{clusterMultibandTitle(r, clusterSensor)}</code>
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
                        <h4 className="cluster-results-section-title">
                          {clusterSensor === "s2"
                            ? "Recortes multibanda (4 bandas originales)"
                            : "Recortes multibanda (6+ bandas)"}
                        </h4>
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
                      Salidas GeoTIFF: <code>{clusterData.output_dir}</code>
                    </p>
                  </div>
                </>
              ) : !clusterError ? (
                <p className="prepro-hint">Sin datos de resultados.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
