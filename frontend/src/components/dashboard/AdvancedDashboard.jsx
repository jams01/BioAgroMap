import { useEffect, useMemo, useRef, useState } from "react";
import api, { API_URL, formatApiErrorDetail, loadStoredAuth, setAuthToken } from "../../api";
import SensorTimelapseViewer from "./SensorTimelapseViewer";
import VegetationTimeSeriesCharts from "../VegetationTimeSeriesCharts";
import ClimateTimeSeriesChart from "./ClimateTimeSeriesChart";

const SENSOR_META = {
  s1: { title: "Sentinel-1", variant: "s1", defaultIndex: "RVI" },
  s2: { title: "Sentinel-2", variant: "s2", defaultIndex: "NDVI" },
  ps: { title: "PlanetScope", variant: "ps", defaultIndex: "NDVI" },
};

/** Alinea índice elegido con claves del inventario (misma capitalización que el API, p. ej. CIre). */
function resolveInventoryIndexKey(indices, preferred) {
  if (!indices?.length) return null;
  if (preferred != null && preferred !== "" && indices.includes(preferred)) return preferred;
  if (preferred != null && preferred !== "") {
    const u = String(preferred).toUpperCase();
    for (const k of indices) {
      if (String(k).toUpperCase() === u) return k;
    }
  }
  return indices[0] ?? null;
}

function normIso(s) {
  return String(s || "").slice(0, 10);
}

