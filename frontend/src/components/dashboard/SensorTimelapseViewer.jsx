import { useMemo } from "react";

/** Índices agrupados; clave de vigor en inventario: KNDVI. */
const INDEX_CATEGORY_GROUPS = [
  { label: "Vigor", keys: ["NDVI", "EVI", "MSAVI2", "MTVI2", "KNDVI"] },
  { label: "Nutrición", keys: ["NDRE", "CIre", "MCARI"] },
  { label: "Agua", keys: ["NDWI"] },
  { label: "Estructura", keys: ["VARI", "TGI", "GIYI", "RSTRUCTURE"] },
];

const GROUPED_INDEX_KEYS_NORM = new Set(
  INDEX_CATEGORY_GROUPS.flatMap((g) => g.keys.map((k) => String(k).toUpperCase()))
);

/** Alinea catálogo con claves del inventario (p. ej. CIre vs CIRE tras toUpperCase en dashboard). */
function normIndexKey(k) {
  return String(k || "").toUpperCase();
}

function formatDate(iso) {
  if (!iso) return "—";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export default function SensorTimelapseViewer({
  sensorTitle,
  omitSensorTitle = false,
  indices,
  selectedIndex,
  onChangeIndex,
  frames,
  currentIdx,
  onChangeFrameIdx,
  isPlaying,
  onPlayPause,
  onStop,
  imageSrc,
  imageAlt,
  dualPaneRgb = false,
  rgbImageSrc = "",
  rgbAlt = "RGB",
  rightPaneLabel = "RGB",
  rgbEmptyMessage = "Sin recorte RGB para esta fecha.",
  opacity,
  onOpacity,
  interactive = false,
  roiMode = false,
  onToggleRoi,
  onClearRoi,
  roiSelection = null,
  clusterPreviewB64 = null,
  clusterVisible = true,
  onMediaMouseMove,
  onMediaMouseDown,
  onMediaMouseUp,
  onMediaClick,
}) {
  const current = frames[currentIdx] || null;
  const roiPoints = Array.isArray(roiSelection?.polygon_points) ? roiSelection.polygon_points : [];
  const roiPointsSvg = roiPoints.map((p) => `${p.x * 100},${p.y * 100}`).join(" ");
  const roiHasShape = roiPoints.length > 0;
  const roiCanClose = roiPoints.length >= 3;

  const mediaHandlers = useMemo(
    () =>
      interactive
        ? {
            onMouseMove: onMediaMouseMove,
            onMouseDown: onMediaMouseDown,
            onMouseUp: onMediaMouseUp,
            onClick: onMediaClick,
          }
        : {},
    [interactive, onMediaMouseMove, onMediaMouseDown, onMediaMouseUp, onMediaClick]
  );

  const showRoi = typeof onToggleRoi === "function";
  const dateStr = formatDate(current?.date);
  const roiOverlay = roiHasShape ? (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden="true"
    >
      {roiCanClose ? (
        <polygon points={roiPointsSvg} fill="rgba(0, 140, 255, 0.18)" stroke="#008cff" strokeWidth="0.7" />
      ) : (
        <polyline points={roiPointsSvg} fill="none" stroke="#008cff" strokeWidth="0.7" />
      )}
      {roiPoints.map((p, idx) => (
        <circle key={`roi-pt-${idx}`} cx={p.x * 100} cy={p.y * 100} r="0.8" fill="#008cff" />
      ))}
    </svg>
  ) : null;

  const indexSelectContent = useMemo(() => {
    const list = indices || [];
    if (!list.length) return null;
    const availableByNorm = new Map();
    for (const k of list) {
      availableByNorm.set(normIndexKey(k), k);
    }
    const anyGrouped = list.some((k) => GROUPED_INDEX_KEYS_NORM.has(normIndexKey(k)));
    if (!anyGrouped) {
      return list.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ));
    }

    const used = new Set();
    const groups = [];

    for (const g of INDEX_CATEGORY_GROUPS) {
      const keysInGroup = [];
      for (const catalogKey of g.keys) {
        const actual = availableByNorm.get(normIndexKey(catalogKey));
        if (actual) {
          keysInGroup.push(actual);
          used.add(actual);
        }
      }
      groups.push(
        <optgroup key={g.label} label={g.label}>
          {keysInGroup.length > 0 ? (
            keysInGroup.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))
          ) : (
            <option key={`${g.label}__vacío`} disabled value="">
              —
            </option>
          )}
        </optgroup>
      );
    }

    const rest = list.filter((k) => !used.has(k));
    if (rest.length) {
      groups.push(
        <optgroup key="otros" label="Otros">
          {rest.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </optgroup>
      );
    }

    return groups;
  }, [indices]);

  const indexPane = (
    <div
      className={`adv-viewer-pane adv-viewer-pane--index${interactive ? " adv-viewer-media--interactive" : ""}${
        dualPaneRgb ? " adv-viewer-pane--dual" : ""
      }`}
      {...(interactive ? mediaHandlers : {})}
    >
      <span className="adv-viewer-pane-label">Índice</span>
      {imageSrc ? (
        interactive ? (
          <>
            <img className="adv-viewer-stack-img" src={imageSrc} alt={imageAlt} style={{ opacity }} />
            {clusterVisible && clusterPreviewB64 ? (
              <img
                className="adv-viewer-stack-cluster"
                src={`data:image/png;base64,${clusterPreviewB64}`}
                alt=""
              />
            ) : null}
            {roiOverlay}
          </>
        ) : (
          <img className="adv-viewer-stack-img" src={imageSrc} alt={imageAlt} style={{ opacity }} />
        )
      ) : (
        <div className="adv-viewer-empty">Sin preview para esta escena.</div>
      )}
    </div>
  );

  const rgbPane = dualPaneRgb ? (
    <div className="adv-viewer-pane adv-viewer-pane--rgb adv-viewer-pane--dual">
      <span className="adv-viewer-pane-label">{rightPaneLabel}</span>
      {rgbImageSrc ? (
        <img className="adv-viewer-rgb-img" src={rgbImageSrc} alt={rgbAlt} />
      ) : (
        <div className="adv-viewer-empty">{rgbEmptyMessage}</div>
      )}
    </div>
  ) : null;

  const singleMedia = (
    <div
      className={`adv-viewer-media${interactive ? " adv-viewer-media--interactive" : ""}`}
      {...(interactive && !dualPaneRgb ? mediaHandlers : {})}
    >
      {imageSrc ? (
        interactive ? (
          <>
            <img className="adv-viewer-stack-img" src={imageSrc} alt={imageAlt} style={{ opacity }} />
            {clusterVisible && clusterPreviewB64 ? (
              <img
                className="adv-viewer-stack-cluster"
                src={`data:image/png;base64,${clusterPreviewB64}`}
                alt=""
              />
            ) : null}
            {roiOverlay}
          </>
        ) : (
          <img src={imageSrc} alt={imageAlt} style={{ opacity }} />
        )
      ) : (
        <div className="adv-viewer-empty">Sin preview para esta escena.</div>
      )}
    </div>
  );

  return (
    <section className="adv-viewer">
      {!omitSensorTitle ? (
        <div className="adv-viewer-head">
          <strong>{sensorTitle}</strong>
          <span className="adv-date-chip">{dateStr}</span>
        </div>
      ) : (
        <div className="adv-viewer-head adv-viewer-head--compact" aria-hidden="true" />
      )}
      <div className="adv-viewer-controls">
        <select value={selectedIndex} onChange={(e) => onChangeIndex(e.target.value)}>
          {indexSelectContent}
        </select>
        {omitSensorTitle ? <span className="adv-date-chip adv-viewer-controls-date">{dateStr}</span> : null}
        <button type="button" onClick={() => onChangeFrameIdx(Math.max(0, currentIdx - 1))} disabled={currentIdx <= 0}>
          ◀
        </button>
        <button type="button" onClick={onPlayPause}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        {typeof onStop === "function" ? (
          <button type="button" onClick={onStop} title="Detener y volver al inicio">
            Stop
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onChangeFrameIdx(Math.min(Math.max(frames.length - 1, 0), currentIdx + 1))}
          disabled={currentIdx >= frames.length - 1}
        >
          ▶
        </button>
        {showRoi ? (
          <button
            type="button"
            onClick={() => onToggleRoi()}
            className={roiMode ? "adv-btn-active adv-viewer-roi-btn" : "adv-viewer-roi-btn"}
            title={roiMode ? "Modo ROI activo: haz clic para agregar vértices del polígono" : "Activar selección ROI"}
          >
            {roiMode ? "ROI activo" : "ROI"}
          </button>
        ) : null}
        {showRoi && roiHasShape && typeof onClearRoi === "function" ? (
          <button
            type="button"
            onClick={() => onClearRoi()}
            className="adv-viewer-roi-btn"
            title="Quitar polígono ROI"
          >
            Limpiar ROI
          </button>
        ) : null}
      </div>
      {dualPaneRgb ? (
        <div className="adv-viewer-media-dual">
          {indexPane}
          {rgbPane}
        </div>
      ) : (
        singleMedia
      )}
      <div className="adv-viewer-timeline">
        <input
          type="range"
          min={0}
          max={Math.max(frames.length - 1, 0)}
          step={1}
          value={Math.min(currentIdx, Math.max(frames.length - 1, 0))}
          onChange={(e) => onChangeFrameIdx(Number(e.target.value))}
          disabled={!frames.length}
        />
        <div className="adv-viewer-foot">
          <span>
            Escena {frames.length ? currentIdx + 1 : 0}/{frames.length}
          </span>
          <label>
            Opacidad
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => onOpacity(Number(e.target.value))}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
