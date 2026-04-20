import { useState } from "react";

export default function UploadPanel({
  token,
  projectId,
  loading,
  targetRasterId,
  setTargetRasterId,
  onUploadLote,
  onUploadRaster,
  onRunAI,
  onDownload,
  loteFile,
  setLoteFile,
  rasterFile,
  setRasterFile,
  downloadSource,
  setDownloadSource,
  mapLayers,
  s2Download,
  s1Download,
}) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [s1AoiFile, setS1AoiFile] = useState(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [uploadedLayerId, setUploadedLayerId] = useState("");
  const [loteMode, setLoteMode] = useState("existing");

  const vectorLayers = mapLayers.filter((l) => l.kind === "vector");
  const hasVectorLayers = vectorLayers.length > 0;

  const activeLayerId = loteMode === "existing" ? selectedLayerId : uploadedLayerId;
  const isSentinel2 = downloadSource === "sentinel-2";
  const isSentinel1 = downloadSource === "sentinel-1";
  const sentinelDatesOk = !isSentinel2 && !isSentinel1 || (startDate && endDate);
  const hasVectorForDownload = activeLayerId || (isSentinel1 && s1AoiFile);
  const downloadDisabled =
    loading || !projectId || !token ||
    !sentinelDatesOk ||
    (isSentinel2 && !activeLayerId) ||
    (isSentinel1 && !hasVectorForDownload) ||
    (!isSentinel1 && !isSentinel2 && !activeLayerId);

  async function handleUploadLote() {
    const newLayerId = await onUploadLote();
    if (newLayerId) {
      setUploadedLayerId(String(newLayerId));
    }
  }

  function handleDownload() {
    onDownload(
      isSentinel2 || isSentinel1 ? startDate : undefined,
      isSentinel2 || isSentinel1 ? endDate : undefined,
      activeLayerId,
      isSentinel1 ? s1AoiFile : undefined
    );
  }

  return (
    <>
      {(!token || !projectId) ? (
        <div className="warn-msg">Primero crea cuenta y proyecto en Admin.</div>
      ) : null}

      <fieldset className="step-fieldset">
        <legend>1) Capa vectorial (lote / area de interes)</legend>

        <div className="lote-mode-toggle">
          <label>
            <input
              type="radio"
              name="loteMode"
              value="existing"
              checked={loteMode === "existing"}
              onChange={() => setLoteMode("existing")}
              disabled={loading}
            />
            Usar capa existente
          </label>
          <label>
            <input
              type="radio"
              name="loteMode"
              value="upload"
              checked={loteMode === "upload"}
              onChange={() => setLoteMode("upload")}
              disabled={loading}
            />
            Subir nueva capa
          </label>
        </div>

        {loteMode === "existing" ? (
          hasVectorLayers ? (
            <select
              value={selectedLayerId}
              onChange={(e) => setSelectedLayerId(e.target.value)}
              disabled={loading}
            >
              <option value="">-- Seleccionar capa --</option>
              {vectorLayers.map((l) => (
                <option key={l.id} value={l.serverId || l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="warn-msg">No hay capas vectoriales en el proyecto. Sube una nueva.</div>
          )
        ) : (
          <>
            <input
              type="file"
              accept=".zip,.shp,.kml,.kmz,.geojson,.json,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml"
              onChange={(e) => { setLoteFile(e.target.files?.[0] || null); setUploadedLayerId(""); }}
              disabled={loading}
            />
            <button
              onClick={handleUploadLote}
              disabled={!token || !projectId || !loteFile || loading}
            >
              Subir lote {loteFile ? `(${loteFile.name})` : ""}
            </button>
            {uploadedLayerId && (
              <div className="status-msg">Capa subida (ID: {uploadedLayerId}) - lista para descarga</div>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="step-fieldset">
        <legend>2) Descargar imagen satelital</legend>
        <select
          value={downloadSource}
          onChange={(e) => setDownloadSource(e.target.value)}
          disabled={loading}
        >
          <option value="sentinel-2">Sentinel-2</option>
          <option value="sentinel-1">Sentinel-1</option>
          <option value="landsat-8-9">Landsat 8/9</option>
          <option value="drone">Drone</option>
        </select>

        {(isSentinel2 || isSentinel1) && (
          <div className="date-range-fields">
            <label>
              Fecha inicio
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={loading}
              />
            </label>
            <label>
              Fecha fin
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={loading}
              />
            </label>
          </div>
        )}

        {isSentinel1 && (
          <div className="hint-msg" style={{ marginTop: "0.5rem" }}>
            <strong>AOI (opcional si ya usas la capa del paso 1):</strong> GeoJSON (
            <code>.geojson</code>) o shapefile en <code>.zip</code>. Si lo subes aquí, tiene prioridad
            sobre la capa seleccionada.
            <input
              type="file"
              accept=".geojson,.json,.zip,application/json,application/zip"
              onChange={(e) => setS1AoiFile(e.target.files?.[0] || null)}
              disabled={loading}
              style={{ display: "block", marginTop: "0.35rem" }}
            />
            {s1AoiFile ? (
              <span className="status-msg">Archivo AOI: {s1AoiFile.name}</span>
            ) : null}
          </div>
        )}

        <button onClick={handleDownload} disabled={downloadDisabled}>
          {isSentinel2 ? "Descargar Sentinel-2" : isSentinel1 ? "Descargar Sentinel-1 (GRD IW)" : "Ejecutar descarga"}
        </button>

        {isSentinel2 && s2Download && s2Download.ui_status === "downloading" && (
          <div className="s2-progress" role="status" aria-live="polite">
            <div className="s2-progress-label">Descarga Sentinel-2 en curso</div>
            <div className="s2-progress-bar-wrap">
              <div
                className="s2-progress-bar-fill"
                style={{ width: `${Math.min(100, Math.max(0, s2Download.progress || 0))}%` }}
              />
            </div>
            <div className="s2-progress-msg">{s2Download.message || "Procesando..."}</div>
          </div>
        )}
        {isSentinel2 && s2Download && s2Download.ui_status === "completed" && (
          <div className="s2-progress s2-progress-done" role="status">
            <strong>Terminado</strong>
            <span className="s2-progress-msg">
              {s2Download.message || "Descarga completada"}
              {s2Download.totalDownloaded != null
                ? ` (${s2Download.totalDownloaded} archivo(s)${s2Download.totalSizeMb != null ? `, ~${s2Download.totalSizeMb} MB` : ""})`
                : ""}
            </span>
          </div>
        )}
        {isSentinel2 && s2Download && s2Download.ui_status === "failed" && (
          <div className="s2-progress s2-progress-err" role="alert">
            <strong>Error</strong>
            <span className="s2-progress-msg">{s2Download.message || "Fallo la descarga"}</span>
          </div>
        )}

        {isSentinel1 && s1Download && s1Download.ui_status === "downloading" && (
          <div className="s2-progress" role="status" aria-live="polite">
            <div className="s2-progress-label">Descarga Sentinel-1 en curso</div>
            <div className="s2-progress-bar-wrap">
              <div
                className="s2-progress-bar-fill"
                style={{ width: `${Math.min(100, Math.max(0, s1Download.progress || 0))}%` }}
              />
            </div>
            <div className="s2-progress-msg">{s1Download.message || "Procesando…"}</div>
          </div>
        )}
        {isSentinel1 && s1Download && s1Download.ui_status === "completed" && (
          <div className="s2-progress s2-progress-done" role="status">
            <strong>Terminado</strong>
            <span className="s2-progress-msg">
              {s1Download.message || "Descarga completada"}
              {s1Download.selectedRelativeOrbit != null
                ? ` · Órbita relativa ${s1Download.selectedRelativeOrbit}${
                    s1Download.selectedPassShort ? ` (${s1Download.selectedPassShort})` : ""
                  }`
                : ""}
              {s1Download.totalDownloaded != null
                ? ` · ${s1Download.totalDownloaded} producto(s)`
                : ""}
            </span>
          </div>
        )}
        {isSentinel1 && s1Download && s1Download.ui_status === "failed" && (
          <div className="s2-progress s2-progress-err" role="alert">
            <strong>Error</strong>
            <span className="s2-progress-msg">{s1Download.message || "Fallo la descarga"}</span>
          </div>
        )}
      </fieldset>

      <fieldset className="step-fieldset">
        <legend>3) Subir raster</legend>
        <p className="hint-msg">
          ZIP <code>.SAFE</code>: se guarda un TIF 4 bandas (B04,B03,B02,B08) con fecha de la carpeta{" "}
          (<code>dd-mm-AAAA_S2_4band_…</code>) y solo se añaden al mapa{" "}
          <strong>2 capas</strong>: RGB (B04,B03,B02) y NIR (B08,B04,B03), nombres{" "}
          <code>dd/mm/AAAA_RGB</code> y <code>dd/mm/AAAA_NIR</code>.
        </p>
        <input
          type="file"
          accept=".tif,.tiff,.jp2,.png,.jpg,.jpeg,.zip"
          onChange={(e) => setRasterFile(e.target.files?.[0] || null)}
          disabled={loading}
        />
        <button
          onClick={onUploadRaster}
          disabled={!token || !projectId || !rasterFile || loading}
        >
          Subir raster
        </button>
        <label>
          Raster objetivo ID
          <input
            type="number"
            value={targetRasterId}
            onChange={(e) => setTargetRasterId(e.target.value)}
            disabled={loading}
          />
        </label>
        <button
          onClick={onRunAI}
          disabled={!projectId || !targetRasterId || loading}
        >
          Ejecutar IA
        </button>
      </fieldset>
    </>
  );
}
