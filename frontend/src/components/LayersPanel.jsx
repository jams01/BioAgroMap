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
  return (
    <div className="layers-panel">
      <div className="layers-panel-header">
        <span>Capas ({mapLayers.length})</span>
      </div>
      <ul className="layers-list">
        {mapLayers.length === 0 ? (
          <li className="layers-empty">Sin capas cargadas</li>
        ) : (
          mapLayers.map((l) => (
            <li key={l.id} className="layers-item">
              <input
                type="checkbox"
                checked={l.visible}
                onChange={() => onToggleVisibility(l.id)}
                aria-label={`Mostrar/ocultar ${l.name}`}
              />
              <span className={`layers-badge ${l.kind}`}>
                {l.kind === "vector" ? "V" : "R"}
              </span>
              <span className="layers-name" title={l.name}>
                {l.name}
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
          ))
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
