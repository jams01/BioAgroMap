import { useEffect, useRef, useState } from "react";
import api, { formatApiErrorDetail, setAuthToken } from "../api";
import RgbTimeSeriesGallery from "./RgbTimeSeriesGallery";
import VegetationTimeSeriesCharts from "./VegetationTimeSeriesCharts";

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

function formatFileSize(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Misma heurística que el backend para .zip / .SAFE de Sentinel-2 (L1C/L2A). */
function looksLikeSentinel2ZipFilename(name) {
  const u = String(name).toUpperCase();
  if (!u.endsWith(".ZIP")) return false;
  return (
    u.includes("MSIL2A") ||
    u.includes("MSIL1C") ||
    u.includes("S2A_MSIL") ||
    u.includes("S2B_MSIL") ||
    u.includes("S2C_MSIL")
  );
}

function looksLikeSentinel2SafeDirname(name) {
  const u = String(name).toUpperCase();
  if (!u.endsWith(".SAFE")) return false;
  return (
    u.includes("MSIL2A") ||
    u.includes("MSIL1C") ||
    u.includes("S2A_MSIL") ||
    u.includes("S2B_MSIL") ||
    u.includes("S2C_MSIL")
  );
}

/** Entradas de `other_top_level` que aún pueden ser productos seleccionables (p. ej. API antigua). */
function partitionOtherTopLevelForL2a(otherTopLevel) {
  const selectable = [];
  const plain = [];
  for (const raw of otherTopLevel || []) {
    const isDir = String(raw).endsWith("/");
    const name = isDir ? String(raw).slice(0, -1) : String(raw);
    if (isDir && looksLikeSentinel2SafeDirname(name)) {
      selectable.push({ kind: "safe", name });
    } else if (!isDir && looksLikeSentinel2ZipFilename(name)) {
      selectable.push({ kind: "zip", name });
    } else {
      plain.push(raw);
    }
  }
  return { selectable, plain };
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
  visualIndexGalleryKick = 0,
  selectedIndices,
  setSelectedIndices,
  onS2L2aRecortes,
  onS2IndexStacks,
  clusterElbowLoading,
  clusterGmmLoading,
  clusterElbowResults,
  clusterGmmResults,
  onClusterElbow,
  onClusterGmm,
  onLoadPersistedClusterGmm,
  recorteLayerId,
  setRecorteLayerId,
  preproGalleryKick = 0,
  preproClusterVizKick = 0,
}) {
  const [clusterModalOpen, setClusterModalOpen] = useState(false);
  const [clusterResultsModalOpen, setClusterResultsModalOpen] = useState(false);
  const [clusterApiBuild, setClusterApiBuild] = useState("");
  const [clusterResultsZoom, setClusterResultsZoom] = useState(100);
  /** Una sola K para todos los datasets al ejecutar GMM. */
  const [gmmK, setGmmK] = useState(5);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryMode, setGalleryMode] = useState("view");
  const [vtsModalOpen, setVtsModalOpen] = useState(false);
  const [vtsData, setVtsData] = useState(null);
  const [vtsLoading, setVtsLoading] = useState(false);
  const [vtsError, setVtsError] = useState("");
  const [l2aModalOpen, setL2aModalOpen] = useState(false);
  /** question → pick_project → pick */
  const [l2aUiStep, setL2aUiStep] = useState("question");
  const [l2aProjectsList, setL2aProjectsList] = useState([]);
  const [l2aProjectsLoading, setL2aProjectsLoading] = useState(false);
  const [l2aSourceProjectId, setL2aSourceProjectId] = useState("");
  const [l2aCopyLoading, setL2aCopyLoading] = useState(false);
  const [l2aInventory, setL2aInventory] = useState(null);
  const [l2aInventoryLoading, setL2aInventoryLoading] = useState(false);
  const [l2aError, setL2aError] = useState("");
  const [l2aSelected, setL2aSelected] = useState(() => new Set());
  /** undefined = carpeta descargas Sentinel por defecto (slug); string = ruta bajo raíz del proyecto */
  const [l2aJobSourceSubpath, setL2aJobSourceSubpath] = useState(undefined);
  const [clusterPeekHint, setClusterPeekHint] = useState("");
  const [loadingClusterPersisted, setLoadingClusterPersisted] = useState(false);
  const lastVisualIndexKick = useRef(0);
  const lastPreproGalleryKick = useRef(0);
  const lastPreproClusterVizKick = useRef(0);
  const openClusterGmmResultsOrHintRef = useRef(async () => {});
  const vectorLayers = mapLayers.filter((l) => l.kind === "vector");
  const hasVectors = vectorLayers.length > 0;
  const busy = loading || recortePipelineBusy || indexStacksBusy;

  useEffect(() => {
    const ds = clusterElbowResults?.datasets;
    if (!ds?.length) return;
    const sk = ds[0]?.suggested_k;
    if (sk != null && Number.isFinite(Number(sk))) {
      setGmmK(Math.max(1, Math.min(30, Number(sk))));
    }
  }, [clusterElbowResults]);

  useEffect(() => {
    setClusterModalOpen(false);
    setClusterResultsModalOpen(false);
    setClusterResultsZoom(100);
    setClusterPeekHint("");
    setL2aModalOpen(false);
    setL2aUiStep("question");
    setL2aProjectsList([]);
    setL2aSourceProjectId("");
    setL2aCopyLoading(false);
    setL2aInventory(null);
    setL2aJobSourceSubpath(undefined);
    setL2aError("");
    setL2aSelected(new Set());
    lastPreproGalleryKick.current = 0;
    lastPreproClusterVizKick.current = 0;
  }, [projectId]);

  function openL2aDownloadsModal() {
    if (!projectId || !token) return;
    setL2aModalOpen(true);
    setL2aUiStep("question");
    setL2aInventory(null);
    setL2aJobSourceSubpath(undefined);
    setL2aError("");
    setL2aSelected(new Set());
    setL2aProjectsList([]);
    setL2aSourceProjectId("");
    setL2aCopyLoading(false);
  }

  async function loadTenantProjectsForL2a() {
    if (!token) return;
    setL2aProjectsLoading(true);
    setL2aError("");
    try {
      setAuthToken(token);
      const r = await api.get("/projects");
      const others = (r.data || []).filter((p) => Number(p.id) !== Number(projectId));
      setL2aProjectsList(others);
      if (others.length === 0) {
        setL2aError(
          "No hay otros proyectos en este espacio de trabajo. Pulsa «Atrás» y elige «No» para listar solo la carpeta de descargas de este proyecto."
        );
      }
    } catch (e) {
      setL2aError(formatApiErrorDetail(e));
    } finally {
      setL2aProjectsLoading(false);
    }
  }

  async function onL2aQuestionYes() {
    setL2aUiStep("pick_project");
    setL2aSourceProjectId("");
    await loadTenantProjectsForL2a();
  }

  async function loadDefaultL2aInventory() {
    if (!projectId || !token) return;
    setL2aInventoryLoading(true);
    setL2aError("");
    try {
      setAuthToken(token);
      const r = await api.get(`/raster/project-downloads-inventory/${projectId}`);
      setL2aInventory(r.data);
      setL2aJobSourceSubpath(undefined);
      setL2aUiStep("pick");
    } catch (e) {
      setL2aError(formatApiErrorDetail(e));
    } finally {
      setL2aInventoryLoading(false);
    }
  }

  async function onL2aQuestionNo() {
    await loadDefaultL2aInventory();
  }

  async function copyDownloadsFromSelectedProjectAndList() {
    if (!projectId || !token || !l2aSourceProjectId) return;
    setL2aCopyLoading(true);
    setL2aError("");
    try {
      setAuthToken(token);
      await api.post("/raster/copy-downloads-from-project", null, {
        params: {
          source_project_id: Number(l2aSourceProjectId),
          target_project_id: Number(projectId),
        },
      });
      await loadDefaultL2aInventory();
    } catch (e) {
      setL2aError(formatApiErrorDetail(e));
    } finally {
      setL2aCopyLoading(false);
    }
  }

  function toggleL2aProduct(name) {
    const key = String(name).trim();
    if (!key) return;
    setL2aSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  useEffect(() => {
    if (!visualIndexGalleryKick || visualIndexGalleryKick <= lastVisualIndexKick.current) return;
    lastVisualIndexKick.current = visualIndexGalleryKick;
    setGalleryMode("view");
    setGalleryOpen(true);
  }, [visualIndexGalleryKick]);

  useEffect(() => {
    if (!preproGalleryKick || preproGalleryKick <= lastPreproGalleryKick.current) return;
    lastPreproGalleryKick.current = preproGalleryKick;
    setGalleryMode("view");
    setGalleryOpen(true);
  }, [preproGalleryKick]);

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

  const gmmIndexResults =
    clusterGmmResults?.results?.filter((r) => r.kind === "index") ?? [];
  const gmmMultibandResults =
    clusterGmmResults?.results?.filter((r) => r.kind === "multiband") ?? [];

  async function openClusterGmmResultsOrHint() {
    if (clusterGmmResults?.results?.length) {
      setClusterResultsModalOpen(true);
      setClusterPeekHint("");
      return;
    }
    if (!onLoadPersistedClusterGmm) {
      setClusterPeekHint(
        "No hay resultados de cluster GMM en memoria. Ejecuta «4) Cluster» primero."
      );
      window.setTimeout(() => setClusterPeekHint(""), 7000);
      return;
    }
    setLoadingClusterPersisted(true);
    setClusterPeekHint("");
    try {
      const data = await onLoadPersistedClusterGmm();
      if (data?.results?.length) {
        setClusterResultsModalOpen(true);
        return;
      }
      setClusterPeekHint(
        "No se encontraron GeoTIFF de GMM en cluster_gmm/ de este proyecto (o los nombres no coinciden con el formato esperado)."
      );
      window.setTimeout(() => setClusterPeekHint(""), 9000);
    } catch (e) {
      setClusterPeekHint(formatApiErrorDetail(e));
      window.setTimeout(() => setClusterPeekHint(""), 9000);
    } finally {
      setLoadingClusterPersisted(false);
    }
  }

  openClusterGmmResultsOrHintRef.current = openClusterGmmResultsOrHint;

  useEffect(() => {
    if (!preproClusterVizKick || preproClusterVizKick <= lastPreproClusterVizKick.current) return;
    lastPreproClusterVizKick.current = preproClusterVizKick;
    void openClusterGmmResultsOrHintRef.current();
  }, [preproClusterVizKick]);

  return (
    <>
      <label>
        1. Polígonos para recorte
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
        onClick={() => void openL2aDownloadsModal()}
        disabled={busy || !projectId || !token}
      >
        Listar archivos L2A en descargas
      </button>

      {l2aModalOpen ? (
        <div
          className="index-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="l2a-downloads-modal-title"
          onClick={() => setL2aModalOpen(false)}
        >
          <div className="index-modal l2a-downloads-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="l2a-downloads-modal-title">
                {l2aUiStep === "question"
                  ? "Descargas L2A"
                  : l2aUiStep === "pick_project"
                    ? "Copiar descargas desde otro proyecto"
                    : "Archivos L2A — selección para recorte"}
              </h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setL2aModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body l2a-downloads-body">
              {l2aUiStep === "question" ? (
                <>
                  <p className="l2a-downloads-intro">
                    ¿Tienes descargas Sentinel-2 (L2A) para esta área en <strong>otro proyecto</strong> del mismo espacio
                    de trabajo?
                  </p>
                  <p className="l2a-downloads-hint">
                    Si respondes <strong>sí</strong>, podrás elegir ese proyecto y el sistema copiará su carpeta de
                    descargas a este proyecto. Luego verás la lista para marcar ZIP / carpetas <code>.SAFE</code> y
                    ejecutar el recorte.
                  </p>
                  <div className="l2a-question-actions">
                    <button
                      type="button"
                      className="rgb-gallery-btn-primary"
                      disabled={l2aInventoryLoading}
                      onClick={() => void onL2aQuestionYes()}
                    >
                      Sí, están en otro proyecto
                    </button>
                    <button
                      type="button"
                      className="rgb-gallery-btn-secondary"
                      disabled={l2aInventoryLoading}
                      onClick={() => void onL2aQuestionNo()}
                    >
                      No, ya están en este proyecto
                    </button>
                  </div>
                  {l2aInventoryLoading ? (
                    <p className="l2a-downloads-status">Cargando inventario…</p>
                  ) : null}
                  {l2aError ? <p className="rgb-gallery-error">{l2aError}</p> : null}
                </>
              ) : l2aUiStep === "pick_project" ? (
                <>
                  <p className="l2a-downloads-intro">
                    Elige el proyecto que <strong>ya tiene las descargas</strong>. Se copiarán a la carpeta de descargas
                    del <strong>proyecto actual</strong> y después se mostrará el listado para seleccionar recortes.
                  </p>
                  {l2aProjectsLoading ? (
                    <p className="l2a-downloads-status">Cargando proyectos…</p>
                  ) : (
                    <label className="l2a-project-pick-label">
                      Proyecto origen
                      <select
                        className="l2a-project-pick-select"
                        value={l2aSourceProjectId}
                        onChange={(e) => setL2aSourceProjectId(e.target.value)}
                        disabled={l2aCopyLoading || l2aProjectsList.length === 0}
                      >
                        <option value="">— Selecciona un proyecto —</option>
                        {l2aProjectsList.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.name} (id {p.id})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {l2aCopyLoading ? (
                    <p className="l2a-downloads-status">Copiando archivos a este proyecto…</p>
                  ) : null}
                  {l2aError ? <p className="rgb-gallery-error">{l2aError}</p> : null}
                  <div className="l2a-browse-actions">
                    <button
                      type="button"
                      className="rgb-gallery-btn-secondary"
                      disabled={l2aCopyLoading}
                      onClick={() => {
                        setL2aUiStep("question");
                        setL2aError("");
                        setL2aSourceProjectId("");
                      }}
                    >
                      Atrás
                    </button>
                    <button
                      type="button"
                      className="rgb-gallery-btn-primary"
                      disabled={
                        l2aCopyLoading ||
                        l2aProjectsLoading ||
                        !l2aSourceProjectId ||
                        l2aProjectsList.length === 0
                      }
                      onClick={() => void copyDownloadsFromSelectedProjectAndList()}
                    >
                      Copiar descargas aquí y listar archivos
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {l2aInventoryLoading ? (
                    <p className="l2a-downloads-status">Cargando inventario…</p>
                  ) : null}
                  {l2aError ? <p className="rgb-gallery-error">{l2aError}</p> : null}
                  {!l2aInventoryLoading && l2aInventory ? (
                    <>
                      <p className="l2a-downloads-hint">
                        Carpeta escaneada: <code>{l2aInventory.downloads_dir}</code>
                      </p>
                      <button
                        type="button"
                        className="l2a-back-to-browse"
                        onClick={() => {
                          setL2aUiStep("question");
                          setL2aInventory(null);
                          setL2aError("");
                        }}
                      >
                        ← Volver al inicio
                      </button>
                      {!l2aInventory.exists ? (
                        <p className="l2a-downloads-empty">
                          Esta carpeta no existe o no es accesible.
                        </p>
                      ) : (
                        <>
                          <p className="l2a-downloads-intro">
                            Marca al menos <strong>un producto</strong> (ZIP o carpeta <code>.SAFE</code> de Sentinel-2)
                            para ejecutar el recorte al polígono.
                          </p>
                          {(() => {
                            const { selectable: otherPickable, plain: otherPlain } = partitionOtherTopLevelForL2a(
                              l2aInventory.other_top_level,
                            );
                            const zipRows = l2aInventory.zip_l2a || [];
                            const safeRows = l2aInventory.safe_folders || [];
                            const hasAnyRow =
                              zipRows.length > 0 || safeRows.length > 0 || otherPickable.length > 0;
                            return (
                              <>
                                <ul className="l2a-downloads-list">
                                  {zipRows.map((z) => (
                                    <li key={`zip:${z.name}`}>
                                      <label className="l2a-downloads-row">
                                        <input
                                          type="checkbox"
                                          checked={l2aSelected.has(z.name)}
                                          onChange={() => toggleL2aProduct(z.name)}
                                        />
                                        <span className="l2a-downloads-kind">ZIP</span>
                                        <span className="l2a-downloads-name" title={z.name}>
                                          {z.name}
                                          {z.weak_match ? (
                                            <span className="l2a-downloads-weak">
                                              {" "}
                                              (nombre poco típico; debe ser producto Sentinel-2)
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
                                          checked={l2aSelected.has(name)}
                                          onChange={() => toggleL2aProduct(name)}
                                        />
                                        <span className="l2a-downloads-kind">.SAFE</span>
                                        <span className="l2a-downloads-name" title={name}>
                                          {name}
                                        </span>
                                      </label>
                                    </li>
                                  ))}
                                  {otherPickable.map((item) => (
                                    <li key={`other:${item.kind}:${item.name}`}>
                                      <label className="l2a-downloads-row">
                                        <input
                                          type="checkbox"
                                          checked={l2aSelected.has(item.name)}
                                          onChange={() => toggleL2aProduct(item.name)}
                                        />
                                        <span className="l2a-downloads-kind">
                                          {item.kind === "zip" ? "ZIP" : ".SAFE"}
                                        </span>
                                        <span className="l2a-downloads-name" title={item.name}>
                                          {item.name}
                                        </span>
                                      </label>
                                    </li>
                                  ))}
                                </ul>
                                {!hasAnyRow ? (
                                  <p className="l2a-downloads-empty">
                                    No hay archivos <code>.zip</code> ni carpetas <code>.SAFE</code> en el primer nivel de
                                    esta carpeta.
                                  </p>
                                ) : null}
                                {otherPlain.length > 0 ? (
                                  <p className="l2a-downloads-other">
                                    Otros en la carpeta (no aplican al recorte): {otherPlain.join(", ")}
                                  </p>
                                ) : null}
                              </>
                            );
                          })()}
                        </>
                      )}
                    </>
                  ) : null}
                </>
              )}
              <div className="l2a-downloads-actions">
                <button type="button" className="rgb-gallery-btn-secondary" onClick={() => setL2aModalOpen(false)}>
                  Cerrar
                </button>
                {l2aUiStep === "pick" ? (
                  <button
                    type="button"
                    className="rgb-gallery-btn-primary"
                    disabled={
                      busy ||
                      !projectId ||
                      !token ||
                      !hasVectors ||
                      l2aSelected.size === 0 ||
                      l2aInventoryLoading ||
                      !l2aInventory?.exists
                    }
                    title={
                      !hasVectors
                        ? "Carga un lote vectorial en la pestaña Cargar"
                        : l2aSelected.size === 0
                          ? "Selecciona al menos un producto L2A"
                          : undefined
                    }
                    onClick={async () => {
                      const layerId = recorteLayerId ? Number(recorteLayerId) : undefined;
                      const names = [...l2aSelected];
                      const ok = await onS2L2aRecortes?.(layerId, names, l2aJobSourceSubpath);
                      if (ok) {
                        setL2aModalOpen(false);
                        setL2aSelected(new Set());
                      }
                    }}
                  >
                    Procesar recortes L2A
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <label>
        2) Visualización
        <select
          value={stackMode}
          onChange={(e) => {
            const v = e.target.value;
            setStackMode(v);
            if (v === "visual-cluster") {
              void openClusterGmmResultsOrHint();
            }
          }}
        >
          <option value="visual-rgb">Visual RGB (serie temporal)</option>
          <option value="visual-index">Visual índices (serie temporal)</option>
          <option value="visual-cluster">Visual cluster</option>
        </select>
      </label>
      {clusterPeekHint ? (
        <p className="prepro-hint" role="status">
          {clusterPeekHint}
        </p>
      ) : null}
      {loadingClusterPersisted ? (
        <p className="prepro-hint" role="status">
          Cargando resultados GMM desde cluster_gmm/…
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          if (stackMode === "visual-cluster") {
            void openClusterGmmResultsOrHint();
          } else {
            setGalleryMode("view");
            setGalleryOpen(true);
          }
        }}
        disabled={!projectId || !token || loadingClusterPersisted}
      >
        {stackMode === "visual-rgb"
          ? "Abrir galería RGB (serie temporal)"
          : stackMode === "visual-index"
            ? "Abrir galería de índices (serie temporal)"
            : "Abrir visualización de clusters GMM"}
      </button>

      <div className="indices-section">
        <div className="indices-section-title">
          <strong>3) Índices (Sentinel-2)</strong>
          <span className="indices-section-hint">
            Desde recortes L2A (6 bandas): stacks en <code>indices/&lt;INDICE&gt;/</code>, una banda por
            fecha.
          </span>
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

      <div className="cluster-actions-row">
        <button
          type="button"
          onClick={() => setClusterModalOpen(true)}
          disabled={busy || !projectId || !token}
        >
          4) Cluster
        </button>
        <button
          type="button"
          className="cluster-open-results-btn"
          disabled={busy || !projectId || !token || loadingClusterPersisted}
          onClick={() => void openClusterGmmResultsOrHint()}
        >
          Ver resultados GMM
        </button>
      </div>

      <div className="indices-section">
        <div className="indices-section-title">
          <strong>5) Series tiempo</strong>
          <span className="indices-section-hint">
            Mismas escenas L2A (6 bandas) que en el paso 3: medias espaciales de los cinco índices por fecha,
            con media temporal y ±1σ (espacial y temporal).
          </span>
        </div>
        <button
          type="button"
          className="indices-run-btn"
          onClick={() => {
            setVtsError("");
            setGalleryMode("timeSeriesSelect");
            setGalleryOpen(true);
          }}
          disabled={busy || !projectId || !token}
        >
          Seleccionar escenas
        </button>
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
              <button
                type="button"
                className="index-modal-close"
                onClick={() => setClusterModalOpen(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body cluster-flow-body">
              <p className="cluster-flow-intro">
                Se analiza cada stack de índices (NDVI, EVI, …) y{" "}
                <strong>todos</strong> los GeoTIFF con ≥6 bandas en <code>recortes/</code>. Primero
                el método del codo (KMeans) en una sola fila; luego indica una única K y ejecuta GMM
                (la misma para todos los datasets). Los mapas de salida se abren en otra ventana al
                terminar.
              </p>
              <div className="cluster-flow-toolbar">
                <button
                  type="button"
                  className="indices-run-btn"
                  onClick={() => onClusterElbow?.()}
                  disabled={clusterElbowLoading || !projectId || !token}
                >
                  {clusterElbowLoading ? "Calculando codo…" : "Calcular método del codo"}
                </button>
                {clusterElbowResults?.datasets?.length ? (
                  <>
                    <label className="cluster-unified-k-label">
                      K para todos los datasets (1–30)
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={gmmK}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setGmmK(Number.isFinite(n) ? Math.max(1, Math.min(30, Math.round(n))) : 1);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="indices-run-btn"
                      onClick={async () => {
                        if (!onClusterGmm || !clusterElbowResults?.datasets?.length) return;
                        const k = Math.max(1, Math.min(30, Math.round(Number(gmmK)) || 1));
                        const kByKey = Object.fromEntries(
                          clusterElbowResults.datasets.map((d) => [d.key, k])
                        );
                        await onClusterGmm(kByKey);
                      }}
                      disabled={
                        clusterGmmLoading ||
                        !clusterElbowResults?.datasets?.length ||
                        !Number.isFinite(gmmK) ||
                        gmmK < 1
                      }
                    >
                      {clusterGmmLoading ? "Ejecutando GMM…" : "Ejecutar GMM"}
                    </button>
                  </>
                ) : null}
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
                      <p className="cluster-meta">
                        K sugerido (referencia): {d.suggested_k} · Train: {d.n_train_pixels} px ·{" "}
                        {d.n_features} feat.
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
            <div className="index-modal-header cluster-modal-header-tools cluster-results-modal-header">
              <h3 id="cluster-results-title">Resultados — clusters GMM</h3>
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
        indexCatalog={INDEX_CATALOG}
        selectedIndices={selectedIndices}
        onSelectedIndicesChange={setSelectedIndices}
        onClose={() => setGalleryOpen(false)}
        canEstimate={selectedIndices.length > 0}
        onEstimateIndices={(payload) => {
          if (
            payload &&
            typeof payload === "object" &&
            Array.isArray(payload.recorteFilenames)
          ) {
            onS2IndexStacks?.([], { recorteFilenames: payload.recorteFilenames });
          } else {
            onS2IndexStacks?.(payload);
          }
          setGalleryOpen(false);
        }}
        onTimeSeries={async (ids) => {
          if (!token || !projectId || !ids?.length) return;
          setVtsLoading(true);
          setVtsError("");
          try {
            setAuthToken(token);
            const res = await api.post("/preprocess/vegetation-time-series", {
              project_id: Number(projectId),
              raster_layer_ids: ids,
            });
            setVtsData(res.data);
            setGalleryOpen(false);
            setVtsModalOpen(true);
          } catch (e) {
            setVtsError(formatApiErrorDetail(e));
          } finally {
            setVtsLoading(false);
          }
        }}
        projectId={projectId}
        token={token}
      />

      {vtsModalOpen && vtsData ? (
        <div
          className="index-modal-overlay vts-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vts-modal-title"
          onClick={() => {
            setVtsModalOpen(false);
            setVtsData(null);
          }}
        >
          <div className="index-modal vts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="index-modal-header">
              <h3 id="vts-modal-title">Series de tiempo — índices de vegetación</h3>
              <button
                type="button"
                className="index-modal-close"
                onClick={() => {
                  setVtsModalOpen(false);
                  setVtsData(null);
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="index-modal-body vts-modal-body">
              <VegetationTimeSeriesCharts data={vtsData} />
            </div>
          </div>
        </div>
      ) : null}

      {vtsLoading ? (
        <div className="vts-loading-toast" role="status">
          Calculando series de tiempo…
        </div>
      ) : null}
      {vtsError ? (
        <div className="status-msg vts-error-msg" role="alert">
          {vtsError}
        </div>
      ) : null}
    </>
  );
}
