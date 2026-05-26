import { useEffect, useState } from "react";
import api, { formatApiErrorDetail, setAuthToken } from "../api";
import RgbTimeSeriesGallery from "./RgbTimeSeriesGallery";
import VegetationTimeSeriesCharts from "./VegetationTimeSeriesCharts";

/** Catálogo índices SAR (sigma0 VV/VH lineal); claves = carpetas bajo ``s1indices/``. */
export const S1_SAR_INDEX_CATALOG = [
  {
    id: "TODOS",
    label: "TODOS",
    description: "Genera en un solo proceso los stacks RVI, RFDI, VV_VH, VH_VV y NRPB.",
  },
  {
    id: "RVI",
    label: "RVI",
    description: "Radar Vegetation Index: 4 × VH / (VH + VV) en potencia lineal (10^(dB/10)).",
  },
  {
    id: "RFDI",
    label: "RFDI",
    description: "Radar Forest Degradation Index: (VV − VH) / (VV + VH) en lineal.",
  },
  {
    id: "VV_VH",
    label: "VV/VH",
    description: "Cociente polarimétrico: VV / VH en lineal.",
  },
  {
    id: "VH_VV",
    label: "VH/VV",
    description: "Cociente polarimétrico: VH / VV en lineal.",
  },
  {
    id: "NRPB",
    label: "NRPB",
    description: "Normalized Ratio Procedure between Bands: (VH − VV) / (VH + VV) en lineal.",
  },
];

function formatFileSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Sentinel1Panel({
  token,
  projectId,
  projectName = "",
  loading,
  mapLayers,
  recorteLayerId,
  setRecorteLayerId,
  stackMode,
  setStackMode,
  onOpenPreproGallery,
  recortePipelineBusy,
  s1SarStacksBusy = false,
  onS1GrdRecortes,
  onS1SarIndexStacks,
  clusterElbowLoading,
  clusterGmmLoading,
  clusterElbowResults,
  clusterGmmResults,
  onClusterElbow,
  onClusterGmm,
  onLoadPersistedClusterGmm,
}) {
  const vectorLayers = mapLayers.filter((l) => l.kind === "vector");
  const busy = loading || recortePipelineBusy || s1SarStacksBusy;

  /** Capas vectoriales del proyecto (BD), no solo las pintadas en el mapa — alinea el AOI con el shapefile elegido. */
  const [serverVectorLayers, setServerVectorLayers] = useState([]);

  const [s1ModalOpen, setS1ModalOpen] = useState(false);
  const [s1Inventory, setS1Inventory] = useState(null);
  const [s1InventoryLoading, setS1InventoryLoading] = useState(false);
  const [s1Error, setS1Error] = useState("");
  const [s1Selected, setS1Selected] = useState(() => new Set());
  /** null | "indices" (estimar SAR) | "ts" (series de tiempo desde s1indices/) */
  const [s1GalleryKind, setS1GalleryKind] = useState(null);
  const [selectedS1SarIndices, setSelectedS1SarIndices] = useState([]);
  const [s1VtsModalOpen, setS1VtsModalOpen] = useState(false);
  const [s1VtsData, setS1VtsData] = useState(null);
  const [s1VtsLoading, setS1VtsLoading] = useState(false);
  const [s1VtsError, setS1VtsError] = useState("");
  const [s1ClusterModalOpen, setS1ClusterModalOpen] = useState(false);
  const [s1ClusterResultsModalOpen, setS1ClusterResultsModalOpen] = useState(false);
  const [s1ClusterPickerOpen, setS1ClusterPickerOpen] = useState(false);
  const [s1ClusterSelectedDates, setS1ClusterSelectedDates] = useState([]);
  const [s1ClusterPeekHint, setS1ClusterPeekHint] = useState("");
  const [s1ClusterLoadingPersisted, setS1ClusterLoadingPersisted] = useState(false);
  const [s1ClusterResultsZoom, setS1ClusterResultsZoom] = useState(100);
  const [s1GmmK, setS1GmmK] = useState(5);

  useEffect(() => {
    setS1ModalOpen(false);
    setS1Inventory(null);
    setS1Error("");
    setS1Selected(new Set());
    setS1GalleryKind(null);
    setSelectedS1SarIndices([]);
    setS1VtsModalOpen(false);
    setS1VtsData(null);
    setS1VtsError("");
    setS1ClusterModalOpen(false);
    setS1ClusterResultsModalOpen(false);
    setS1ClusterPickerOpen(false);
    setS1ClusterSelectedDates([]);
    setS1ClusterPeekHint("");
    setS1ClusterResultsZoom(100);
    setS1GmmK(5);
  }, [projectId]);

  useEffect(() => {
    const ds = clusterElbowResults?.datasets;
    if (!ds?.length) return;
    const sk = ds[0]?.suggested_k;
    if (sk != null && Number.isFinite(Number(sk))) {
      setS1GmmK(Math.max(1, Math.min(30, Number(sk))));
    }
  }, [clusterElbowResults]);

  useEffect(() => {
    if (clusterGmmResults?.results?.length) {
      setS1ClusterResultsModalOpen(true);
      setS1ClusterModalOpen(false);
    }
  }, [clusterGmmResults]);

  const s1GmmIndexResults = clusterGmmResults?.results?.filter((r) => r.kind === "index") ?? [];

  async function openS1ClusterGmmResultsOrHint() {
    if (clusterGmmResults?.results?.length) {
      setS1ClusterResultsModalOpen(true);
      setS1ClusterPeekHint("");
      return;
    }
    if (!onLoadPersistedClusterGmm) {
      setS1ClusterPeekHint("No hay resultados de cluster GMM en memoria. Ejecuta «4) Cluster» primero.");
      window.setTimeout(() => setS1ClusterPeekHint(""), 7000);
      return;
    }
    setS1ClusterLoadingPersisted(true);
    setS1ClusterPeekHint("");
    try {
      const data = await onLoadPersistedClusterGmm();
      if (data?.results?.length) {
        setS1ClusterResultsModalOpen(true);
        return;
      }
      setS1ClusterPeekHint(
        "No se encontraron GeoTIFF de GMM en cluster_s1_gmm/ de este proyecto (o los nombres no coinciden con el formato esperado)."
      );
      window.setTimeout(() => setS1ClusterPeekHint(""), 9000);
    } catch (e) {
      setS1ClusterPeekHint(formatApiErrorDetail(e));
      window.setTimeout(() => setS1ClusterPeekHint(""), 9000);
    } finally {
      setS1ClusterLoadingPersisted(false);
    }
  }

  /**
   * La pestaña SI no ofrece RGB ni índices S2; al entrar desde Prepro, mapear modos de visualización.
   */
  useEffect(() => {
    if (stackMode === "visual-rgb") setStackMode("visual-s1-vv");
    else if (stackMode === "visual-index") setStackMode("visual-s1-sar-indices");
    else if (stackMode === "visual-s1-vh" || stackMode === "visual-s1-index") setStackMode("visual-s1-vv");
  }, [stackMode, setStackMode]);

  useEffect(() => {
    if (!projectId || !token) {
      setServerVectorLayers([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/layers/${projectId}`);
        if (cancelled) return;
        const rows = Array.isArray(r.data) ? r.data : [];
        setServerVectorLayers(rows);
      } catch {
        if (!cancelled) setServerVectorLayers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  const polygonOptions =
    serverVectorLayers.length > 0
      ? serverVectorLayers.map((l) => ({ id: l.id, name: l.name }))
      : vectorLayers
          .filter((l) => l.serverId != null && Number.isFinite(Number(l.serverId)))
          .map((l) => ({ id: Number(l.serverId), name: l.name }));

  function openS1InventoryModal() {
    if (!projectId || !token) return;
    setS1ModalOpen(true);
    setS1Inventory(null);
    setS1Error("");
    setS1Selected(new Set());
    void loadS1Inventory();
  }

  async function loadS1Inventory() {
    if (!projectId || !token) return;
    setS1InventoryLoading(true);
    setS1Error("");
    try {
      setAuthToken(token);
      const r = await api.get(`/raster/project-sentinel1-inventory/${projectId}`);
      setS1Inventory(r.data);
    } catch (e) {
      setS1Error(formatApiErrorDetail(e));
    } finally {
      setS1InventoryLoading(false);
    }
  }

  function toggleS1Product(key) {
    const k = String(key).trim();
    if (!k) return;
    setS1Selected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function runRecorteFromModal() {
    const paths = [...s1Selected];
    const layerId = recorteLayerId ? Number(recorteLayerId) : undefined;
    const ok = await onS1GrdRecortes?.(layerId, paths);
    if (ok) {
      setS1ModalOpen(false);
      setS1Selected(new Set());
    }
  }

  return (
    <>
      {(!token || !projectId) ? (
        <div className="warn-msg">Primero crea cuenta y proyecto en Admin.</div>
      ) : null}

      <label>
        1. Polígonos para recortar (shapefile / lote del proyecto)
        <select
          value={recorteLayerId}
          onChange={(e) => setRecorteLayerId(e.target.value)}
          disabled={busy}
        >
          <option value="">Todos los lotes del proyecto (unión)</option>
          {polygonOptions.map((l) => (
            <option key={l.id} value={String(l.id)}>
              {l.name}
            </option>
          ))}
        </select>
        <span className="l2a-downloads-hint" style={{ display: "block", marginTop: 6 }}>
          El recorte usa el polígono de la capa elegida (o la unión de todas las capas vectoriales del proyecto en
          servidor). Solo se procesan los productos Sentinel-1 que marques en la lista.
        </span>
      </label>

      <button
        type="button"
        className="s1-list-open-btn"
        onClick={() => void openS1InventoryModal()}
        disabled={busy || !projectId || !token}
      >
        Listar archivos en descargas
      </button>

      <label>
        2) Visualización
        <select
          value={stackMode}
          onChange={(e) => setStackMode(e.target.value)}
          disabled={busy}
        >
          <option value="visual-s1-vv">Visual VV/VH</option>
          <option value="visual-s1-sar-indices">Visual índices SAR (serie temporal)</option>
          <option value="visual-cluster">Visual cluster</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          if (stackMode === "visual-cluster") {
            void openS1ClusterGmmResultsOrHint();
          } else {
            onOpenPreproGallery?.();
          }
        }}
        disabled={!projectId || !token || loading || s1ClusterLoadingPersisted}
      >
        {stackMode === "visual-s1-vv"
          ? "Abrir galería VV/VH"
          : stackMode === "visual-s1-sar-indices"
            ? "Abrir galería de índices SAR (serie temporal)"
            : "Abrir visualización de clusters GMM"}
      </button>
      {s1ClusterPeekHint ? (
        <p className="prepro-hint" role="status">
          {s1ClusterPeekHint}
        </p>
      ) : null}
      {s1ClusterLoadingPersisted ? (
        <p className="prepro-hint" role="status">
          Cargando resultados GMM desde cluster_s1_gmm/…
        </p>
      ) : null}

      <div className="indices-section">
        <div className="indices-section-title">
          <strong>3) Índices SAR (Sentinel-1)</strong>
          <span className="indices-section-hint">
            Por escena, en la misma carpeta <code>*.data</code>: <strong>VV</strong> ={" "}
            <code>Sigma0_VV_db.img</code>, <strong>VH</strong> = <code>Sigma0_VH_db.img</code> (sigma0 dB en{" "}
            <code>s1prepoceso/</code>). Salida: un GeoTIFF por índice en <code>s1indices/&lt;ÍNDICE&gt;/</code>, una
            banda por fecha en orden cronológico.
          </span>
        </div>
        <button
          type="button"
          className="indices-run-btn"
          onClick={() => {
            setSelectedS1SarIndices([]);
            setS1GalleryKind("indices");
          }}
          disabled={busy || !projectId || !token}
        >
          Estimar índices SAR
        </button>
      </div>

      <div className="cluster-actions-row">
        <button
          type="button"
          onClick={() => setS1ClusterModalOpen(true)}
          disabled={busy || !projectId || !token}
        >
          4) Cluster
        </button>
        <button
          type="button"
          className="cluster-open-results-btn"
          disabled={busy || !projectId || !token || s1ClusterLoadingPersisted}
          onClick={() => void openS1ClusterGmmResultsOrHint()}
        >
          Ver resultados GMM
        </button>
      </div>

      <div className="indices-section">
        <div className="indices-section-title">
          <strong>5) Series de tiempo</strong>
          <span className="indices-section-hint">
            Mismas fechas que aparecen en <strong>los cinco</strong> stacks bajo <code>s1indices/</code> (RVI, RFDI,
            VV/VH, VH/VV, NRPB): medias espaciales y series por píxel (muestreadas), normalizadas 0–1 por fecha.
          </span>
        </div>
        <button
          type="button"
          className="indices-run-btn"
          onClick={() => {
            setS1VtsError("");
            setS1GalleryKind("ts");
          }}
          disabled={busy || !projectId || !token}
        >
          Seleccionar fechas
        </button>
      </div>

      {s1ModalOpen ? (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="s1-downloads-modal-title"
          onClick={() => setS1ModalOpen(false)}
        >
          <div className="index-modal l2a-downloads-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="s1-downloads-modal-title">Archivos Sentinel-1 en descargas</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setS1ModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body l2a-downloads-body">
              {s1InventoryLoading ? <p className="l2a-downloads-status">Cargando inventario…</p> : null}
              {s1Error ? <p className="rgb-gallery-error">{s1Error}</p> : null}
              {!s1InventoryLoading && s1Inventory ? (
                <>
                  <p className="l2a-downloads-hint">
                    Carpeta escaneada: <code>{s1Inventory.downloads_dir}</code>
                  </p>
                  {!s1Inventory.exists ? (
                    <p className="l2a-downloads-empty">
                      La carpeta <code>Sentinel1</code> no existe aún o no es accesible. Descarga GRD IW desde la pestaña
                      Cargar.
                    </p>
                  ) : (
                    <>
                      {(() => {
                        const zipRows = s1Inventory.zip_l2a || [];
                        const safeRows = s1Inventory.safe_folders || [];
                        const other = s1Inventory.other_top_level || [];
                        const hasAny = zipRows.length > 0 || safeRows.length > 0;
                        return (
                          <>
                            <p className="l2a-downloads-intro">
                              Marca los productos a recortar (subset espacial por el polígono de la opción 1; equivalente
                              operacional a SNAP Raster / Subset / Spatial subset con polígono). Salida en{" "}
                              <code>recortes/S1/</code> (GeoTIFF VV+VH, 2 bandas).
                            </p>
                            <ul className="l2a-downloads-list">
                              {zipRows.map((z) => (
                                <li key={`zip:${z.name}`}>
                                  <label className="l2a-downloads-row">
                                    <input
                                      type="checkbox"
                                      checked={s1Selected.has(z.name)}
                                      onChange={() => toggleS1Product(z.name)}
                                    />
                                    <span className="l2a-downloads-kind">ZIP</span>
                                    <span className="l2a-downloads-name" title={z.name}>
                                      {z.name}
                                      {z.weak_match ? (
                                        <span className="l2a-downloads-weak">
                                          {" "}
                                          (nombre poco típico para GRD IW)
                                        </span>
                                      ) : null}
                                    </span>
                                    {z.size_bytes != null ? (
                                      <span className="l2a-downloads-size">{formatFileSize(z.size_bytes)}</span>
                                    ) : null}
                                  </label>
                                </li>
                              ))}
                              {safeRows.map((name) => (
                                <li key={`safe:${name}`}>
                                  <label className="l2a-downloads-row">
                                    <input
                                      type="checkbox"
                                      checked={s1Selected.has(name)}
                                      onChange={() => toggleS1Product(name)}
                                    />
                                    <span className="l2a-downloads-kind">.SAFE</span>
                                    <span className="l2a-downloads-name" title={name}>
                                      {name}
                                    </span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                            {!hasAny ? (
                              <p className="l2a-downloads-empty">
                                No hay carpetas <code>.SAFE</code> ni archivos <code>.zip</code> GRD en esta carpeta.
                              </p>
                            ) : null}
                            {other.length > 0 ? (
                              <p className="l2a-downloads-other">Otros en el primer nivel: {other.join(", ")}</p>
                            ) : null}
                          </>
                        );
                      })()}
                    </>
                  )}
                </>
              ) : null}
              <div className="l2a-downloads-actions">
                <button type="button" className="rgb-gallery-btn-secondary" onClick={() => setS1ModalOpen(false)}>
                  Cerrar
                </button>
                <button
                  type="button"
                  className="rgb-gallery-btn-secondary"
                  disabled={s1InventoryLoading}
                  onClick={() => void loadS1Inventory()}
                >
                  Actualizar lista
                </button>
                <button
                  type="button"
                  className="rgb-gallery-btn-primary"
                  disabled={
                    busy ||
                    !projectId ||
                    !token ||
                    s1Selected.size === 0 ||
                    s1InventoryLoading ||
                    !s1Inventory?.exists
                  }
                  title={
                    s1Selected.size === 0 ? "Selecciona al menos un producto" : undefined
                  }
                  onClick={() => void runRecorteFromModal()}
                >
                  Ejecutar recorte
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {s1ClusterModalOpen ? (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="s1-cluster-modal-title"
          onClick={() => setS1ClusterModalOpen(false)}
        >
          <div className="index-modal cluster-flow-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header cluster-modal-header-tools">
              <h3 id="s1-cluster-modal-title">4) Cluster SAR (codo + GMM)</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setS1ClusterModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body cluster-flow-body">
              <p className="cluster-flow-intro">
                Selecciona fechas/escenas para filtrar bandas en <code>s1indices/</code> y ejecutar
                clustering por índice SAR (<strong>RVI, RFDI, VV/VH, VH/VV y NRPB</strong>). Primero
                calcula el método del codo y luego ejecuta GMM con una sola K para todos los índices.
              </p>
              <div className="cluster-flow-toolbar">
                <button
                  type="button"
                  className="indices-run-btn"
                  onClick={() => {
                    // Evita superposición de modales: abrir selector de escenas en primer plano.
                    setS1ClusterModalOpen(false);
                    setS1ClusterPickerOpen(true);
                  }}
                  disabled={!projectId || !token}
                >
                  Seleccionar escenas (fechas)
                </button>
                <button
                  type="button"
                  className="indices-run-btn"
                  onClick={() => onClusterElbow?.(s1ClusterSelectedDates)}
                  disabled={clusterElbowLoading || !s1ClusterSelectedDates.length}
                  title={
                    !s1ClusterSelectedDates.length
                      ? "Selecciona al menos una fecha para cluster SAR"
                      : undefined
                  }
                >
                  {clusterElbowLoading ? "Calculando codo…" : "Calcular método del codo"}
                </button>
                {clusterElbowResults?.datasets?.length ? (
                  <>
                    <label className="cluster-unified-k-label">
                      K para todos los índices (1–30)
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={s1GmmK}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setS1GmmK(Number.isFinite(n) ? Math.max(1, Math.min(30, Math.round(n))) : 1);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="indices-run-btn"
                      onClick={async () => {
                        if (!onClusterGmm || !clusterElbowResults?.datasets?.length) return;
                        const k = Math.max(1, Math.min(30, Math.round(Number(s1GmmK)) || 1));
                        const kByKey = Object.fromEntries(clusterElbowResults.datasets.map((d) => [d.key, k]));
                        await onClusterGmm(kByKey, s1ClusterSelectedDates);
                      }}
                      disabled={
                        clusterGmmLoading ||
                        !clusterElbowResults?.datasets?.length ||
                        !Number.isFinite(s1GmmK) ||
                        s1GmmK < 1
                      }
                    >
                      {clusterGmmLoading ? "Ejecutando GMM…" : "Ejecutar GMM"}
                    </button>
                  </>
                ) : null}
              </div>
              <p className="cluster-meta">
                Fechas seleccionadas: <strong>{s1ClusterSelectedDates.length}</strong>
              </p>

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
                      <p className="cluster-meta">
                        K sugerido (referencia): {d.suggested_k} · Train: {d.n_train_pixels} px · {d.n_features} feat.
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {s1ClusterResultsModalOpen && clusterGmmResults?.results?.length ? (
        <div
          className="cluster-results-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="s1-cluster-results-title"
          onClick={() => setS1ClusterResultsModalOpen(false)}
        >
          <div className="cluster-results-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header cluster-modal-header-tools cluster-results-modal-header">
              <h3 id="s1-cluster-results-title">Resultados S1 — clusters GMM</h3>
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
                  onClick={() => setS1ClusterResultsZoom((z) => Math.max(50, z - 10))}
                >
                  −
                </button>
                <input
                  className="cluster-zoom-range"
                  type="range"
                  min={50}
                  max={200}
                  step={5}
                  value={s1ClusterResultsZoom}
                  onChange={(e) => setS1ClusterResultsZoom(Number(e.target.value))}
                />
                <span className="cluster-zoom-pct">{s1ClusterResultsZoom}%</span>
                <button
                  type="button"
                  className="cluster-zoom-btn"
                  aria-label="Aumentar zoom"
                  onClick={() => setS1ClusterResultsZoom((z) => Math.min(200, z + 10))}
                >
                  +
                </button>
                <button
                  type="button"
                  className="cluster-zoom-reset"
                  onClick={() => setS1ClusterResultsZoom(100)}
                >
                  100%
                </button>
              </div>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setS1ClusterResultsModalOpen(false)}
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
              <div className="cluster-results-zoom-inner" style={{ zoom: s1ClusterResultsZoom / 100 }}>
                {s1GmmIndexResults.length ? (
                  <div className="cluster-gmm-grid cluster-gmm-grid--row1">
                    {s1GmmIndexResults.map((r) => (
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
                      </div>
                    ))}
                  </div>
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
        open={s1GalleryKind !== null || s1ClusterPickerOpen}
        mode={s1ClusterPickerOpen ? "s1SarTimeSeriesSelect" : s1GalleryKind === "ts" ? "s1SarTimeSeriesSelect" : "s1SarIndexSelect"}
        galleryVisualMode="rgb"
        projectName={projectName}
        indexCatalog={S1_SAR_INDEX_CATALOG}
        selectedIndices={selectedS1SarIndices}
        onSelectedIndicesChange={setSelectedS1SarIndices}
        onClose={() => {
          if (s1ClusterPickerOpen) {
            setS1ClusterModalOpen(true);
          }
          setS1GalleryKind(null);
          setS1ClusterPickerOpen(false);
        }}
        canEstimate={selectedS1SarIndices.length > 0}
        onEstimateIndices={(payload) => {
          if (
            payload &&
            typeof payload === "object" &&
            Array.isArray(payload.s1SarSceneVvRelpaths) &&
            payload.s1SarSceneVvRelpaths.length > 0
          ) {
            void onS1SarIndexStacks?.({
              sceneVvRelpaths: payload.s1SarSceneVvRelpaths,
              indices: Array.isArray(payload.s1SarIndices) ? payload.s1SarIndices : [],
            });
          }
          setS1GalleryKind(null);
        }}
        onTimeSeries={async (arg) => {
          if (s1ClusterPickerOpen) {
            if (arg && typeof arg === "object" && Array.isArray(arg.s1SarDates)) {
              const picked = [...new Set(arg.s1SarDates.map((d) => String(d).slice(0, 10)).filter(Boolean))].sort();
              setS1ClusterSelectedDates(picked);
            }
            setS1ClusterPickerOpen(false);
            setS1ClusterModalOpen(true);
            return;
          }
          if (!token || !projectId) return;
          if (!arg || typeof arg !== "object" || !Array.isArray(arg.s1SarDates) || !arg.s1SarDates.length) return;
          setS1VtsLoading(true);
          setS1VtsError("");
          try {
            setAuthToken(token);
            const res = await api.post("/preprocess/s1-sar-time-series", {
              project_id: Number(projectId),
              dates: arg.s1SarDates,
            });
            setS1VtsData(res.data);
            setS1GalleryKind(null);
            setS1VtsModalOpen(true);
          } catch (e) {
            setS1VtsError(formatApiErrorDetail(e));
          } finally {
            setS1VtsLoading(false);
          }
        }}
        projectId={projectId}
        token={token}
      />

      {s1VtsModalOpen && s1VtsData ? (
        <div
          className="index-modal-overlay vts-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="s1-vts-modal-title"
          onClick={() => {
            setS1VtsModalOpen(false);
            setS1VtsData(null);
          }}
        >
          <div className="index-modal vts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="s1-vts-modal-title">Series de tiempo — índices SAR (s1indices/)</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => {
                  setS1VtsModalOpen(false);
                  setS1VtsData(null);
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body vts-modal-body">
              <VegetationTimeSeriesCharts data={s1VtsData} />
            </div>
          </div>
        </div>
      ) : null}
      {s1VtsLoading ? (
        <div className="vts-loading-toast" role="status">
          Calculando series de tiempo SAR…
        </div>
      ) : null}
      {s1VtsError ? (
        <div className="status-msg vts-error-msg" role="alert">
          {s1VtsError}
        </div>
      ) : null}
    </>
  );
}
