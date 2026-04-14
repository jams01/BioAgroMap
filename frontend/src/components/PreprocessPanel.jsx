export default function PreprocessPanel({
  token,
  projectId,
  loading,
  targetRasterId,
  downloadSource,
  setDownloadSource,
  indiceType,
  setIndiceType,
  stackMode,
  setStackMode,
  onDownload,
  onCrop,
  onIndices,
  onStack,
  onCluster,
}) {
  return (
    <>
      <label>
        1) Descargar
        <select
          value={downloadSource}
          onChange={(e) => setDownloadSource(e.target.value)}
        >
          <option value="sentinel-1">Sentinel-1</option>
          <option value="sentinel-2">Sentinel-2</option>
          <option value="landsat-8-9">Landsat 8/9</option>
          <option value="drone">Drone</option>
        </select>
      </label>
      <button
        onClick={onDownload}
        disabled={loading || !projectId || !token}
      >
        Ejecutar descarga
      </button>

      <button
        onClick={onCrop}
        disabled={loading || !projectId || !token || !targetRasterId}
      >
        2) Recorte
      </button>

      <label>
        3) Indices
        <select
          value={indiceType}
          onChange={(e) => setIndiceType(e.target.value)}
        >
          <option value="NDVI">NDVI</option>
          <option value="EVI">EVI</option>
          <option value="NDWI">NDWI</option>
        </select>
      </label>
      <button
        onClick={onIndices}
        disabled={loading || !projectId || !token || !targetRasterId}
      >
        Calcular indice
      </button>

      <label>
        4) Stack
        <select
          value={stackMode}
          onChange={(e) => setStackMode(e.target.value)}
        >
          <option value="visualizar">Visualizar</option>
          <option value="gif">Gif</option>
        </select>
      </label>
      <button
        onClick={onStack}
        disabled={loading || !projectId || !token}
      >
        Procesar stack
      </button>

      <button
        onClick={onCluster}
        disabled={loading || !projectId || !token || !targetRasterId}
      >
        5) Cluster
      </button>
    </>
  );
}
