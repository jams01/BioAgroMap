import { useEffect, useRef, useState } from "react";
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

/** Sentinel-2 ZIP antiguo: una capa por banda (B02…B08). Ocultar; solo vistas RGB/NIR. */
function isLegacyS2ZipBandRaster(meta) {
  if (!meta) return false;
  return !!(meta.s2_band_pack && meta.band && !meta.composite_kind);
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const mapRef = useRef(null);
  const [token, setToken] = useState("");
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
  const [stackMode, setStackMode] = useState("visualizar");
  const [targetRasterId, setTargetRasterId] = useState("");
  const [s2Download, setS2Download] = useState(null);
  const [recorteTaskId, setRecorteTaskId] = useState("");
  const [indexStacksTaskId, setIndexStacksTaskId] = useState("");
  const [clusterElbowLoading, setClusterElbowLoading] = useState(false);
  const [clusterGmmLoading, setClusterGmmLoading] = useState(false);
  const [clusterElbowResults, setClusterElbowResults] = useState(null);
  const [clusterGmmResults, setClusterGmmResults] = useState(null);

  useEffect(() => {
    setS2Download(null);
    setClusterElbowResults(null);
    setClusterGmmResults(null);
  }, [projectId]);

  useEffect(() => {
    const { access, refresh } = loadStoredAuth();
    if (access && refresh) {
      setToken(access);
      persistAuthTokens(access, refresh);
    }
  }, []);

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
          const n = result.processed ?? 0;
          const errs = (result.errors || []).filter(Boolean);
          const errTxt = errs.length ? ` Detalle: ${errs.join("; ")}` : "";
          setRecorteTaskId("");
          setMessage(
            n > 0
              ? `Recortes L2A: ${n} GeoTIFF de 6 bandas (B02,B03,B04,B05,B08,B11; B5/B11 a 10 m) añadido(s) como capa(s).${errTxt}`
              : `Pipeline terminado sin nuevas capas.${errTxt || " Comprueba inventario L2A y polígono."}`
          );
          await selectProject(projectId, token);
        } else if (r.data.ready && r.data.state === "FAILURE") {
          setRecorteTaskId("");
          setMessage(`Error en pipeline L2A: ${r.data.error || "fallo"}`);
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
          setMessage(
            Object.keys(outs).length > 0
              ? `Stacks de índices generados (${result.scene_count ?? "?"} escenas). ${parts.join(" | ")}${errTxt}`
              : `${result.message || "Sin archivos de salida; comprueba recortes L2A."}${errTxt}`
          );
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

  const {
    mapLayers,
    mapLayersRef,
    pendingDeletes,
    setPendingDeletes,
    dirty,
    setDirty,
    addMapLayer,
    removeMapLayer,
    toggleLayerVisibility,
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
        if (m.source === "sentinel-2" && m.type === "download") {
          continue;
        }
        if (isLegacyS2ZipBandRaster(m)) continue;
        if (m.s2_index_stack) continue;
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
        if (m.source === "sentinel-2" && m.type === "download") return false;
        if (isLegacyS2ZipBandRaster(m)) return false;
        if (m.s2_index_stack) return false;
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

  async function saveProject() {
    if (!token || !projectId) return;
    setLoading(true);
    setMessage("Guardando proyecto...");
    try {
      setAuthToken(token);
      for (const del of pendingDeletes) {
        const url = del.kind === "raster"
          ? `/raster/${projectId}/${del.serverId}`
          : `/layers/${projectId}/${del.serverId}`;
        await api.delete(url);
      }
      setPendingDeletes([]);
      setDirty(false);
      setMessage("Proyecto guardado correctamente.");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al guardar";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function deleteProject(id) {
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
      persistAuthTokens(accessToken, res.data.refresh_token);
      const userProjects = await fetchProjects(accessToken);
      setMessage(`Sesion iniciada. ${userProjects.length} proyecto(s) encontrado(s).`);
      navigate("/app");
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al iniciar sesion";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  function logoutSession() {
    setToken("");
    clearAuthTokens();
    setProjectId("");
    setProjects([]);
    setTargetRasterId("");
    clearAllMapLayers();
    setMessage("Sesion cerrada.");
    navigate("/");
  }

  async function createProject() {
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

  async function preprocessDownload(startDate, endDate, layerId) {
    if (!token || !projectId) {
      setMessage("Error: debes iniciar sesion y crear proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
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

  async function fetchS2Inventory() {
    if (!token || !projectId) {
      setMessage("Error: inicia sesion y selecciona un proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const r = await api.get(`/raster/project-downloads-inventory/${projectId}`);
      const z = r.data.zip_l2a?.length ?? 0;
      const s = r.data.safe_folders?.length ?? 0;
      const o = r.data.other_top_level?.length
        ? ` Otros: ${r.data.other_top_level.join(", ")}.`
        : "";
      setMessage(
        r.data.exists
          ? `Inventario (${r.data.downloads_dir}): ${z} ZIP L2A, ${s} carpetas .SAFE.${o}`
          : `Aun no existe la carpeta de descargas (${r.data.downloads_dir}). Descarga Sentinel-2 desde Cargar primero.`
      );
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function runS2L2aRecortes(layerId) {
    if (!token || !projectId) {
      setMessage("Error: inicia sesion y selecciona un proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const body = { project_id: Number(projectId) };
      if (layerId != null && layerId !== "") {
        const n = Number(layerId);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          setMessage(
            "Error: el polígono elegido no tiene ID de capa válido en el servidor. Vuelve a cargar el proyecto o sube de nuevo el lote."
          );
          return;
        }
        body.layer_id = n;
      }
      const res = await api.post("/preprocess/s2-l2a-recortes", body);
      setRecorteTaskId(res.data.task_id);
      setMessage(`Pipeline L2A en curso (tarea ${res.data.task_id}). Puede tardar si hay varios productos.`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function runS2IndexStacks(explicitRasterIds) {
    if (!token || !projectId) {
      setMessage("Error: inicia sesión y selecciona un proyecto.");
      return;
    }
    if (!selectedIndices.length) {
      setMessage("Selecciona al menos un índice (o TODOS) en el desplegable.");
      return;
    }
    const ids = Array.isArray(explicitRasterIds)
      ? [...new Set(explicitRasterIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1))]
      : [];
    if (ids.length === 0) {
      setMessage(
        "Abre «Seleccionar escenas e estimar índices», marca las escenas con stack de 6 bandas y pulsa Estimar índice."
      );
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const body = {
        project_id: Number(projectId),
        indices: selectedIndices,
        raster_layer_ids: ids,
      };
      const res = await api.post("/preprocess/s2-index-stacks", body);
      setIndexStacksTaskId(res.data.task_id);
      setMessage(`Stacks de índices en cola (tarea ${res.data.task_id}).`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function preprocessStack() {
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
      return;
    }
    if (stackMode === "visual-rgb" || stackMode === "visual-index") {
      setMessage(
        "Abre la galería con el botón en Procesos (opción Visual RGB o Visual índices)."
      );
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/stack", {
        project_id: Number(projectId),
        mode: stackMode,
      });
      setMessage(`Stack ${res.data.mode} ejecutado correctamente.`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en stack";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function runClusterElbow() {
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
      return;
    }
    setClusterElbowLoading(true);
    setClusterGmmResults(null);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/cluster-analysis/elbow", {
        project_id: Number(projectId),
        k_min: 1,
        k_max: 10,
        max_samples: 100_000,
        random_state: 42,
      });
      setClusterElbowResults(res.data);
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

  async function runClusterGmm(kByKey) {
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
      return;
    }
    setClusterGmmLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/cluster-analysis/gmm", {
        project_id: Number(projectId),
        k_by_key: kByKey,
        max_samples: 100_000,
        random_state: 42,
      });
      setClusterGmmResults(res.data);
      setMessage(`GMM terminado. Salidas en ${res.data.output_dir}`);
    } catch (error) {
      setMessage(`Error: ${formatApiErrorDetail(error)}`);
    } finally {
      setClusterGmmLoading(false);
    }
  }

  return (
    <div className="layout">
      <Sidebar
        token={token}
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
        dirty={dirty}
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
        onRegister={registerAndLogin}
        onLogout={logoutSession}
        onSelectProject={(id) => selectProject(id, token)}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onToggleVisibility={toggleLayerVisibility}
        onZoomToLayer={zoomToLayer}
        onRemoveLayer={removeMapLayer}
        onSave={saveProject}
        onUploadLote={uploadLote}
        onUploadRaster={uploadRaster}
        onRunAI={runAI}
        onDownload={preprocessDownload}
        recortePipelineBusy={!!recorteTaskId}
        indexStacksBusy={!!indexStacksTaskId}
        onFetchS2Inventory={fetchS2Inventory}
        onS2L2aRecortes={runS2L2aRecortes}
        onS2IndexStacks={runS2IndexStacks}
        onStack={preprocessStack}
        clusterElbowLoading={clusterElbowLoading}
        clusterGmmLoading={clusterGmmLoading}
        clusterElbowResults={clusterElbowResults}
        clusterGmmResults={clusterGmmResults}
        onClusterElbow={runClusterElbow}
        onClusterGmm={runClusterGmm}
        s2Download={s2Download}
      />
      <MapView
        mapRef={mapRef}
        mapLayers={mapLayers}
        mapLayersRef={mapLayersRef}
        projectId={projectId}
        token={token}
        baseStyle={baseStyle}
        setBaseStyle={setBaseStyle}
      />
    </div>
  );
}