/** Primeros YYYY-MM-DD de sort_key (p. ej. Planet con sufijo). */
function dateKeyFromSortKey(sortKey) {
  const m = String(sortKey || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function findRecortePathForSceneDate(items, sceneIso) {
  const t = normIso(sceneIso);
  if (!t || !items?.length) return null;
  for (const it of items) {
    if (dateKeyFromSortKey(it.sort_key) === t) return it.relative_path;
  }
  for (const it of items) {
    const sk = String(it.sort_key || "");
    if (sk.startsWith(t)) return it.relative_path;
  }
  /* PlanetScope: PS_dd-mm-yy.tif frente a sort_key ISO */
  const [y, mo, d] = t.split("-");
  if (y?.length === 4 && mo && d) {
    const yy = y.slice(2);
    const psNeedle = `${d}-${mo}-${yy}`;
    const compact = `${y}${mo}${d}`;
    for (const it of items) {
      const hay = `${it.basename || ""} ${it.relative_path || ""}`.toLowerCase();
      if (hay.includes(psNeedle) || hay.includes(compact)) return it.relative_path;
    }
  }
  return null;
}

function buildRecorteRgbEndpoint(projectId, relativePath, pipelineVariant) {
  const base = API_URL.replace(/\/$/, "");
  return `${base}/preprocess/recortes-preview/${projectId}?path=${encodeURIComponent(
    relativePath
  )}&pipeline_variant=${encodeURIComponent(pipelineVariant)}`;
}

/** Vista tipo «RGB» para S1: Sigma0 VV (SNAP/ENVI) bajo s1prepoceso/. */
function buildS1Sigma0PreviewEndpoint(projectId, relativePath) {
  const base = API_URL.replace(/\/$/, "");
  return `${base}/preprocess/s1-prepoceso-sigma0-vv-preview/${projectId}?path=${encodeURIComponent(
    relativePath
  )}&pol=vv&palette=spectral`;
}

function isS1RecorteItem(item) {
  const rp = String(item?.relative_path || "").replace(/\\/g, "/");
  return rp.startsWith("S1/") || rp.includes("/S1/");
}

function buildPreviewEndpoint(sensor, projectId, frame) {
  const base = API_URL.replace(/\/$/, "");
  if (sensor === "s1") {
    return `${base}/preprocess/s1-sar-index-stacks-preview/${projectId}?path=${encodeURIComponent(
      frame.relativePath
    )}&band=${frame.band}&index_palette=1`;
  }
  const pv = sensor === "ps" ? "ps" : "s2";
  return `${base}/preprocess/index-stacks-preview/${projectId}?path=${encodeURIComponent(
    frame.relativePath
  )}&band=${frame.band}&index_palette=1&pipeline_variant=${encodeURIComponent(pv)}`;
}

/**
 * Descarga el PNG del preview vía axios (mismo interceptor 401/refresh que el resto de la app).
 * `fetch` directo dejaba previews en blanco si el token del prop estaba desfasado respecto a sessionStorage.
 */
async function fetchPreviewObjectUrl(fullUrl, token) {
  const url = String(fullUrl || "").trim();
  if (!url) throw new Error("URL de preview vacía");
  const { access } = loadStoredAuth();
  const tok = access || token;
  if (tok) setAuthToken(tok);
  // 1) Preferimos axios para aprovechar interceptor de refresh.
  try {
    const resp = await api.get(url, { responseType: "blob" });
    const blob = resp?.data instanceof Blob ? resp.data : new Blob([resp?.data ?? ""]);
    if (blob.size > 0) {
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      // Forzamos MIME de imagen para evitar data:application/octet-stream no renderizable en <img>.
      return `data:image/png;base64,${b64}`;
    }
  } catch {
    // 2) Fallback directo por si hay edge-cases con axios + absolute URL.
  }
  const resp = await fetch(url, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
    cache: "no-store",
  });
  if (!resp.ok) throw new Error(`Preview ${resp.status}`);
  const blob = await resp.blob();
  if (!blob || blob.size === 0) throw new Error("Preview vacío");
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return `data:image/png;base64,${b64}`;
}

function safeRevokePreviewUrl(url) {
  if (typeof url !== "string" || !url.startsWith("blob:")) return;
  URL.revokeObjectURL(url);
}

export default function AdvancedDashboard({ open, onClose, token, projectId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sensorData, setSensorData] = useState({ s1: null, s2: null, ps: null });
  const [sensorActive, setSensorActive] = useState("s2");
  const [dateIdxBySensor, setDateIdxBySensor] = useState({ s1: 0, s2: 0, ps: 0 });
  const [indexBySensor, setIndexBySensor] = useState({ s1: "RVI", s2: "NDVI", ps: "NDVI" });
  const [playingBySensor, setPlayingBySensor] = useState({ s1: false, s2: false, ps: false });
  const [opacityBySensor, setOpacityBySensor] = useState({ s1: 1, s2: 1, ps: 1 });
  const [srcBySensor, setSrcBySensor] = useState({ s1: "", s2: "", ps: "" });
  const [rgbSrcBySensor, setRgbSrcBySensor] = useState({ s1: "", s2: "", ps: "" });
  const [recorteInventory, setRecorteInventory] = useState({ s2: [], ps: [] });
  const [s1PrepSigmaItems, setS1PrepSigmaItems] = useState([]);
  const [clusterBySensor, setClusterBySensor] = useState({ s1: [], s2: [], ps: [] });
  const [clusterVisible, setClusterVisible] = useState(true);
  const [selectedClusterKey, setSelectedClusterKey] = useState({ s1: "", s2: "", ps: "" });
  const [pointSelection, setPointSelection] = useState(null);
  const [roiSelection, setRoiSelection] = useState(null);
  const [roiMode, setRoiMode] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [seriesBySensor, setSeriesBySensor] = useState({ s1: null, s2: null, ps: null });
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [climateBySensor, setClimateBySensor] = useState({ s1: [], s2: [], ps: [] });
  const [climateVars, setClimateVars] = useState({
    precip: true,
    temp: true,
    humidity: false,
    radiation: false,
  });
  /** Mapas KMeans espacio-temporal PS: smart1 / smart2 / smart3. */
  const [psStCluster1Preview, setPsStCluster1Preview] = useState("");
  const [psStCluster1Busy, setPsStCluster1Busy] = useState(false);
  const [psStCluster1Error, setPsStCluster1Error] = useState("");
  const [psStCluster2Preview, setPsStCluster2Preview] = useState("");
  const [psStCluster2Busy, setPsStCluster2Busy] = useState(false);
  const [psStCluster2Error, setPsStCluster2Error] = useState("");
  const [psStCluster3Preview, setPsStCluster3Preview] = useState("");
  const [psStCluster3Busy, setPsStCluster3Busy] = useState(false);
  const [psStCluster3Error, setPsStCluster3Error] = useState("");

  const previewCacheRef = useRef(new Map());
  const seriesCacheRef = useRef(new Map());
  const recortesCacheRef = useRef({ s2: null, ps: null });
  const loadedProjectRef = useRef(null);
  const effectiveToken = token || loadStoredAuth().access || "";

  const frameFor = (sensor) => {
    const sd = sensorData[sensor];
    if (!sd) return null;
    const idxKey = indexBySensor[sensor] || sd.indices[0];
    const frames = sd.framesByIndex[idxKey] || [];
    return frames[dateIdxBySensor[sensor]] || null;
  };

  const framesFor = (sensor) => {
    const sd = sensorData[sensor];
    if (!sd) return [];
    const idxKey = indexBySensor[sensor] || sd.indices[0];
    return sd.framesByIndex[idxKey] || [];
  };

  // Evita estados fuera de rango (p. ej. recarga de inventario con menos escenas),
  // que podían dejar frame=null y vaciar previews ya cargados.
  useEffect(() => {
    if (!open) return;
    setDateIdxBySensor((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const sensor of ["s1", "s2", "ps"]) {
        const frames = framesFor(sensor);
        const maxIdx = Math.max(frames.length - 1, 0);
        const cur = Number(prev[sensor] ?? 0);
        const clamped = Math.min(Math.max(cur, 0), maxIdx);
        if (clamped !== cur) {
          next[sensor] = clamped;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [open, sensorData, indexBySensor]);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      const projectChanged = loadedProjectRef.current !== projectId;
      if (projectChanged) {
        for (const [, url] of previewCacheRef.current.entries()) safeRevokePreviewUrl(url);
        previewCacheRef.current.clear();
        setSrcBySensor({ s1: "", s2: "", ps: "" });
        setRgbSrcBySensor({ s1: "", s2: "", ps: "" });
        setSensorData({ s1: null, s2: null, ps: null });
        setRecorteInventory({ s2: [], ps: [] });
        setS1PrepSigmaItems([]);
        recortesCacheRef.current = { s2: null, ps: null };
        setPsStCluster1Preview("");
        setPsStCluster1Error("");
        setPsStCluster2Preview("");
        setPsStCluster2Error("");
        setPsStCluster3Preview("");
        setPsStCluster3Error("");
        setPsStCluster1Busy(false);
        setPsStCluster2Busy(false);
        setPsStCluster3Busy(false);
      }
      try {
        if (effectiveToken) setAuthToken(effectiveToken);
        const [s1Inv, s2Inv, psInv, s2Rec, psRec, s1PrepVv, c1, c2, c3] = await Promise.all([
          api.get(`/preprocess/s1-sar-index-stacks-inventory/${projectId}`),
          api.get(`/preprocess/index-stacks-inventory/${projectId}?pipeline_variant=s2`),
          api.get(`/preprocess/index-stacks-inventory/${projectId}?pipeline_variant=ps`),
          api.get(`/preprocess/recortes-inventory/${projectId}?pipeline_variant=s2`).catch(() => ({ data: { items: [] } })),
          api.get(`/preprocess/recortes-inventory/${projectId}?pipeline_variant=ps`).catch(() => ({ data: { items: [] } })),
          api.get(`/preprocess/s1-prepoceso-sigma0-vv-inventory/${projectId}?pol=vv`).catch(() => ({ data: { items: [] } })),
          api.get(`/cluster-analysis/gmm-results/${projectId}?pipeline_variant=s1`).catch(() => ({ data: { results: [] } })),
          api.get(`/cluster-analysis/gmm-results/${projectId}?pipeline_variant=s2`).catch(() => ({ data: { results: [] } })),
          api.get(`/cluster-analysis/gmm-results/${projectId}?pipeline_variant=ps`).catch(() => ({ data: { results: [] } })),
        ]);
        if (cancelled) return;

        function buildSensorInventory(rows, sensor) {
          const byIndex = {};
          for (const row of rows || []) {
            const key = String(row.index_key || "").trim();
            const dates = Array.isArray(row.band_dates) ? row.band_dates.map(normIso) : [];
            if (!key || !dates.length || !row.relative_path) continue;
            const current = byIndex[key];
            if (current && (current._score || 0) >= dates.length) continue;
            byIndex[key] = {
              _score: dates.length,
              frames: dates.map((d, i) => ({
                id: `${sensor}:${key}:${i + 1}:${row.relative_path}`,
                date: d,
                band: i + 1,
                relativePath: row.relative_path,
              })),
            };
          }
          const indices = Object.keys(byIndex).sort();
          const framesByIndex = Object.fromEntries(indices.map((k) => [k, byIndex[k].frames]));
          return { indices, framesByIndex };
        }

        const s1 = buildSensorInventory(s1Inv.data?.items || [], "s1");
        const s2 = buildSensorInventory(s2Inv.data?.items || [], "s2");
        const ps = buildSensorInventory(psInv.data?.items || [], "ps");
        const s2Items = s2Rec.data?.items || [];
        const psItems = psRec.data?.items || [];
        recortesCacheRef.current.s2 = s2Items.map((x) => x.relative_path).filter(Boolean);
        recortesCacheRef.current.ps = psItems.map((x) => x.relative_path).filter(Boolean);
        setRecorteInventory({ s2: s2Items, ps: psItems });
        setS1PrepSigmaItems(s1PrepVv.data?.items || []);
        setSensorData({ s1, s2, ps });
        setIndexBySensor((prev) => ({
          s1: resolveInventoryIndexKey(s1.indices, prev.s1) ?? s1.indices[0] ?? SENSOR_META.s1.defaultIndex,
          s2: resolveInventoryIndexKey(s2.indices, prev.s2) ?? s2.indices[0] ?? SENSOR_META.s2.defaultIndex,
          ps: resolveInventoryIndexKey(ps.indices, prev.ps) ?? ps.indices[0] ?? SENSOR_META.ps.defaultIndex,
        }));
        setClusterBySensor({
          s1: c1.data?.results || [],
          s2: c2.data?.results || [],
          ps: c3.data?.results || [],
        });
        setSelectedClusterKey({
          s1: c1.data?.results?.[0]?.key || "",
          s2: c2.data?.results?.[0]?.key || "",
          ps: c3.data?.results?.[0]?.key || "",
        });
        loadedProjectRef.current = projectId;
      } catch (e) {
        if (!cancelled) setError(formatApiErrorDetail(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, effectiveToken]);

  /** Al abrir el dashboard: ejecuta pipeline + preview para smart1, smart2 y smart3 (secuencial). */
  const smartClusterAutoRunIdRef = useRef(0);
  useEffect(() => {
    if (!open || !projectId || !effectiveToken) return;
    const runId = ++smartClusterAutoRunIdRef.current;
    let cancelled = false;
    const base = API_URL.replace(/\/$/, "");

    const slot = (preset) =>
      preset === "smart3"
        ? {
            setBusy: setPsStCluster3Busy,
            setErr: setPsStCluster3Error,
            setPreview: setPsStCluster3Preview,
          }
        : preset === "smart2"
          ? {
              setBusy: setPsStCluster2Busy,
              setErr: setPsStCluster2Error,
              setPreview: setPsStCluster2Preview,
            }
          : {
              setBusy: setPsStCluster1Busy,
              setErr: setPsStCluster1Error,
              setPreview: setPsStCluster1Preview,
            };

    (async () => {
      if (effectiveToken) setAuthToken(effectiveToken);
      for (const preset of ["smart1", "smart2", "smart3"]) {
        if (cancelled || runId !== smartClusterAutoRunIdRef.current) return;
        const { setBusy, setErr, setPreview } = slot(preset);
        setBusy(true);
        setErr("");
        try {
          await api.post(
            `/preprocess/ps-spatiotemporal-cluster/${projectId}`,
            { n_clusters: 4, random_state: 42 },
            { params: { preset } }
          );
          if (cancelled || runId !== smartClusterAutoRunIdRef.current) return;
          const dataUrl = await fetchPreviewObjectUrl(
            `${base}/preprocess/ps-spatiotemporal-cluster-preview/${projectId}?preset=${encodeURIComponent(preset)}`,
            effectiveToken
          );
          if (!cancelled && runId === smartClusterAutoRunIdRef.current) setPreview(dataUrl);
        } catch (e) {
          if (!cancelled && runId === smartClusterAutoRunIdRef.current) {
            setErr(formatApiErrorDetail(e));
            setPreview("");
          }
        } finally {
          if (!cancelled && runId === smartClusterAutoRunIdRef.current) setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      setPsStCluster1Busy(false);
      setPsStCluster2Busy(false);
      setPsStCluster3Busy(false);
    };
  }, [open, projectId, effectiveToken]);

  useEffect(() => {
    if (!open) return;
    const timers = [];
    for (const sensor of ["s1", "s2", "ps"]) {
      if (!playingBySensor[sensor]) continue;
      const t = window.setInterval(() => {
        const frames = framesFor(sensor);
        if (!frames.length) return;
        setDateIdxBySensor((prev) => ({
          ...prev,
          [sensor]: (prev[sensor] + 1) % frames.length,
        }));
      }, 1400);
      timers.push(t);
    }
    return () => timers.forEach((t) => window.clearInterval(t));
  }, [open, playingBySensor, sensorData, indexBySensor]);

  useEffect(() => {
    if (!open || !projectId) return undefined;
    let cancelled = false;
    async function loadCurrentFrame(sensor) {
      const frame = frameFor(sensor);
      if (!frame) {
        // No limpiar en transiciones breves; conserva la última imagen válida.
        return;
      }
      const cacheKey = `${projectId}|idx|${sensor}|${frame.id}`;
      if (previewCacheRef.current.has(cacheKey)) {
        setSrcBySensor((p) => ({ ...p, [sensor]: previewCacheRef.current.get(cacheKey) || "" }));
        return;
      }
      try {
        const endpoint = buildPreviewEndpoint(sensor, projectId, frame);
        const objectUrl = await fetchPreviewObjectUrl(endpoint, effectiveToken);
        if (cancelled) {
          safeRevokePreviewUrl(objectUrl);
          return;
        }
        previewCacheRef.current.set(cacheKey, objectUrl);
        setSrcBySensor((p) => ({ ...p, [sensor]: objectUrl }));
      } catch (e) {
        if (!cancelled) {
          setSrcBySensor((p) => ({ ...p, [sensor]: "" }));
          setError((prev) => prev || `No se pudo cargar preview de índice (${sensor}): ${formatApiErrorDetail(e)}`);
        }
      }
    }
    void loadCurrentFrame("s1");
    void loadCurrentFrame("s2");
    void loadCurrentFrame("ps");
    return () => {
      cancelled = true;
    };
  }, [open, projectId, sensorData, indexBySensor, dateIdxBySensor, loading, effectiveToken]);

  useEffect(() => {
    if (!open || !projectId) return undefined;
    let cancelled = false;
    async function loadRgbPreview(sensor) {
      const frame = frameFor(sensor);
      if (!frame) {
        // No limpiar en transiciones breves; conserva la última imagen válida.
        return;
      }

      if (sensor === "s1") {
        const relSigma = findRecortePathForSceneDate(s1PrepSigmaItems, frame.date);
        if (relSigma) {
          const cacheKey = `${projectId}|s1sigma|${relSigma}`;
          if (previewCacheRef.current.has(cacheKey)) {
            setRgbSrcBySensor((p) => ({ ...p, s1: previewCacheRef.current.get(cacheKey) || "" }));
            return;
          }
          try {
            const endpoint = buildS1Sigma0PreviewEndpoint(projectId, relSigma);
            const objectUrl = await fetchPreviewObjectUrl(endpoint, effectiveToken);
            if (cancelled) {
              safeRevokePreviewUrl(objectUrl);
              return;
            }
            previewCacheRef.current.set(cacheKey, objectUrl);
            setRgbSrcBySensor((p) => ({ ...p, s1: objectUrl }));
            return;
          } catch (e) {
            if (!cancelled) {
              setRgbSrcBySensor((p) => ({ ...p, s1: "" }));
              setError((prev) => prev || `No se pudo cargar preview RGB (${sensor}): ${formatApiErrorDetail(e)}`);
            }
          }
        }
        const s1RecItems = (recorteInventory.s2 || []).filter(isS1RecorteItem);
        const relGeo = findRecortePathForSceneDate(s1RecItems, frame.date);
        if (!relGeo) {
          if (!cancelled) setRgbSrcBySensor((p) => ({ ...p, s1: "" }));
          return;
        }
        const cacheKey = `${projectId}|rgb|s2|${relGeo}`;
        if (previewCacheRef.current.has(cacheKey)) {
          setRgbSrcBySensor((p) => ({ ...p, s1: previewCacheRef.current.get(cacheKey) || "" }));
          return;
        }
        try {
          const endpoint = buildRecorteRgbEndpoint(projectId, relGeo, "s2");
          const objectUrl = await fetchPreviewObjectUrl(endpoint, effectiveToken);
          if (cancelled) {
            safeRevokePreviewUrl(objectUrl);
            return;
          }
          previewCacheRef.current.set(cacheKey, objectUrl);
          setRgbSrcBySensor((p) => ({ ...p, s1: objectUrl }));
        } catch (e) {
          if (!cancelled) {
            setRgbSrcBySensor((p) => ({ ...p, s1: "" }));
            setError((prev) => prev || `No se pudo cargar preview RGB (${sensor}): ${formatApiErrorDetail(e)}`);
          }
        }
        return;
      }

      const items = recorteInventory[sensor] || [];
      const rel = findRecortePathForSceneDate(items, frame.date);
      if (!rel) {
        setRgbSrcBySensor((p) => ({ ...p, [sensor]: "" }));
        return;
      }
      const pv = sensor === "ps" ? "ps" : "s2";
      const cacheKey = `${projectId}|rgb|${pv}|${rel}`;
      if (previewCacheRef.current.has(cacheKey)) {
        setRgbSrcBySensor((p) => ({ ...p, [sensor]: previewCacheRef.current.get(cacheKey) || "" }));
        return;
      }
      try {
        const endpoint = buildRecorteRgbEndpoint(projectId, rel, pv);
        const objectUrl = await fetchPreviewObjectUrl(endpoint, effectiveToken);
        if (cancelled) {
          safeRevokePreviewUrl(objectUrl);
          return;
        }
        previewCacheRef.current.set(cacheKey, objectUrl);
        setRgbSrcBySensor((p) => ({ ...p, [sensor]: objectUrl }));
      } catch (e) {
        if (!cancelled) {
          setRgbSrcBySensor((p) => ({ ...p, [sensor]: "" }));
          setError((prev) => prev || `No se pudo cargar preview RGB (${sensor}): ${formatApiErrorDetail(e)}`);
        }
      }
    }
    void loadRgbPreview("s1");
    void loadRgbPreview("s2");
    void loadRgbPreview("ps");
    return () => {
      cancelled = true;
    };
  }, [open, projectId, sensorData, indexBySensor, dateIdxBySensor, recorteInventory, s1PrepSigmaItems, loading, effectiveToken]);

  useEffect(() => {
    if (!open) return;
    return () => {
      for (const [, url] of previewCacheRef.current.entries()) safeRevokePreviewUrl(url);
      previewCacheRef.current.clear();
      setSrcBySensor({ s1: "", s2: "", ps: "" });
      setRgbSrcBySensor({ s1: "", s2: "", ps: "" });
    };
  }, [open]);

  const selectionKey = useMemo(
    () => JSON.stringify({ p: pointSelection, r: roiSelection }),
    [pointSelection, roiSelection]
  );

  async function ensureRecortes(sensor) {
    if (sensor !== "s2" && sensor !== "ps") return [];
    if (recortesCacheRef.current[sensor]) return recortesCacheRef.current[sensor];
    const pv = sensor === "ps" ? "ps" : "s2";
    if (effectiveToken) setAuthToken(effectiveToken);
    const inv = await api.get(`/preprocess/recortes-inventory/${projectId}?pipeline_variant=${pv}`);
    const paths = (inv.data?.items || []).map((x) => x.relative_path).filter(Boolean);
    recortesCacheRef.current[sensor] = paths;
    return paths;
  }

  async function loadSeriesForSensor(sensor) {
    const key = `${sensor}|${projectId}|${selectionKey}`;
    if (seriesCacheRef.current.has(key)) return seriesCacheRef.current.get(key);
    if (effectiveToken) setAuthToken(effectiveToken);
    let data = null;
    if (sensor === "s1") {
      const frames = framesFor("s1");
      const dates = [...new Set(frames.map((f) => normIso(f.date)))].slice(0, 24);
      if (!dates.length) return null;
      const res = await api.post("/preprocess/s1-sar-time-series", {
        project_id: Number(projectId),
        dates,
      });
      data = res.data;
    } else {
      const recortePaths = (await ensureRecortes(sensor)).slice(0, 32);
      if (!recortePaths.length) return null;
      const pv = sensor === "ps" ? "ps" : "s2";
      const res = await api.post("/preprocess/vegetation-time-series", {
        project_id: Number(projectId),
        recorte_relative_paths: recortePaths,
        pipeline_variant: pv,
        max_pixel_series: 1800,
        random_seed: 42,
      });
      data = res.data;
    }
    seriesCacheRef.current.set(key, data);
    return data;
  }

  async function loadAllSeries() {
    if (!open || !projectId) return;
    setSeriesLoading(true);
    try {
      const [s1, s2, ps] = await Promise.all([
        loadSeriesForSensor("s1"),
        loadSeriesForSensor("s2"),
        loadSeriesForSensor("ps"),
      ]);
      setSeriesBySensor({ s1, s2, ps });

      let climatePayload = null;
      try {
        const c = await api.get("/preprocess/agroclimate-series", {
          params: { project_id: Number(projectId) },
        });
        climatePayload = c.data;
      } catch {
        climatePayload = null;
      }
      setClimateBySensor({
        s1: climatePayload?.by_sensor?.s1 || [],
        s2: climatePayload?.by_sensor?.s2 || [],
        ps: climatePayload?.by_sensor?.ps || [],
      });
    } finally {
      setSeriesLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !projectId || !sensorData.s1) return;
    void loadAllSeries();
  }, [open, projectId, sensorData, effectiveToken]);

  const activeCluster = (clusterBySensor[sensorActive] || []).find((c) => c.key === selectedClusterKey[sensorActive]);

  const handleMediaMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(rect.width, 1);
    const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
    if (roiMode && dragStart) {
      setRoiSelection({
        x1: Math.min(dragStart.x, x),
        y1: Math.min(dragStart.y, y),
        x2: Math.max(dragStart.x, x),
        y2: Math.max(dragStart.y, y),
      });
    }
  };

  const handleMediaMouseDown = (e) => {
    if (!roiMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragStart({
      x: (e.clientX - rect.left) / Math.max(rect.width, 1),
      y: (e.clientY - rect.top) / Math.max(rect.height, 1),
    });
  };

  const handleMediaMouseUp = () => {
    setDragStart(null);
  };

  const handleMediaClick = (e) => {
    if (roiMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPointSelection({
      x: (e.clientX - rect.left) / Math.max(rect.width, 1),
      y: (e.clientY - rect.top) / Math.max(rect.height, 1),
    });
  };

  if (!open) return null;

  const s = sensorActive;
  return (
    <div className="adv-dashboard-overlay" role="dialog" aria-modal="true" aria-label="BioAgroMap, dashboard multisensor espectral-espacio-temporal">
      <div className="adv-dashboard-backdrop" onClick={onClose} />
      <div className="adv-dashboard-window">
        <div className="adv-dashboard-header">
          <h2>BioAgroMap -> Dashboard multisensor Espectral-Espacio-Temporal</h2>
          <div className="adv-dashboard-header-actions">
            <button type="button" onClick={() => void loadAllSeries()} disabled={seriesLoading || loading}>
              {seriesLoading ? "…" : "Actualizar series"}
            </button>
            <button type="button" className="adv-close-btn" onClick={onClose} aria-label="Cerrar">
              ×
            </button>
          </div>
        </div>

        {error ? <p className="adv-dashboard-error">{error}</p> : null}

        <div className="adv-main-split">
          <div className="adv-timelapse-column">
            <div className="adv-timelapse-main">
              <div className="adv-sensor-tabs" role="tablist" aria-label="Sensor">
                {(["s1", "s2", "ps"]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={sensorActive === key}
                    className={`adv-sensor-tab${sensorActive === key ? " adv-sensor-tab--active" : ""}`}
                    onClick={() => setSensorActive(key)}
                  >
                    {SENSOR_META[key].title}
                  </button>
                ))}
              </div>
              <div className="adv-timelapse-toolbar">
                <label className="adv-timelapse-toolbar-field">
                  <span className="adv-timelapse-toolbar-label">Cluster</span>
                  <select
                    value={selectedClusterKey[sensorActive] || ""}
                    onChange={(e) =>
                      setSelectedClusterKey((p) => ({
                        ...p,
                        [sensorActive]: e.target.value,
                      }))
                    }
                  >
                    {(clusterBySensor[sensorActive] || []).map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label || r.key}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="adv-inline-check adv-timelapse-toolbar-check">
                  <input
                    type="checkbox"
                    checked={clusterVisible}
                    onChange={(e) => setClusterVisible(e.target.checked)}
                  />
                  Overlay
                </label>
              </div>
              <SensorTimelapseViewer
                sensorTitle={SENSOR_META[s].title}
                omitSensorTitle
                indices={sensorData[s]?.indices || []}
                selectedIndex={indexBySensor[s]}
                onChangeIndex={(k) => {
                  setIndexBySensor((p) => ({ ...p, [s]: k }));
                  setDateIdxBySensor((p) => ({ ...p, [s]: 0 }));
                }}
                frames={framesFor(s)}
                currentIdx={dateIdxBySensor[s]}
                onChangeFrameIdx={(idx) => setDateIdxBySensor((p) => ({ ...p, [s]: idx }))}
                isPlaying={playingBySensor[s]}
                onPlayPause={() => setPlayingBySensor((p) => ({ ...p, [s]: !p[s] }))}
                onStop={() => {
                  setPlayingBySensor((p) => ({ ...p, [s]: false }));
                }}
                imageSrc={srcBySensor[s]}
                imageAlt={`${SENSOR_META[s].title} ${indexBySensor[s]} ${frameFor(s)?.date || ""}`}
                dualPaneRgb
                rgbImageSrc={rgbSrcBySensor[s]}
                rgbAlt={
                  s === "s1"
                    ? `SAR VV ${SENSOR_META[s].title} ${frameFor(s)?.date || ""}`
                    : `RGB ${SENSOR_META[s].title} ${frameFor(s)?.date || ""}`
                }
                rightPaneLabel={s === "s1" ? "SAR VV" : "RGB"}
                rgbEmptyMessage={
                  s === "s1"
                    ? "Sin Sigma0 VV (s1prepoceso) ni recorte S1 para esta fecha."
                    : "Sin recorte RGB para esta fecha."
                }
                opacity={opacityBySensor[s]}
                onOpacity={(v) => setOpacityBySensor((p) => ({ ...p, [s]: v }))}
                interactive
                roiMode={roiMode}
                onToggleRoi={() => setRoiMode((v) => !v)}
                roiSelection={roiSelection}
                clusterPreviewB64={activeCluster?.preview_png_base64 || null}
                clusterVisible={clusterVisible}
                onMediaMouseMove={handleMediaMouseMove}
                onMediaMouseDown={handleMediaMouseDown}
                onMediaMouseUp={handleMediaMouseUp}
                onMediaClick={handleMediaClick}
              />
            </div>
            <section className="adv-timelapse-geofisica" aria-label="Geofísica y modelado de suelo">
              <h3 className="adv-timelapse-geofisica-title">AGRO Geofisica - Modelado del suelo agricola</h3>
              <div className="adv-timelapse-geofisica-frame">
                <img
                  src={`${import.meta.env.BASE_URL}dashboard-geofisica-modelado-suelo.png`}
                  alt="Modelado geofísico del suelo agrícola"
                />
              </div>
            </section>
          </div>

          <div className="adv-series-column">
            <div className="adv-series-column-inner">
              <div className="adv-series-primary">
                {seriesBySensor[sensorActive] ? (
                  <VegetationTimeSeriesCharts
                    data={seriesBySensor[sensorActive]}
                    onlyIndexKey={indexBySensor[sensorActive]}
                    activeSceneDate={frameFor(sensorActive)?.date || null}
                  />
                ) : (
                  <p className="adv-series-empty">Sin serie para este sensor.</p>
                )}
                <div className="adv-climate-panel adv-climate-panel--inline">
                  <ClimateTimeSeriesChart
                    data={climateBySensor[sensorActive]}
                    activeVars={climateVars}
                    activeSceneDate={frameFor(sensorActive)?.date || null}
                  />
                </div>
                <div className="adv-climate-toggles adv-climate-toggles--compact">
                  {[
                    ["precip", "Precipitación"],
                    ["temp", "Temperatura"],
                    ["humidity", "Humedad"],
                    ["radiation", "Radiación solar"],
                  ].map(([k, label]) => (
                    <label key={k}>
                      <input
                        type="checkbox"
                        checked={!!climateVars[k]}
                        onChange={(e) => setClimateVars((p) => ({ ...p, [k]: e.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <section className="adv-smart-clusters-panel" aria-label="Clusters Smart">
                <div className="adv-smart-clusters-grid">
                  <div className="adv-smart-cluster-cell">
                    <h4 className="adv-smart-cluster-heading">cluster Smart 1</h4>
                    <div className="adv-smart-cluster-frame">
                      {psStCluster1Error ? (
                        <p className="adv-smart-cluster-msg adv-smart-cluster-msg--err">{psStCluster1Error}</p>
                      ) : null}
                      {psStCluster1Busy ? (
                        <p className="adv-smart-cluster-msg">Calculando cluster…</p>
                      ) : psStCluster1Preview ? (
                        <img
                          className="adv-smart-cluster-map"
                          src={psStCluster1Preview}
                          alt="Mapa clusters PS preset NDVI, NDRE, NDWI, VARI"
                        />
                      ) : (
                        <p className="adv-smart-cluster-msg">Sin mapa (índices NDVI, NDRE, NDWI, VARI en indecesPS).</p>
                      )}
                    </div>
                  </div>
                  <div className="adv-smart-cluster-cell">
                    <h4 className="adv-smart-cluster-heading">cluster Smart 2</h4>
                    <div className="adv-smart-cluster-frame">
                      {psStCluster2Error ? (
                        <p className="adv-smart-cluster-msg adv-smart-cluster-msg--err">{psStCluster2Error}</p>
                      ) : null}
                      {psStCluster2Busy ? (
                        <p className="adv-smart-cluster-msg">Calculando cluster…</p>
                      ) : psStCluster2Preview ? (
                        <img
                          className="adv-smart-cluster-map"
                          src={psStCluster2Preview}
                          alt="Mapa clusters PS preset EVI, NDRE, NDWI, VARI"
                        />
                      ) : (
                        <p className="adv-smart-cluster-msg">Sin mapa (requiere EVI y resto en indecesPS).</p>
                      )}
                    </div>
                  </div>
                  <div className="adv-smart-cluster-cell">
                    <h4 className="adv-smart-cluster-heading">cluster Smart 3</h4>
                    <div className="adv-smart-cluster-frame">
                      {psStCluster3Error ? (
                        <p className="adv-smart-cluster-msg adv-smart-cluster-msg--err">{psStCluster3Error}</p>
                      ) : null}
                      {psStCluster3Busy ? (
                        <p className="adv-smart-cluster-msg">Calculando cluster…</p>
                      ) : psStCluster3Preview ? (
                        <img
                          className="adv-smart-cluster-map"
                          src={psStCluster3Preview}
                          alt="Mapa clusters PS preset KNDVI, MCARI, NDWI, VARI"
                        />
                      ) : (
                        <p className="adv-smart-cluster-msg">Sin mapa (KNDVI, MCARI, NDWI, VARI en indecesPS).</p>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
