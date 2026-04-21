import axios from "axios";

/**
 * Sin VITE_API_URL: mismo origen que la página + `/api/v1` (p. ej. :5173). En dev, Vite reenvía `/api` al
 * backend (`BACKEND_PROXY_URL` en Docker, por defecto `http://127.0.0.1:8000` en el host). Así el navegador
 * no depende de que el puerto 8000 esté expuesto ni de CORS hacia :8000.
 */
const DEV_API_PORT = import.meta.env.VITE_DEV_API_PORT || "8000";

function resolveApiBase() {
  const v = import.meta.env.VITE_API_URL;
  if (v != null && String(v).trim() !== "") {
    let u = String(v).trim().replace(/\/$/, "");
    // Ya incluye /api/v1
    if (/\/api\/v1$/i.test(u)) {
      return u;
    }
    // Caso típico erróneo: http://host:8000/api → debe ser .../api/v1 (no .../api/api/v1)
    if (/\/api$/i.test(u)) {
      return `${u}/v1`;
    }
    // Raíz del backend (p. ej. http://localhost:8000) → añadir prefijo API
    return `${u}/api/v1`;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/api/v1`;
  }
  return `http://127.0.0.1:${DEV_API_PORT}/api/v1`;
}

export const API_URL = resolveApiBase();

const SK_ACCESS = "bioagromap_access";
const SK_REFRESH = "bioagromap_refresh";

const api = axios.create({ baseURL: API_URL });

/** Petición sin interceptores (evita bucles al renovar token). */
const rawClient = axios.create({ baseURL: API_URL });

let refreshInFlight = null;

export function setAuthToken(token) {
  if (token) {
    api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common["Authorization"];
  }
}

export function persistAuthTokens(access, refresh) {
  if (access) sessionStorage.setItem(SK_ACCESS, access);
  if (refresh) sessionStorage.setItem(SK_REFRESH, refresh);
  setAuthToken(access || null);
}

export function clearAuthTokens() {
  sessionStorage.removeItem(SK_ACCESS);
  sessionStorage.removeItem(SK_REFRESH);
  setAuthToken(null);
}

export function loadStoredAuth() {
  return {
    access: sessionStorage.getItem(SK_ACCESS),
    refresh: sessionStorage.getItem(SK_REFRESH),
  };
}

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const status = error.response?.status;
    const config = error.config;
    if (status !== 401 || !config || config._retry) {
      return Promise.reject(error);
    }
    const reqUrl = String(config.url || "");
    if (
      reqUrl.includes("/auth/refresh") ||
      reqUrl.includes("/auth/login") ||
      reqUrl.includes("/auth/register")
    ) {
      return Promise.reject(error);
    }
    const refresh = sessionStorage.getItem(SK_REFRESH);
    if (!refresh) {
      return Promise.reject(error);
    }
    config._retry = true;
    try {
      if (!refreshInFlight) {
        refreshInFlight = rawClient
          .post("/auth/refresh", { refresh_token: refresh })
          .then((res) => res.data)
          .finally(() => {
            refreshInFlight = null;
          });
      }
      const data = await refreshInFlight;
      persistAuthTokens(data.access_token, data.refresh_token);
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${data.access_token}`;
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("bioagromap:auth-refreshed", {
            detail: { access_token: data.access_token },
          })
        );
      }
      return api(config);
    } catch (e) {
      clearAuthTokens();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("bioagromap:auth-expired"));
      }
      return Promise.reject(e);
    }
  }
);

/** Texto legible para errores de Axios/FastAPI (detail string, lista 422, u objeto). */
/** URL efectiva de la petición (útil para depurar 404). */
function resolvedRequestUrl(error) {
  const c = error?.config;
  if (!c) return "";
  try {
    const raw = c.url != null ? String(c.url) : "";
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = c.baseURL ? String(c.baseURL).replace(/\/$/, "") : "";
    const path = raw.replace(/^\//, "");
    if (base && path) {
      return new URL(path, `${base}/`).href;
    }
    return path || base;
  } catch {
    return [c.baseURL, c.url].filter(Boolean).join("");
  }
}

export function formatApiErrorDetail(error) {
  if (!error) return "Error desconocido";
  if (
    !error.response &&
    (error.code === "ERR_NETWORK" || String(error.message || "").includes("Network Error"))
  ) {
    const tried = resolvedRequestUrl(error);
    return `No se pudo conectar con el API (${tried || "URL no deducible"}). Comprueba que el backend esté en marcha (p. ej. \`docker compose up -d backend\` o uvicorn en el puerto configurado). Con Vite en dev, las peticiones van al mismo origen que la página + /api; el proxy debe apuntar al API. Si deseas llamar directo al puerto del API, define VITE_API_URL (p. ej. http://127.0.0.1:8000).`;
  }
  const d = error.response?.data?.detail;
  if (d == null) return error.message || "Error de red o servidor";
  if (typeof d === "string") {
    if (d === "Not Found" && error.response?.status === 404) {
      const tried = resolvedRequestUrl(error);
      const hint =
        "Comprueba VITE_API_URL (debe acabar en /api/v1 o en /api; p. ej. http://localhost:8000), que el backend esté en marcha y reiniciado tras actualizar código, y en dev que Vite haga proxy de /api al puerto 8000.";
      return `${d}. Petición: ${tried || "?"}. ${hint}`;
    }
    return d;
  }
  if (Array.isArray(d)) {
    return d
      .map((e) => {
        if (e == null) return "";
        if (typeof e === "string") return e;
        const loc = Array.isArray(e.loc) ? e.loc.join(".") : "";
        const msg = e.msg ?? e.message ?? JSON.stringify(e);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof d === "object") return d.message || JSON.stringify(d);
  return String(d);
}

export default api;
