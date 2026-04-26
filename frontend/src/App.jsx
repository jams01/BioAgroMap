import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api, {
  clearAuthTokens,
  formatApiErrorDetail,
  loadStoredAuth,
  persistAuthTokens,
  setAuthToken,
} from "./api";
import useMapLayers from "./hooks/useMapLayers";
import {
  kmlToGeojson,
  kmzToGeojson,
  bboxFromGeojson,
  bboxFromBoundsWgs84,
  formatRecorteDisplayName,
} from "./utils/geo";
import Sidebar from "./components/Sidebar";
import MapView from "./components/MapView";
import AdvancedDashboard from "./components/dashboard/AdvancedDashboard";
import UserManagementModal from "./components/UserManagementModal";
import StudyRequestModal from "./components/StudyRequestModal";
import AdminStudyOrdersModal from "./components/AdminStudyOrdersModal";
import { INDEX_CATALOG, INDEX_CATALOG_PS } from "./components/PreprocessPanel";

const INDEX_IDS_S2 = new Set(
  INDEX_CATALOG.filter((o) => o.id !== "TODOS").map((o) => o.id)
);
const INDEX_IDS_PS = new Set(
  INDEX_CATALOG_PS.filter((o) => o.id !== "TODOS").map((o) => o.id)
);

function normalizeUserRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "client") return "cliente";
  return value;
}

