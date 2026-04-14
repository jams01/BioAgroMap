export default function UploadPanel({
  token,
  projectId,
  loading,
  targetRasterId,
  setTargetRasterId,
  onUploadLote,
  onUploadRaster,
  onRunAI,
  loteFile,
  setLoteFile,
  rasterFile,
  setRasterFile,
}) {
  return (
    <>
      {(!token || !projectId) ? (
        <div className="warn-msg">Primero crea cuenta y proyecto en Admin.</div>
      ) : null}
      <label>
        1) Subir lote (SHP/KML/KMZ/ZIP/GeoJSON)
        <input
          type="file"
          accept=".zip,.shp,.kml,.kmz,.geojson,.json,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml"
          onChange={(e) => setLoteFile(e.target.files?.[0] || null)}
          disabled={loading}
        />
      </label>
      <button
        onClick={onUploadLote}
        disabled={!token || !projectId || !loteFile || loading}
      >
        Subir lote {loteFile ? `(${loteFile.name})` : ""}
      </button>

      <label>
        2) Subir raster
        <input
          type="file"
          accept=".tif,.tiff,.jp2,.png,.jpg,.jpeg"
          onChange={(e) => setRasterFile(e.target.files?.[0] || null)}
          disabled={loading}
        />
      </label>
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
    </>
  );
}
