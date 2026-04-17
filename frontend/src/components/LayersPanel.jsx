import { useMemo } from "react";
import { formatRecorteDisplayName, rasterSortKeyFromMetadata } from "../utils/geo";

export default function LayersPanel({
  mapLayers,
  projectId,
  dirty,
  loading,
  onToggleVisibility,
  onZoomToLayer,
  onRemoveLayer,
  onSave,
}) {
  const orderedLayers = useMemo(() => {
    const vectors = mapLayers.filter((l) => l.kind === "vector");
    const rasters = mapLayers.filter((l) => l.kind === "raster");
    rasters.sort((a, b) => {
      const ka = rasterSortKeyFromMetadata(a.metadata);
      const kb = rasterSortKeyFromMetadata(b.metadata);
      const c = ka.localeCompare(kb);
      if (c !== 0) return c;
      return (a.serverId || 0) - (b.serverId || 0);
    });
    return [...vectors, ...rasters];
  }, [mapLayers]);

  return (
    <div className="layers-panel">
      <div className="layers-panel-header">
        <span>Capas ({mapLayers.length})</span>
      </div>
      <ul className="layers-list">
        {mapLayers.length === 0 ? (
          <li className="layers-empty">Sin capas cargadas</li>
        ) : (
          orderedLayers.map((l) => {
            const label =
              l.displayName ||
              (l.kind === "raster"
                ? formatRecorteDisplayName(l.metadata, l.name)
                : null) ||
              l.name;
            return (
            <li key={l.id} className="layers-item">
              <input
                type="checkbox"
                checked={l.visible}
                onChange={() => onToggleVisibility(l.id)}
                aria-label={`Mostrar/ocultar ${label}`}
              />
              <span className={`layers-badge ${l.kind}`}>
                {l.kind === "vector" ? "V" : "R"}
              </span>
              <span className="layers-name" title={label}>
                {label}
              </span>
              <button
                className="layers-zoom"
                title="Zoom a capa"
                onClick={() => onZoomToLayer(l.id)}
              >
                &#8982;
              </button>
              <button
                className="layers-remove"
                title="Eliminar capa"
                onClick={() => onRemoveLayer(l.id)}
              >
                &times;
              </button>
            </li>
            );
          })
        )}
      </ul>
      {projectId && (
        <div className="layers-save">
          <button
            className="btn-save"
            onClick={onSave}
            disabled={loading || !dirty}
          >
            {dirty ? "Guardar cambios" : "Guardado"}
          </button>
        </div>
      )}
    </div>
  );
}
