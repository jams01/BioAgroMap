import { useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api, { setAuthToken } from "./api";
import useMapLayers from "./hooks/useMapLayers";
import { kmlToGeojson, kmzToGeojson, bboxFromGeojson } from "./utils/geo";
import Sidebar from "./components/Sidebar";
import MapView from "./components/MapView";

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
  const [indiceType, setIndiceType] = useState("NDVI");
  const [stackMode, setStackMode] = useState("visualizar");
  const [targetRasterId, setTargetRasterId] = useState("");

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
        addMapLayer(raster.name, "raster", null, raster.id);
        if (raster.id) setTargetRasterId(String(raster.id));
      }
      if (firstBbox && mapRef.current) {
        mapRef.current.fitBounds(firstBbox, { padding: 60, maxZoom: 17 });
      }
      const totalLayers = layersRes.data.length + rastersRes.data.length;
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
      setAuthToken(accessToken);
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
      setAuthToken(accessToken);
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
    setAuthToken(null);
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
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error al subir lote";
      setMessage(`Error: ${detail}`);
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
      setTargetRasterId(String(res.data.raster_layer_id));
      addMapLayer(rasterFile.name, "raster", null, res.data.raster_layer_id);
      setMessage(`Raster cargado correctamente. Raster ID: ${res.data.raster_layer_id}`);
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

  async function preprocessDownload() {
    if (!token || !projectId) {
      setMessage("Error: debes iniciar sesion y crear proyecto.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/download", {
        project_id: Number(projectId),
        source: downloadSource,
      });
      setTargetRasterId(String(res.data.raster_layer_id));
      addMapLayer(`${downloadSource}.tif`, "raster", null);
      setMessage(`Descarga completada. Raster ID: ${res.data.raster_layer_id}`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en descarga";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function preprocessCrop() {
    if (!token || !projectId || !targetRasterId) {
      setMessage("Error: define proyecto y raster objetivo.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/crop", {
        project_id: Number(projectId),
        raster_layer_id: Number(targetRasterId),
        crop_ratio: 0.6,
      });
      addMapLayer("Recorte", "raster", null);
      setMessage(`Recorte completado: ${res.data.output_path}`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en recorte";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function preprocessIndices() {
    if (!token || !projectId || !targetRasterId) {
      setMessage("Error: define proyecto y raster objetivo.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/indices", {
        project_id: Number(projectId),
        raster_layer_id: Number(targetRasterId),
        index_type: indiceType,
      });
      addMapLayer(`Indice ${res.data.index_type}`, "raster", null);
      setMessage(`${res.data.index_type} calculado: ${res.data.output_path}`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en indices";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function preprocessStack() {
    if (!token || !projectId) {
      setMessage("Error: define proyecto.");
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

  async function preprocessCluster() {
    if (!token || !projectId || !targetRasterId) {
      setMessage("Error: define proyecto y raster objetivo.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      setAuthToken(token);
      const res = await api.post("/preprocess/cluster", {
        project_id: Number(projectId),
        raster_layer_id: Number(targetRasterId),
        clusters: 4,
      });
      addMapLayer(`Cluster ${res.data.clusters}c`, "raster", null);
      setMessage(`Cluster ejecutado (${res.data.clusters} clases): ${res.data.output_path}`);
    } catch (error) {
      const detail = error?.response?.data?.detail || error.message || "Error en cluster";
      setMessage(`Error: ${detail}`);
    } finally {
      setLoading(false);
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
        indiceType={indiceType}
        setIndiceType={setIndiceType}
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
        onCrop={preprocessCrop}
        onIndices={preprocessIndices}
        onStack={preprocessStack}
        onCluster={preprocessCluster}
      />
      <MapView
        mapRef={mapRef}
        mapLayersRef={mapLayersRef}
        baseStyle={baseStyle}
        setBaseStyle={setBaseStyle}
      />
    </div>
  );
}
