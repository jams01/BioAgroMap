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
  loading,
  mapLayers,
  recorteLayerId,
  setRecorteLayerId,
  stackMode,
  setStackMode,
  onOpenPreproGallery,
  onOpenPreproClusterViz,
  recortePipelineBusy,
  s1SarStacksBusy = false,
  onS1GrdRecortes,
  onS1SarIndexStacks,
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
  }, [projectId]);

  /**
   * La pestaña SI no ofrece RGB ni índices S2; al entrar desde Prepro, mapear modos de visualización.
   */
  useEffect(() => {
    if (stackMode === "visual-rgb") setStackMode("visual-s1-vv");
    else if (stackMode === "visual-index") setStackMode("visual-s1-sar-indices");
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
          <option value="visual-s1-vv">Visual VV</option>
          <option value="visual-s1-vh">Visual VH</option>
          <option value="visual-s1-index">Visual índice S1</option>
          <option value="visual-s1-sar-indices">Visual índices SAR (serie temporal)</option>
          <option value="visual-cluster">Visual cluster</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          if (stackMode === "visual-cluster") {
            void onOpenPreproClusterViz?.();
          } else {
            onOpenPreproGallery?.();
          }
        }}
        disabled={!projectId || !token || loading}
      >
        {stackMode === "visual-s1-vv"
          ? "Abrir galería VV"
          : stackMode === "visual-s1-vh"
            ? "Abrir galería VH"
            : stackMode === "visual-s1-index"
              ? "Abrir galería índice S1 (VH/VV)"
              : stackMode === "visual-s1-sar-indices"
                ? "Abrir galería de índices SAR (serie temporal)"
                : "Abrir visualización de clusters GMM"}
      </button>

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

      <RgbTimeSeriesGallery
        open={s1GalleryKind !== null}
        mode={s1GalleryKind === "ts" ? "s1SarTimeSeriesSelect" : "s1SarIndexSelect"}
        galleryVisualMode="rgb"
        indexCatalog={S1_SAR_INDEX_CATALOG}
        selectedIndices={selectedS1SarIndices}
        onSelectedIndicesChange={setSelectedS1SarIndices}
        onClose={() => setS1GalleryKind(null)}
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