/** Sentinel-2 ZIP antiguo: una capa por banda (B02…B08). Ocultar; solo vistas RGB/NIR. */
function isLegacyS2ZipBandRaster(meta) {
  if (!meta) return false;
  return !!(meta.s2_band_pack && meta.band && !meta.composite_kind);
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const mapRef = useRef(null);
  const indexStacksVariantRef = useRef("s2");
  const [token, setToken] = useState("");
  const [userRole, setUserRole] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [baseStyle, setBaseStyle] = useState("vectorial");
  const [projectName, setProjectName] = useState("");
  const [loteFile, setLoteFile] = useState(null);
  const [rasterFile, setRasterFile] = useState(null);
  const [downloadSource, setDownloadSource] = useState("sentinel-1");
  const [selectedIndices, setSelectedIndices] = useState([]);
  const [stackMode, setStackMode] = useState("visual-rgb");
  const [targetRasterId, setTargetRasterId] = useState("");
  const [s2Download, setS2Download] = useState(null);
  const [s1Download, setS1Download] = useState(null);
  const [recorteTaskId, setRecorteTaskId] = useState("");
  /** "s1" | "s2" | "ps" | "" — para mensajes mientras Celery ejecuta el recorte. */
  const [recorteKind, setRecorteKind] = useState("");
  const [indexStacksTaskId, setIndexStacksTaskId] = useState("");
  const [psExtractTaskId, setPsExtractTaskId] = useState("");
  const [s1SarStacksTaskId, setS1SarStacksTaskId] = useState("");
  /** Incrementa para abrir la galería «Visual índices» al terminar la estimación. */
  const [visualIndexGalleryKick, setVisualIndexGalleryKick] = useState(0);
  const [visualIndexGalleryKickPs, setVisualIndexGalleryKickPs] = useState(0);
  const [sidebarTab, setSidebarTab] = useState("admin");
  const [recorteLayerId, setRecorteLayerId] = useState("");
  const [preproGalleryKick, setPreproGalleryKick] = useState(0);
  const [preproClusterVizKick, setPreproClusterVizKick] = useState(0);
  const [preproClusterVizKickPs, setPreproClusterVizKickPs] = useState(0);
  const [clusterElbowLoading, setClusterElbowLoading] = useState(false);
  const [clusterGmmLoading, setClusterGmmLoading] = useState(false);
  const [clusterElbowResults, setClusterElbowResults] = useState(null);
  const [clusterGmmResults, setClusterGmmResults] = useState(null);
  const [clusterElbowResultsPs, setClusterElbowResultsPs] = useState(null);
  const [clusterGmmResultsPs, setClusterGmmResultsPs] = useState(null);
  const [clusterElbowResultsS1, setClusterElbowResultsS1] = useState(null);
  const [clusterGmmResultsS1, setClusterGmmResultsS1] = useState(null);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [userMgmtOpen, setUserMgmtOpen] = useState(false);
  const [authStep, setAuthStep] = useState("email");
  const [pendingRegEmail, setPendingRegEmail] = useState("");
  const [otpDebug, setOtpDebug] = useState(null);
  const [studyRequestOpen, setStudyRequestOpen] = useState(false);
  const [studyOrdersOpen, setStudyOrdersOpen] = useState(false);
  const [studyDraw, setStudyDraw] = useState(null);
  const normalizedUserRole = normalizeUserRole(userRole);
  const isAdmin = normalizedUserRole === "admin";
  const isCliente = normalizedUserRole === "cliente";

  const finalizeStudyPolygon = useCallback(() => {
    setStudyDraw((d) => {
      if (!d?.active || d.mode !== "polygon") return d;
      return { ...d, finalizePolygonKey: (d.finalizePolygonKey || 0) + 1 };
    });
  }, []);

  function requireAdminAction() {
    if (!token) {
      setMessage("Debes iniciar sesion.");
      return false;
    }
    if (!isAdmin) {
      setMessage("Acceso restringido: esta accion requiere rol admin.");
      return false;
    }
    return true;
  }

  useEffect(() => {
    setS2Download(null);
    setS1Download(null);
    setClusterElbowResults(null);
    setClusterGmmResults(null);
    setClusterElbowResultsPs(null);
    setClusterGmmResultsPs(null);
    setClusterElbowResultsS1(null);
    setClusterGmmResultsS1(null);
    setRecorteLayerId("");
    setRecorteKind("");
    setPsExtractTaskId("");
    setDashboardOpen(false);
    setUserMgmtOpen(false);
    setStudyRequestOpen(false);
    setStudyOrdersOpen(false);
    setStudyDraw(null);
  }, [projectId]);

  useEffect(() => {
    if (sidebarTab === "prepro") {
      setSelectedIndices((prev) =>
        prev.filter((id) => id === "TODOS" || INDEX_IDS_S2.has(id))
      );
    } else if (sidebarTab === "ps") {
      setSelectedIndices((prev) =>
        prev.filter((id) => id === "TODOS" || INDEX_IDS_PS.has(id))
      );
    }
  }, [sidebarTab]);

  useEffect(() => {
    const { access, refresh } = loadStoredAuth();
    if (access && refresh) {
      setToken(access);
      persistAuthTokens(access, refresh);
    }
  }, []);

  useEffect(() => {
    if (!token) {
      setUserRole("");
      return;
    }
    let cancelled = false;
    const loadMe = async () => {
      try {
        setAuthToken(token);
        const res = await api.get("/auth/me");
        if (!cancelled) setUserRole(normalizeUserRole(res.data?.role));
      } catch (_) {
        if (!cancelled) setUserRole("");
      }
    };
    loadMe();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) {
      setSidebarTab("admin");
      return;
    }
    if (normalizedUserRole === "cliente") {
      setSidebarTab("dashboard");
    }
  }, [token, normalizedUserRole]);

  useEffect(() => {
    const onRefreshed = (e) => {
      if (e.detail?.access_token) setToken(e.detail.access_token);
    };
    const onExpired = () => {
      setToken("");
      setProjectId("");
      setProjects([]);
      setTargetRasterId("");
      setMessage("Sesion expirada. Vuelve a iniciar sesion.");
    };
    window.addEventListener("bioagromap:auth-refreshed", onRefreshed);
    window.addEventListener("bioagromap:auth-expired", onExpired);
    return () => {
      window.removeEventListener("bioagromap:auth-refreshed", onRefreshed);
      window.removeEventListener("bioagromap:auth-expired", onExpired);
    };
  }, []);

  useEffect(() => {
    if (!s2Download || s2Download.ui_status !== "downloading" || !projectId || !token) {
      return undefined;
    }
    const rasterId = s2Download.rasterId;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/sentinel-status/${projectId}/${rasterId}`);
        const st = r.data.ui_status;
        setS2Download((prev) => {
          if (!prev || prev.rasterId !== rasterId) return prev;
          return {
            ...prev,
            progress: r.data.progress ?? prev.progress,
            message: r.data.message ?? prev.message,
            ui_status: st,
            totalDownloaded: r.data.total_downloaded ?? prev.totalDownloaded,
            totalSizeMb: r.data.total_size_mb ?? prev.totalSizeMb,
          };
        });
        if (st === "completed") {
          setMessage(
            `Sentinel-2: descarga terminada.${r.data.total_downloaded != null ? ` Archivos: ${r.data.total_downloaded}.` : ""}`
          );
        } else if (st === "failed") {
          setMessage(`Sentinel-2: ${r.data.message || "Error"}`);
        }
      } catch (_) {
        /* ignore transient errors */
      }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, [s2Download?.rasterId, s2Download?.ui_status, projectId, token]);

  useEffect(() => {
    if (!s1Download || s1Download.ui_status !== "downloading" || !projectId || !token) {
      return undefined;
    }
    const rasterId = s1Download.rasterId;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/sentinel-status/${projectId}/${rasterId}`);
        const st = r.data.ui_status;
        setS1Download((prev) => {
          if (!prev || prev.rasterId !== rasterId) return prev;
          return {
            ...prev,
            progress: r.data.progress ?? prev.progress,
            message: r.data.message ?? prev.message,
            ui_status: st,
            totalDownloaded: r.data.total_downloaded ?? prev.totalDownloaded,
            totalSizeMb: r.data.total_size_mb ?? prev.totalSizeMb,
            selectedRelativeOrbit: r.data.selected_relative_orbit ?? prev.selectedRelativeOrbit,
            selectedPassShort: r.data.selected_pass_short ?? prev.selectedPassShort,
            dateRangeStart: r.data.date_range_start ?? prev.dateRangeStart,
            dateRangeEnd: r.data.date_range_end ?? prev.dateRangeEnd,
            csvPath: r.data.csv_path ?? prev.csvPath,
          };
        });
        if (st === "completed") {
          const orb = r.data.selected_relative_orbit != null ? ` Órbita relativa ${r.data.selected_relative_orbit}` : "";
          const pass = r.data.selected_pass_short ? `, paso ${r.data.selected_pass_short}` : "";
          const dr =
            r.data.date_range_start && r.data.date_range_end
              ? ` Rango adquisición: ${r.data.date_range_start} → ${r.data.date_range_end}.`
              : "";
          setMessage(
            `Sentinel-1: descarga terminada.${orb}${pass}.${dr}${
              r.data.total_downloaded != null ? ` Productos: ${r.data.total_downloaded}.` : ""
            }`
          );
        } else if (st === "failed") {
          setMessage(`Sentinel-1: ${r.data.message || "Error"}`);
        }
      } catch (_) {
        /* ignore transient errors */
      }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, [s1Download?.rasterId, s1Download?.ui_status, projectId, token]);

  useEffect(() => {
    if (!recorteTaskId || !token || !projectId) {
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/task-status/${recorteTaskId}`);
        if (cancelled) return;
        if (r.data.ready && r.data.state === "SUCCESS") {
          const result = r.data.result || {};
          const pipeline = result.pipeline || "s2_l2a";
          const n = result.processed ?? 0;
          const errs = (result.errors || []).filter(Boolean);
          const errTxt = errs.length ? ` Detalle por producto: ${errs.join(" | ")}` : "";
          setRecorteTaskId("");
          setRecorteKind("");
          await selectProject(projectId, token);
          if (pipeline === "s1_grd") {
            const aoi = result.aoi || {};
            const aoiTxt =
              aoi.layer_name != null && String(aoi.layer_name).trim()
                ? ` Polígono: «${aoi.layer_name}».`
                : aoi.mode === "union_all_project_vectors"
                  ? " Polígono: unión de todos los lotes del proyecto."
                  : "";
            const engines = [
              ...new Set((result.results || []).map((x) => x && x.clip_engine).filter(Boolean)),
            ];
            const engTxt = engines.length ? ` Motor: ${engines.join(", ")}.` : "";
            const um = (result.user_message || "").trim();
            const polyOut = result.polygon_outside_scene === true;
            let head = "Proceso de recorte Sentinel-1 terminado. ";
            if (um) {
              head += um;
            } else if (polyOut) {
              head +=
                "El polígono no está dentro de la imagen (o la escena no cubre el lote) para al menos un producto.";
            } else if (n > 0) {
              head += `${n} GeoTIFF en recortes/S1/.`;
            } else {
              head += "Sin recortes nuevos.";
            }
            setMessage(`${head}${aoiTxt}${engTxt}${errTxt}`.trim());
          } else {
            const psNote = recorteKind === "ps" ? " Salida en rasterPS/." : "";
            setMessage(
              n > 0
                ? `Proceso de recorte L2A terminado.${psNote} ${n} GeoTIFF de 6 bandas añadido(s) como capa(s).${errTxt}`
                : `Proceso de recorte L2A terminado.${psNote} Sin nuevas capas.${errTxt || " Comprueba inventario L2A y polígono."}`
            );
          }
        } else if (r.data.ready && r.data.state === "FAILURE") {
          setRecorteTaskId("");
          setRecorteKind("");
          setMessage(`Proceso de recorte terminado con error: ${r.data.error || "fallo"}`);
        } else if (!r.data.ready) {
          const st = r.data.state || "PENDING";
          const label =
            recorteKind === "s1"
              ? "Recorte Sentinel-1"
              : recorteKind === "ps"
                ? "Recorte PS (rasterPS/)"
                : recorteKind === "s2"
                  ? "Recorte Sentinel-2 L2A"
                  : "Recorte";
          setMessage(
            `${label} en curso (Celery: ${st}). Al terminar se mostrará el resultado aquí. Tarea: ${recorteTaskId}`
          );
        }
      } catch (_) {
        /* ignorar errores transitorios al consultar Celery */
      }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [recorteTaskId, projectId, token]);

  useEffect(() => {
    if (!indexStacksTaskId || !token || !projectId) {
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/task-status/${indexStacksTaskId}`);
        if (cancelled) return;
        if (r.data.ready && r.data.state === "SUCCESS") {
          const result = r.data.result || {};
          const outs = result.outputs || {};
          const errList = result.errors || [];
          const parts = Object.entries(outs).map(([k, v]) => `${k}: ${v}`);
          const errTxt =
            errList.length > 0
              ? ` Escenas con avisos: ${errList.length}.`
              : "";
          setIndexStacksTaskId("");
          const pv = indexStacksVariantRef.current === "ps" ? "ps" : "s2";
          const idxNote = pv === "ps" ? " (indecesPS/)" : "";
          setMessage(
            Object.keys(outs).length > 0
              ? `Stacks de índices generados${idxNote} (${result.scene_count ?? "?"} escenas). ${parts.join(" | ")}${errTxt}`
              : `${result.message || "Sin archivos de salida; comprueba recortes L2A."}${errTxt}`
          );
          if (Object.keys(outs).length > 0) {
            setStackMode("visual-index");
            if (pv === "ps") {
              setSidebarTab("ps");
              setVisualIndexGalleryKickPs((k) => k + 1);
            } else {
              setSidebarTab("prepro");
              setVisualIndexGalleryKick((k) => k + 1);
            }
            await selectProject(projectId, token);
          }
        } else if (r.data.ready && r.data.state === "FAILURE") {
          setIndexStacksTaskId("");
          setMessage(`Error en stacks de índices: ${r.data.error || "fallo"}`);
        }
      } catch (_) {
        /* ignorar errores transitorios */
      }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [indexStacksTaskId, projectId, token]);

  useEffect(() => {
    if (!psExtractTaskId || !token || !projectId) {
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/task-status/${psExtractTaskId}`);
        if (cancelled) return;
        if (r.data.ready && r.data.state === "SUCCESS") {
          const result = r.data.result || {};
          const errs = (result.errors || []).filter(Boolean);
          const errTxt = errs.length ? ` Avisos: ${errs.join(" | ")}` : "";
          setPsExtractTaskId("");
          const n = result.processed ?? 0;
          const ok = result.ok !== false && n > 0;
          setMessage(
            ok
              ? `Extracción Planet PS terminada: ${n} composite(s) en recortesPS/.${errTxt}`
              : `${result.message || "Sin composites extraídos; revisa zips en rasterPS/."}${errTxt}`
          );
          if (ok) await selectProject(projectId, token);
        } else if (r.data.ready && r.data.state === "FAILURE") {
          setPsExtractTaskId("");
          setMessage(`Extracción PS falló: ${r.data.error || "error"}`);
        }
      } catch (_) {
        /* ignorar */
      }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [psExtractTaskId, projectId, token]);

  useEffect(() => {
    if (!s1SarStacksTaskId || !token || !projectId) {
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        setAuthToken(token);
        const r = await api.get(`/preprocess/task-status/${s1SarStacksTaskId}`);
        if (cancelled) return;
        if (r.data.ready && r.data.state === "SUCCESS") {
          const result = r.data.result || {};
          const outs = result.outputs || {};
          const errList = result.errors || [];
          const parts = Object.entries(outs).map(([k, v]) => `${k}: ${v}`);
          const errTxt = errList.length > 0 ? ` Escenas con avisos: ${errList.length}.` : "";
          setS1SarStacksTaskId("");
          setMessage(
            Object.keys(outs).length > 0
              ? `Stacks de índices SAR listos (${result.scene_count ?? "?"} escenas). ${parts.join(" | ")}${errTxt}`
              : `${result.message || "Sin archivos de salida; comprueba s1prepoceso/ (VV+VH dB)."}${errTxt}`
          );
          if (Object.keys(outs).length > 0) {
            setStackMode("visual-s1-sar-indices");
            await selectProject(projectId, token);
          }
        } else if (r.data.ready && r.data.state === "FAILURE") {
          setS1SarStacksTaskId("");
          setMessage(`Error en índices SAR: ${r.data.error || "fallo"}`);
        }
      } catch (_) {
        /* ignorar errores transitorios */
      }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [s1SarStacksTaskId, projectId, token]);

  const {
    mapLayers,
    mapLayersRef,
    setPendingDeletes,
    setDirty,
    addMapLayer,
    toggleLayerVisibility,
    setLayerVisibility,
    clearAllMapLayers,
  } = useMapLayers(mapRef);

  function paintLayerOnMap(lid, geojsonData) {
    const map = mapRef.current;
    if (!map || !geojsonData) return;
    const tryPaint = () => {
      if (map.getSource(lid)) return;
      map.addSource(lid, { type: "geojson", data: geojsonData });
      map.addLayer({
        id: lid,
        type: "fill",
        source: lid,
        paint: { "fill-color": "#2d6cdf", "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: lid + "_outline",
        type: "line",
        source: lid,
        paint: { "line-color": "#1a3f8c", "line-width": 2 },
      });
    };
    if (map.isStyleLoaded()) tryPaint();
    else map.once("styledata", tryPaint);
  }

  function zoomToLayer(lid) {
    const map = mapRef.current;
    if (!map) return;
    const layer = mapLayersRef.current.find((l) => l.id === lid);
    if (!layer) return;

    if (layer.bbox) {
      map.fitBounds(layer.bbox, { padding: 60, maxZoom: 17 });
      return;
    }
    if (layer.geojsonData) {
      const bbox = bboxFromGeojson(layer.geojsonData);
      if (bbox) { map.fitBounds(bbox, { padding: 60, maxZoom: 17 }); return; }
    }
    try {
      const src = map.getSource(lid);
      if (src) {
        const data = src._data || src.serialize?.()?.data;
        if (data) {
          const bbox = bboxFromGeojson(data);
          if (bbox) { map.fitBounds(bbox, { padding: 60, maxZoom: 17 }); return; }
        }
      }
    } catch (_) {}
    try {
      const features = map.querySourceFeatures(lid);
      if (features.length > 0) {
        const bbox = bboxFromGeojson({ type: "FeatureCollection", features });
        if (bbox) { map.fitBounds(bbox, { padding: 60, maxZoom: 17 }); return; }
      }
    } catch (_) {}
    if (layer.kind === "raster") {
      setMessage(
        "Esta capa raster no tiene extensión geográfica (CRS). Si es Sentinel-2, sube un ZIP de la carpeta .SAFE completa (no un solo JPG). También puedes usar un GeoTIFF/JP2 con CRS o volver a cargar el proyecto tras el procesamiento."
      );
      return;
    }
    setMessage("No se pudo calcular la extension de esta capa.");
  }

  async function fetchProjects(accessToken) {
    try {
      setAuthToken(accessToken);
      const res = await api.get("/projects");
      setProjects(res.data);
      return res.data;
    } catch (_) {
      setProjects([]);
      return [];
    }
  }

  async function fetchLayerGeojson(pid, layerId, accessToken) {
    try {
      setAuthToken(accessToken);
      const res = await api.get(`/layers/${pid}/${layerId}/geojson`);
      return res.data;
    } catch (_) {
      return null;
    }
  }

  async function selectProject(id, accessToken) {
    const tk = accessToken || token;
    clearAllMapLayers();
    setPendingDeletes([]);
    setDirty(false);
    setProjectId(id);
    setTargetRasterId("");
    setMessage("Cargando capas del proyecto...");
    setLoading(true);
    try {
      setAuthToken(tk);
      const [layersRes, rastersRes] = await Promise.all([
        api.get(`/layers/${id}`),
        api.get(`/raster/${id}`),
      ]);
      let firstBbox = null;
      const geojsonResults = await Promise.all(
        layersRes.data.map((layer) => fetchLayerGeojson(id, layer.id, tk))
      );
      layersRes.data.forEach((layer, i) => {
        const geojson = geojsonResults[i];
        const lid = addMapLayer(layer.name, "vector", geojson, layer.id);
        if (geojson) {
          paintLayerOnMap(lid, geojson);
          if (!firstBbox) firstBbox = bboxFromGeojson(geojson);
        }
      });
      for (const raster of rastersRes.data) {
        const m = raster.metadata || {};
        if (
          (m.source === "sentinel-2" || m.source === "sentinel-1") &&
          m.type === "download"
        ) {
          continue;
        }
        if (isLegacyS2ZipBandRaster(m)) continue;
        const rb = m.bounds_wgs84;
        const rbbox = bboxFromBoundsWgs84(rb);
        const title =
          formatRecorteDisplayName(raster.metadata, raster.name) || raster.name;
        addMapLayer(raster.name, "raster", null, raster.id, {
          ...(rbbox ? { bbox: rbbox } : {}),
          metadata: raster.metadata,
          displayName: title,
          append: true,
        });
        if (raster.id) setTargetRasterId(String(raster.id));
        if (rbbox && !firstBbox) firstBbox = rbbox;
      }
      if (firstBbox && mapRef.current) {
        mapRef.current.fitBounds(firstBbox, { padding: 60, maxZoom: 17 });
      }
      const visibleRasters = rastersRes.data.filter((r) => {
        const m = r.metadata || {};
        if ((m.source === "sentinel-2" || m.source === "sentinel-1") && m.type === "download")
          return false;
        if (isLegacyS2ZipBandRaster(m)) return false;
        return true;
      });
      const totalLayers = layersRes.data.length + visibleRasters.length;
      const proj = projects.find((p) => p.id === id);
      const projName = proj ? proj.name : `ID ${id}`;
      setMessage(
        totalLayers > 0
          ? `Proyecto "${projName}" seleccionado. ${totalLayers} capa(s) cargada(s).`
          : `Proyecto "${projName}" seleccionado. Sin capas aun.`
      );
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al cargar capas";
      setMessage(`Proyecto seleccionado pero error al cargar capas: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function updateProjectName(id, name) {
    if (!requireAdminAction()) return false;
    const trimmed = name.trim();
    if (!trimmed) {
      setMessage("Error: el nombre del proyecto no puede estar vacío.");
      return false;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      await api.patch(`/projects/${id}`, { name: trimmed });
      await fetchProjects(token);
      setMessage(`Proyecto renombrado a "${trimmed}".`);
      return true;
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function deleteProject(id) {
    if (!requireAdminAction()) return;
    const proj = projects.find((p) => p.id === id);
    const projName = proj ? proj.name : `ID ${id}`;
    if (!window.confirm(`Eliminar el proyecto "${projName}" y todas sus capas?`)) return;
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      await api.delete(`/projects/${id}`);
      if (Number(projectId) === id) {
        setProjectId("");
        setTargetRasterId("");
        clearAllMapLayers();
      }
      await fetchProjects(token);
      setMessage(`Proyecto "${projName}" eliminado.`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al eliminar proyecto";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function registerAndLogin() {
    const effectiveEmail = email.trim();
    const effectivePassword = password.trim();
    if (!effectiveEmail || !effectivePassword) {
      setMessage("Error: ingresa email y password para crear cuenta.");
      return;
    }
    setLoading(true);
    setMessage("");
    const tenantName = effectiveEmail.split("@")[1] || "default";
    try {
      const res = await api.post("/auth/register", {
        tenant_name: tenantName,
        email: effectiveEmail,
        password: effectivePassword,
      });
      const accessToken = res.data.access_token;
      setToken(accessToken);
      setUserRole(normalizeUserRole(res.data?.role));
      persistAuthTokens(accessToken, res.data.refresh_token);
      const userProjects = await fetchProjects(accessToken);
      setMessage(`Cuenta creada. ${userProjects.length} proyecto(s) encontrado(s).`);
      navigate("/app");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al crear cuenta";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function loginWithCredentials() {
    setLoading(true);
    setMessage("");
    const effectiveEmail = email.trim();
    const effectivePassword = password.trim();
    if (!effectiveEmail || !effectivePassword) {
      setMessage("Error: ingresa email y password para iniciar sesion.");
      setLoading(false);
      return;
    }
    try {
      const res = await api.post("/auth/login", {
        email: effectiveEmail,
        password: effectivePassword,
      });
      const accessToken = res.data.access_token;
      setToken(accessToken);
      setUserRole(normalizeUserRole(res.data?.role));
      persistAuthTokens(accessToken, res.data.refresh_token);
      const userProjects = await fetchProjects(accessToken);
      setMessage(`Sesion iniciada. ${userProjects.length} proyecto(s) encontrado(s).`);
      setAuthStep("email");
      setOtpDebug(null);
      setPendingRegEmail("");
      navigate("/app");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al iniciar sesion";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  function resetEmailAuthStep() {
    setAuthStep("email");
    setPendingRegEmail("");
    setOtpDebug(null);
    setPassword("");
    setMessage("");
  }

  async function continueEmailFlow() {
    const em = email.trim();
    if (!em) {
      setMessage("Ingrese su correo electrónico.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const r = await api.post("/auth/check-email", { email: em });
      if (r.data?.exists) {
        const isAdmin = !!r.data?.is_admin || String(r.data?.role || "").toLowerCase() === "admin";
        if (isAdmin) {
          setAuthStep("password");
          setMessage("Correo admin detectado. Ingrese su contraseña para continuar.");
        } else {
          const o = await api.post("/auth/request-otp", { email: em });
          setPendingRegEmail(em);
          setAuthStep("otp");
          setOtpDebug(o.data?.debug_otp ?? null);
          setMessage(
            o.data?.message ||
              "Se enviará un código de verificación a su correo."
          );
        }
      } else {
        const o = await api.post("/auth/request-otp", { email: em });
        setPendingRegEmail(em);
        setAuthStep("otp");
        setOtpDebug(o.data?.debug_otp ?? null);
        setMessage(
          o.data?.message ||
            "Se enviará un código de verificación a su correo."
        );
      }
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al comprobar el correo";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtpRegister(code) {
    const c = String(code || "").trim();
    if (!pendingRegEmail || !c) {
      setMessage("Ingrese el código recibido.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await api.post("/auth/verify-otp", { email: pendingRegEmail, code: c });
      const accessToken = res.data.access_token;
      setToken(accessToken);
      setUserRole(normalizeUserRole(res.data?.role));
      persistAuthTokens(accessToken, res.data.refresh_token);
      const userProjects = await fetchProjects(accessToken);
      const tpw = res.data.temporary_password;
      if (tpw) {
        setMessage(
          `Cuenta creada. Guarde su contraseña para próximos accesos: ${tpw} (${userProjects.length} proyecto(s).)`
        );
      } else {
        setMessage(`Código verificado. Sesión iniciada. ${userProjects.length} proyecto(s).`);
      }
      setAuthStep("email");
      setOtpDebug(null);
      setPendingRegEmail("");
      navigate("/app");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Código incorrecto o expirado";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  function logoutSession() {
    setToken("");
    setUserRole("");
    clearAuthTokens();
    setProjectId("");
    setProjects([]);
    setTargetRasterId("");
    setUserMgmtOpen(false);
    setStudyRequestOpen(false);
    setStudyOrdersOpen(false);
    setStudyDraw(null);
    setAuthStep("email");
    setPendingRegEmail("");
    setOtpDebug(null);
    clearAllMapLayers();
    setMessage("Sesion cerrada.");
    navigate("/");
  }

  async function createProject() {
    if (!requireAdminAction()) return;
    const finalName = projectName.trim();
    if (!finalName) {
      setMessage("Error: ingresa un nombre para el proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/projects", { name: finalName });
      await fetchProjects(token);
      setProjectName("");
      await selectProject(res.data.id, token);
      setMessage(`Proyecto "${finalName}" creado y seleccionado.`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al crear proyecto";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function uploadLote() {
    if (!requireAdminAction()) return null;
    if (!token || !projectId || !loteFile) {
      setMessage("Error: debes iniciar sesion, crear proyecto y seleccionar archivo de lote.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const form = new FormData();
      form.append("file", loteFile);
      const res = await api.post(`/upload-shapefile?project_id=${projectId}`, form);
      const layerId = res.data.layer_id;
      const fname = loteFile.name.toLowerCase();
      let geojson = null;
      try {
        if (fname.endsWith(".geojson") || fname.endsWith(".json")) {
          const text = await loteFile.text();
          geojson = JSON.parse(text);
        } else if (fname.endsWith(".kml")) {
          const text = await loteFile.text();
          geojson = kmlToGeojson(text);
        } else if (fname.endsWith(".kmz")) {
          geojson = await kmzToGeojson(loteFile);
        }
      } catch (_) {}
      if (!geojson) {
        geojson = await fetchLayerGeojson(projectId, layerId, token);
      }
      const lid = addMapLayer(loteFile.name, "vector", geojson, layerId);
      if (geojson) {
        paintLayerOnMap(lid, geojson);
        const bbox = bboxFromGeojson(geojson);
        if (bbox && mapRef.current) mapRef.current.fitBounds(bbox, { padding: 60, maxZoom: 17 });
      }
      setLoteFile(null);
      setMessage(`Lote cargado correctamente. Layer ID: ${layerId}`);
      return layerId;
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al subir lote";
      setMessage(`Error: ${detail}`);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function uploadRaster() {
    if (!requireAdminAction()) return;
    if (!token || !projectId || !rasterFile) {
      setMessage("Error: debes iniciar sesion, crear proyecto y seleccionar raster.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const form = new FormData();
      form.append("file", rasterFile);
      const res = await api.post(`/upload-raster?project_id=${projectId}`, form);
      const layers = res.data.layers;
      if (Array.isArray(layers) && layers.length > 0) {
        layers.forEach((L) => {
          if (mapLayersRef.current.some((x) => x.serverId === L.id)) return;
          const rbbox = bboxFromBoundsWgs84(L.metadata?.bounds_wgs84);
          addMapLayer(L.name, "raster", null, L.id, rbbox ? { bbox: rbbox } : {});
        });
        const nir = layers.find((x) => x.composite === "nir");
        const pick = nir || layers[layers.length - 1];
        setTargetRasterId(String(pick.id));
        setMessage(
          `Sentinel-2: 2 capas (${layers.map((x) => x.name).join(", ")}). TIF 4 bandas B04-B03-B02-B08 guardado en el proyecto; vistas RGB y NIR derivadas de ese archivo. Objetivo: NIR.`
        );
      } else {
        setTargetRasterId(String(res.data.raster_layer_id));
        const meta = res.data.metadata || {};
        const rbbox = bboxFromBoundsWgs84(meta.bounds_wgs84);
        addMapLayer(rasterFile.name, "raster", null, res.data.raster_layer_id, rbbox ? { bbox: rbbox } : {});
        setMessage(
          rbbox
            ? `Raster cargado correctamente (ID ${res.data.raster_layer_id}).`
            : `Raster registrado (ID ${res.data.raster_layer_id}). Sin CRS en el archivo: no se podrá acercar ni superponer hasta georreferenciar.`
        );
      }
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al subir raster";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function runAI() {
    if (!requireAdminAction()) return;
    if (!projectId || !targetRasterId) {
      setMessage("Error: define un raster objetivo para ejecutar IA.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      await api.post("/ai/predict", {
        project_id: Number(projectId),
        raster_layer_id: Number(targetRasterId),
        model_type: "ndvi-segmentation",
      });
      await api.get(`/ai/results/${projectId}`);
      setMessage("Inferencia ejecutada.");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al ejecutar IA";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function preprocessDownload(startDate, endDate, layerId, s1AoiFile) {
    if (!requireAdminAction()) return;
    if (!token || !projectId) {
      setMessage("Error: debes iniciar sesion y crear proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      if (downloadSource === "sentinel-1") {
        const fd = new FormData();
        fd.append("project_id", String(projectId));
        fd.append("start_date", startDate);
        fd.append("end_date", endDate);
        if (layerId) {
          fd.append("layer_id", String(layerId));
        }
        if (s1AoiFile) {
          fd.append("aoi_file", s1AoiFile);
        }
        const res = await api.post("/preprocess/sentinel1-download", fd);
        if (res.data.status === "downloading") {
          setS1Download({
            rasterId: res.data.raster_layer_id,
            taskId: res.data.task_id,
            progress: 0,
            message: "Iniciando descarga Sentinel-1 (GRD IW, Copernicus)…",
            ui_status: "downloading",
          });
          setMessage(`Descarga Sentinel-1 en curso (registro #${res.data.raster_layer_id})`);
        }
        return;
      }

      const body = {
        project_id: Number(projectId),
        source: downloadSource,
      };
      if (downloadSource === "sentinel-2") {
        body.start_date = startDate;
        body.end_date = endDate;
      }
      if (layerId) {
        body.layer_id = Number(layerId);
      }
      const res = await api.post("/preprocess/download", body);
      if (downloadSource !== "sentinel-2") {
        setTargetRasterId(String(res.data.raster_layer_id));
        addMapLayer(`${downloadSource}.tif`, "raster", null, res.data.raster_layer_id);
      }
      if (res.data.status === "downloading" && downloadSource === "sentinel-2") {
        setS2Download({
          rasterId: res.data.raster_layer_id,
          taskId: res.data.task_id,
          progress: 0,
          message: "Iniciando descarga Sentinel-2...",
          ui_status: "downloading",
        });
        setMessage(`Descarga Sentinel-2 en curso (raster #${res.data.raster_layer_id})`);
      } else if (res.data.status === "downloading") {
        setMessage(`Descarga iniciada. Raster ID: ${res.data.raster_layer_id}`);
      } else {
        setMessage(`Descarga completada. Raster ID: ${res.data.raster_layer_id}`);
      }
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en descarga";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function runS2L2aRecortes(layerId, productNames, sourceSubpath, pipelineVariant = "s2") {
    if (!requireAdminAction()) return false;
    if (!token || !projectId) {
      setMessage("Error: inicia sesion y selecciona un proyecto.");
      return false;
    }
    const names = Array.isArray(productNames)
      ? [...new Set(productNames.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (names.length === 0) {
      setMessage("Selecciona al menos un producto L2A (.zip o carpeta .SAFE) en la lista.");
      return false;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const body = {
        project_id: Number(projectId),
        product_names: names,
        pipeline_variant: pipelineVariant === "ps" ? "ps" : "s2",
      };
      if (sourceSubpath !== undefined) {
        body.source_subpath = sourceSubpath;
      }
      if (layerId != null && layerId !== "") {
        const n = Number(layerId);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          setMessage(
            "Error: el polígono elegido no tiene ID de capa válido en el servidor. Vuelve a cargar el proyecto o sube de nuevo el lote."
          );
          return false;
        }
        body.layer_id = n;
      }
      const res = await api.post("/preprocess/s2-l2a-recortes", body);
      setRecorteKind(pipelineVariant === "ps" ? "ps" : "s2");
      setRecorteTaskId(res.data.task_id);
      setMessage(
        `Recorte L2A en cola (tarea ${res.data.task_id}). Seguimiento: estado Celery cada pocos segundos hasta terminar.`
      );
      return true;
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function runS1GrdRecortes(layerId, productPaths) {
    if (!requireAdminAction()) return false;
    if (!token || !projectId) {
      setMessage("Error: inicia sesion y selecciona un proyecto.");
      return false;
    }
    const paths = Array.isArray(productPaths)
      ? [...new Set(productPaths.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (paths.length === 0) {
      setMessage("Selecciona al menos un producto Sentinel-1 (.zip o ruta .SAFE) en la lista.");
      return false;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const body = {
        project_id: Number(projectId),
        product_paths: paths,
      };
      if (layerId != null && layerId !== "") {
        const n = Number(layerId);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          setMessage(
            "Error: el polígono elegido no tiene ID de capa válido en el servidor. Vuelve a cargar el proyecto o sube de nuevo el lote."
          );
          return false;
        }
        body.layer_id = n;
      }
      const res = await api.post("/preprocess/sentinel1-recortes", body);
      setRecorteKind("s1");
      setRecorteTaskId(res.data.task_id);
      setMessage(
        `Recorte Sentinel-1 en cola (tarea ${res.data.task_id}). Se avisará al terminar (polígono fuera de escena, SNAP, etc.).`
      );
      return true;
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function runPsPlanetExtract() {
    if (!requireAdminAction()) return false;
    if (!token || !projectId) {
      setMessage("Error: inicia sesión y selecciona un proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/ps-planetscope-zip-extract", {
        project_id: Number(projectId),
      });
      setPsExtractTaskId(res.data.task_id);
      setMessage(`Extracción Planet PS en cola (tarea ${res.data.task_id}).`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runS2IndexStacks(explicitRasterIds, opts = {}) {
    if (!requireAdminAction()) return false;
    const pipelineVariant = opts.pipelineVariant === "ps" ? "ps" : "s2";
    const recorteFilenames = Array.isArray(opts?.recorteFilenames)
      ? [...new Set(opts.recorteFilenames.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (!token || !projectId) {
      setMessage("Error: inicia sesión y selecciona un proyecto.");
      return;
    }
    const indicesPayload = selectedIndices.length > 0 ? selectedIndices : [];
    if (!indicesPayload.length) {
      setMessage(
        "Selecciona al menos un índice en la ventana «Seleccionar escenas e estimar índices»."
      );
      return;
    }
    const ids = Array.isArray(explicitRasterIds)
      ? [...new Set(explicitRasterIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1))]
      : [];
    if (ids.length === 0 && recorteFilenames.length === 0) {
      setMessage(
        "Abre «Seleccionar escenas e estimar índices», marca escenas (archivos en recortes/) y pulsa Estimar índice."
      );
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const body = {
        project_id: Number(projectId),
        indices: indicesPayload,
        pipeline_variant: pipelineVariant,
      };
      if (recorteFilenames.length > 0) {
        body.recorte_filenames = recorteFilenames;
      } else {
        body.raster_layer_ids = ids;
      }
      indexStacksVariantRef.current = pipelineVariant;
      const res = await api.post("/preprocess/s2-index-stacks", body);
      setIndexStacksTaskId(res.data.task_id);
      setMessage(`Stacks de índices en cola (tarea ${res.data.task_id}).`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runS1SarIndexStacks({ sceneVvRelpaths, indices }) {
    if (!requireAdminAction()) return false;
    const paths = Array.isArray(sceneVvRelpaths)
      ? [...new Set(sceneVvRelpaths.map((s) => String(s).trim().replace(/\\/g, "/")).filter(Boolean))]
      : [];
    const idx = Array.isArray(indices)
      ? [...new Set(indices.map((s) => String(s).trim()).filter(Boolean))]
      : [];
    if (!token || !projectId) {
      setMessage("Error: inicia sesión y selecciona un proyecto.");
      return;
    }
    if (!idx.length) {
      setMessage("Selecciona al menos un índice SAR (o TODOS) en la ventana de estimación.");
      return;
    }
    if (!paths.length) {
      setMessage("Selecciona al menos una escena (miniatura) con par VV+VH en s1prepoceso/.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/s1-sar-index-stacks", {
        project_id: Number(projectId),
        indices: idx,
        scene_vv_relpaths: paths,
      });
      setS1SarStacksTaskId(res.data.task_id);
      setMessage(`Índices SAR en cola (tarea ${res.data.task_id}).`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runClusterElbow(pipelineVariant = "s2", selectedDates = []) {
    if (!requireAdminAction()) return;
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
      return;
    }
    const pv = pipelineVariant === "ps" ? "ps" : pipelineVariant === "s1" ? "s1" : "s2";
    const pickedDates = Array.isArray(selectedDates)
      ? [...new Set(selectedDates.map((d) => String(d).slice(0, 10)).filter(Boolean))]
      : [];
    setClusterElbowLoading(true);
    if (pv === "ps") setClusterGmmResultsPs(null);
    else if (pv === "s1") setClusterGmmResultsS1(null);
    else setClusterGmmResults(null);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/cluster-analysis/elbow", {
        project_id: Number(projectId),
        pipeline_variant: pv,
        selected_dates: pickedDates.length ? pickedDates : undefined,
        k_min: 1,
        k_max: 10,
        max_samples: 100_000,
        random_state: 42,
      });
      if (pv === "ps") setClusterElbowResultsPs(res.data);
      else if (pv === "s1") setClusterElbowResultsS1(res.data);
      else setClusterElbowResults(res.data);
      const n = res.data.datasets?.length ?? 0;
      setMessage(
        n > 0
          ? `Método del codo listo (${n} dataset(s)). Ajusta K y ejecuta GMM.`
          : "Sin resultados de codo."
      );
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setClusterElbowLoading(false);
    }
  }

  async function runClusterGmm(kByKey, pipelineVariant = "s2", selectedDates = []) {
    if (!requireAdminAction()) return;
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
      return;
    }
    const pv = pipelineVariant === "ps" ? "ps" : pipelineVariant === "s1" ? "s1" : "s2";
    const pickedDates = Array.isArray(selectedDates)
      ? [...new Set(selectedDates.map((d) => String(d).slice(0, 10)).filter(Boolean))]
      : [];
    setClusterGmmLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/cluster-analysis/gmm", {
        project_id: Number(projectId),
        pipeline_variant: pv,
        selected_dates: pickedDates.length ? pickedDates : undefined,
        k_by_key: kByKey,
        max_samples: 100_000,
        random_state: 42,
      });
      if (pv === "ps") setClusterGmmResultsPs(res.data);
      else if (pv === "s1") setClusterGmmResultsS1(res.data);
      else setClusterGmmResults(res.data);
      setMessage(`GMM terminado. Salidas en ${res.data.output_dir}`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setClusterGmmLoading(false);
    }
  }

  /** Resultados GMM ya guardados en ``cluster_gmm/`` o ``ClusterPS/`` (p. ej. otra sesión o tras reiniciar). */
  async function loadPersistedClusterGmm(pipelineVariant = "s2") {
    if (!token || !projectId) return null;
    const pv = pipelineVariant === "ps" ? "ps" : pipelineVariant === "s1" ? "s1" : "s2";
    setAuthToken(token);
    const res = await api.get(
      `/cluster-analysis/gmm-results/${projectId}?pipeline_variant=${encodeURIComponent(pv)}`
    );
    const data = res.data;
    if (data?.results?.length) {
      if (pv === "ps") setClusterGmmResultsPs(data);
      else if (pv === "s1") setClusterGmmResultsS1(data);
      else setClusterGmmResults(data);
    } else {
      if (pv === "ps") setClusterGmmResultsPs(null);
      else if (pv === "s1") setClusterGmmResultsS1(null);
      else setClusterGmmResults(null);
    }
    return data;
  }

  const dashboardProjectStatus = useMemo(() => {
    const p = projects.find((x) => Number(x.id) === Number(projectId));
    return p?.status;
  }, [projects, projectId]);

  return (
    <div className="layout">
      <Sidebar
        activeTab={sidebarTab}
        setActiveTab={setSidebarTab}
        recorteLayerId={recorteLayerId}
        setRecorteLayerId={setRecorteLayerId}
        preproGalleryKick={preproGalleryKick}
        preproClusterVizKick={preproClusterVizKick}
        preproClusterVizKickPs={preproClusterVizKickPs}
        onOpenPreproGallery={() => {
          setSidebarTab("prepro");
          setPreproGalleryKick((k) => k + 1);
        }}
        onOpenPreproClusterViz={() => {
          setSidebarTab("prepro");
          setPreproClusterVizKick((k) => k + 1);
        }}
        token={token}
        userRole={normalizedUserRole}
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        loading={loading}
        message={message}
        projects={projects}
        projectId={projectId}
        projectName={projectName}
        setProjectName={setProjectName}
        mapLayers={mapLayers}
        targetRasterId={targetRasterId}
        setTargetRasterId={setTargetRasterId}
        loteFile={loteFile}
        setLoteFile={setLoteFile}
        rasterFile={rasterFile}
        setRasterFile={setRasterFile}
        downloadSource={downloadSource}
        setDownloadSource={setDownloadSource}
        selectedIndices={selectedIndices}
        setSelectedIndices={setSelectedIndices}
        stackMode={stackMode}
        setStackMode={setStackMode}
        onLogin={loginWithCredentials}
        onLogout={logoutSession}
        onSelectProject={(id) => selectProject(id, token)}
        onCreateProject={createProject}
        onUpdateProject={updateProjectName}
        onDeleteProject={deleteProject}
        onToggleVisibility={toggleLayerVisibility}
        onZoomToLayer={zoomToLayer}
        onHideLayer={(lid) => setLayerVisibility(lid, false)}
        onOpenDashboard={() => {
          if (!isAdmin) {
            setMessage("Acceso restringido: dashboard avanzado solo para admin.");
            return;
          }
          setDashboardOpen(true);
        }}
        onOpenClientDashboard={() => {
          if (token) fetchProjects(token);
          if (!projectId) {
            setMessage("Seleccione un proyecto publicado para abrir el dashboard de resultados.");
            return;
          }
          setDashboardOpen(true);
        }}
        onOpenUserManagement={() => {
          if (!isAdmin) {
            setMessage("Acceso restringido: Gestion de usuarios solo para admin.");
            return;
          }
          setUserMgmtOpen(true);
        }}
        onOpenStudyRequest={() => {
          if (!token) {
            setMessage("Debe iniciar sesión.");
            return;
          }
          setStudyRequestOpen(true);
        }}
        onOpenStudyOrders={() => {
          if (!isAdmin) {
            setMessage("Solo administradores.");
            return;
          }
          setStudyOrdersOpen(true);
        }}
        authStep={authStep}
        otpDebug={otpDebug}
        onContinueEmail={continueEmailFlow}
        onVerifyOtp={verifyOtpRegister}
        onResetEmailStep={resetEmailAuthStep}
        onUploadLote={uploadLote}
        onUploadRaster={uploadRaster}
        onRunAI={runAI}
        onDownload={preprocessDownload}
        recortePipelineBusy={!!recorteTaskId}
        indexStacksBusy={!!indexStacksTaskId || !!s1SarStacksTaskId || !!psExtractTaskId}
        visualIndexGalleryKick={visualIndexGalleryKick}
        visualIndexGalleryKickPs={visualIndexGalleryKickPs}
        onS2L2aRecortes={(layerId, names, sub) => runS2L2aRecortes(layerId, names, sub, "s2")}
        onPsL2aRecortes={(layerId, names, sub) => runS2L2aRecortes(layerId, names, sub, "ps")}
        onS1GrdRecortes={runS1GrdRecortes}
        onS1SarIndexStacks={runS1SarIndexStacks}
        s1SarStacksBusy={!!s1SarStacksTaskId}
        onS2IndexStacks={(ids, opts) => runS2IndexStacks(ids, { ...opts, pipelineVariant: "s2" })}
        onPsIndexStacks={(ids, opts) => runS2IndexStacks(ids, { ...opts, pipelineVariant: "ps" })}
        clusterElbowLoading={clusterElbowLoading}
        clusterGmmLoading={clusterGmmLoading}
        clusterElbowResults={clusterElbowResults}
        clusterGmmResults={clusterGmmResults}
        clusterElbowResultsPs={clusterElbowResultsPs}
        clusterGmmResultsPs={clusterGmmResultsPs}
        clusterElbowResultsS1={clusterElbowResultsS1}
        clusterGmmResultsS1={clusterGmmResultsS1}
        onClusterElbow={() => runClusterElbow("s2")}
        onClusterGmm={(k) => runClusterGmm(k, "s2")}
        onClusterElbowPs={() => runClusterElbow("ps")}
        onClusterGmmPs={(k) => runClusterGmm(k, "ps")}
        onClusterElbowS1={(dates) => runClusterElbow("s1", dates)}
        onClusterGmmS1={(k, dates) => runClusterGmm(k, "s1", dates)}
        onLoadPersistedClusterGmm={() => loadPersistedClusterGmm("s2")}
        onLoadPersistedClusterGmmPs={() => loadPersistedClusterGmm("ps")}
        onLoadPersistedClusterGmmS1={() => loadPersistedClusterGmm("s1")}
        onPsPlanetExtract={runPsPlanetExtract}
        s2Download={s2Download}
        s1Download={s1Download}
      />
      <MapView
        mapRef={mapRef}
        mapLayers={mapLayers}
        mapLayersRef={mapLayersRef}
        projectId={projectId}
        token={token}
        baseStyle={baseStyle}
        setBaseStyle={setBaseStyle}
        studyDraw={studyDraw}
      />
      <AdvancedDashboard
        open={dashboardOpen && !!token && !!projectId && (isAdmin || isCliente)}
        onClose={() => setDashboardOpen(false)}
        token={token}
        projectId={projectId}
        isCliente={isCliente}
        projectStatus={dashboardProjectStatus}
      />
      <UserManagementModal
        open={userMgmtOpen && isAdmin}
        token={token}
        onClose={() => setUserMgmtOpen(false)}
        onStatusMessage={(msg) => setMessage(msg)}
      />
      <StudyRequestModal
        open={studyRequestOpen && !!token}
        token={token}
        onOrderSuccess={() => {
          if (token) fetchProjects(token);
        }}
        onClose={() => {
          setStudyRequestOpen(false);
          setStudyDraw(null);
        }}
        addMapLayer={addMapLayer}
        paintLayerOnMap={paintLayerOnMap}
        mapRef={mapRef}
        bboxFromGeojson={bboxFromGeojson}
        setStudyDraw={setStudyDraw}
        finalizeStudyPolygon={finalizeStudyPolygon}
        setMessage={setMessage}
        drawMode={studyDraw?.mode}
      />
      <AdminStudyOrdersModal
        open={studyOrdersOpen && isAdmin}
        token={token}
        onClose={() => setStudyOrdersOpen(false)}
        onStatusMessage={(msg) => setMessage(msg)}
      />
    </div>
  );
}
