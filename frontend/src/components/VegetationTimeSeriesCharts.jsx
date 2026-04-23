/**
 * Series temporales por índice: una línea por píxel (muestreadas en el servidor).
 * Eje X proporcional al tiempo; eje Y 0–1 (normalización min-max por escena en backend).
 */

const INDEX_KEYS = ["NDVI", "EVI", "NDWI", "CIre", "MCARI"];

/** Eje X compacto: ``dd/mm/aa`` (S2 y S1). */
function formatDateLabelDdMmYy(iso) {
  if (typeof iso !== "string" || iso.length < 8) return String(iso ?? "");
  if (iso.startsWith("layer-")) return iso;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const yy = m[1].slice(2);
  return `${m[3]}/${m[2]}/${yy}`;
}

function parseSceneTime(d) {
  if (typeof d !== "string") return NaN;
  if (d.startsWith("layer-")) return NaN;
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
}

function formatYTick(v) {
  if (v == null || Number.isNaN(v)) return "";
  return Number(v).toFixed(2);
}

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Math.min(1, Math.max(0, x));
}

function normIsoDate(s) {
  return String(s || "").slice(0, 10);
}

const COLOR_SERIES = "#1565c0";
const COLOR_MEAN_LINE = "#c62828";
/** Tendencia lineal (OLS) — violeta (S2 y S1). */
const COLOR_TREND_LINE = "#7e57c2";

/** Mediana de un array numérico (copia y ordena). */
function medianOf(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Q1 y Q3 tipo Tukey (mediana de mitades inferior/superior). */
function quartilesTukey(sortedFinite) {
  const s = sortedFinite;
  const n = s.length;
  if (n === 0) return { q1: NaN, q3: NaN };
  if (n === 1) return { q1: s[0], q3: s[0] };
  const mid = Math.floor(n / 2);
  const lower = n % 2 === 1 ? s.slice(0, mid + 1) : s.slice(0, mid);
  const upper = n % 2 === 1 ? s.slice(mid) : s.slice(mid);
  return { q1: medianOf(lower), q3: medianOf(upper) };
}

function tukeyFenceBounds(scores, iqrFactor = 1.5) {
  const s = [...scores].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 2) return { low: -Infinity, high: Infinity };
  const { q1, q3 } = quartilesTukey(s);
  const iqr = q3 - q1;
  if (!Number.isFinite(iqr) || iqr <= 0) return { low: -Infinity, high: Infinity };
  return { low: q1 - iqrFactor * iqr, high: q3 + iqrFactor * iqr };
}

/**
 * Elimina series atípicas: distancia a la mediana temporal (MAE respecto a la curva mediana por fecha).
 * Tukey IQR sobre esas distancias. Con pocas series o IQR≈0, se relaja o se omite el filtro para evitar
 * descartes erráticos (p. ej. índices SAR con pocas fechas).
 */
function filterPixelSeriesOutliers(
  seriesList,
  iqrFactor = 1.5,
  minSeriesBeforeFilter = 4,
) {
  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return { kept: [], removed: 0, medianProfile: [], deviationScores: [] };
  }
  const T = seriesList[0].length;
  if (!seriesList.every((s) => Array.isArray(s) && s.length === T)) {
    return { kept: seriesList.slice(), removed: 0, medianProfile: [], deviationScores: [] };
  }
  if (seriesList.length < minSeriesBeforeFilter) {
    const mp = [];
    for (let t = 0; t < T; t += 1) {
      mp.push(medianOf(seriesList.map((s) => s[t])));
    }
    return {
      kept: seriesList.slice(),
      removed: 0,
      medianProfile: mp,
      deviationScores: seriesList.map(() => NaN),
    };
  }

  const medianProfile = [];
  for (let t = 0; t < T; t += 1) {
    medianProfile.push(medianOf(seriesList.map((s) => s[t])));
  }

  const deviationScores = seriesList.map((s) => {
    let sum = 0;
    let c = 0;
    for (let t = 0; t < T; t += 1) {
      if (Number.isFinite(s[t]) && Number.isFinite(medianProfile[t])) {
        sum += Math.abs(s[t] - medianProfile[t]);
        c += 1;
      }
    }
    return c > 0 ? sum / c : NaN;
  });

  let { low, high } = tukeyFenceBounds(deviationScores, iqrFactor);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
    return {
      kept: seriesList.slice(),
      removed: 0,
      medianProfile,
      deviationScores,
    };
  }
  let kept = seriesList.filter((_, i) => {
    const sc = deviationScores[i];
    return Number.isFinite(sc) && sc >= low && sc <= high;
  });
  let removed = seriesList.length - kept.length;

  if (kept.length === 0) {
    return {
      kept: seriesList.slice(),
      removed: 0,
      medianProfile,
      deviationScores,
    };
  }

  return { kept, removed, medianProfile, deviationScores };
}

/** Media por fecha sobre un conjunto de series (misma longitud). */
function meanAcrossSeriesAtEachDate(seriesRows) {
  if (!seriesRows.length) return [];
  const T = seriesRows[0].length;
  const out = [];
  for (let t = 0; t < T; t += 1) {
    let sum = 0;
    let c = 0;
    for (const row of seriesRows) {
      if (Number.isFinite(row[t])) {
        sum += row[t];
        c += 1;
      }
    }
    out.push(c > 0 ? sum / c : NaN);
  }
  return out;
}

/** Media y desviación estándar muestral (eje temporal) de una curva. */
function temporalMeanAndStd(curve) {
  const v = curve.filter(Number.isFinite);
  if (v.length === 0) return { mean: null, std: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length === 1) return { mean, std: 0 };
  const varsum = v.reduce((s, x) => s + (x - mean) ** 2, 0);
  const std = Math.sqrt(varsum / (v.length - 1));
  return { mean, std };
}

/**
 * Tendencia lineal (mínimos cuadrados) ``y ≈ a + b·t`` con ``t`` = tiempo en ms (solo pares finitos).
 * Devuelve función ``(t) => a + b*t`` o null.
 */
function olsLinearTrendFn(times, ys) {
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;
  let n = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const y = ys[i];
    if (!Number.isFinite(t) || y == null || !Number.isFinite(y)) continue;
    sumT += t;
    sumY += y;
    sumTT += t * t;
    sumTY += t * y;
    n += 1;
  }
  if (n < 2) return null;
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-18) return null;
  const b = (n * sumTY - sumT * sumY) / denom;
  const a = (sumY - b * sumT) / n;
  return (t) => a + b * t;
}

function buildPathTimeScaled(times, ys, w, h, padL, padR, padT, padB, yMin, yMax, tMin, tMax) {
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  if (innerW <= 0 || innerH <= 0 || yMax <= yMin) return "";
  const parts = [];
  const n = times.length;
  for (let i = 0; i < n; i += 1) {
    const y = ys[i] != null && Number.isFinite(ys[i]) ? clamp01(ys[i]) : null;
    if (y == null || Number.isNaN(y)) continue;
    const t = times[i];
    let px;
    if (!Number.isFinite(t) || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax === tMin) {
      px = padL + (n === 1 ? innerW / 2 : (i / Math.max(n - 1, 1)) * innerW);
    } else {
      px = padL + ((t - tMin) / (tMax - tMin)) * innerW;
    }
    const py = padT + innerH * (1 - (y - yMin) / (yMax - yMin));
    parts.push(`${parts.length === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)}`);
  }
  return parts.join(" ");
}

function xPixelAt(i, times, w, padL, padR, tMin, tMax, n) {
  const innerW = w - padL - padR;
  const t = times[i];
  if (!Number.isFinite(t) || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax === tMin) {
    return padL + (n === 1 ? innerW / 2 : (i / Math.max(n - 1, 1)) * innerW);
  }
  return padL + ((t - tMin) / (tMax - tMin)) * innerW;
}

function yPixelAt(yVal, h, padT, padB, yMin, yMax) {
  const innerH = h - padT - padB;
  const y = clamp01(yVal);
  if (y == null) return padT + innerH / 2;
  return padT + innerH * (1 - (y - yMin) / (yMax - yMin));
}

function buildLegendTooltipText({ isS1Sar, isPs, meta }) {
  const sensorNote = isS1Sar
    ? "S1 SAR: atípicas con IQR Tukey factor 2.5; filtro solo si hay >=10 series (IQR 0 => no se descarta)."
    : isPs
      ? "PlanetScope: atípicas con IQR Tukey factor 1.5; filtro si hay >=4 series (IQR 0 => no se descarta)."
      : "S2: atípicas con IQR Tukey factor 1.5; filtro si hay >=4 series (IQR 0 => no se descarta).";
  const sample =
    meta?.n_valid_pixels != null && meta?.n_sampled != null
      ? ` Muestreo inicial: ${meta.n_sampled.toLocaleString()} de ${meta.n_valid_pixels.toLocaleString()} píxeles válidos.`
      : "";
  return [
    "Líneas tenues = series por píxel (0–1, min-max por escena/fecha).",
    "Eje X: dd/mm/aa (etiquetas a 45°).",
    "Roja = media temporal tras filtro.",
    "Violeta = tendencia lineal (OLS).",
    "Ref. escenas = medias espaciales por fecha del servidor.",
    sensorNote + sample,
  ].join(" ");
}

function IndexChart({
  indexKey,
  points,
  pixelSeriesList,
  perPixelMeta,
  temporalStatsFromApi,
  isS1Sar = false,
  activeSceneDate = null,
}) {
  const W = 900;
  const H = 260;
  const padL = 58;
  const padR = 20;
  const padT = 16;
  /** Margen inferior: título «Fecha» + fechas a 45° (ancladas a ``yPlotBottom``). */
  const padB = 88;

  const xs = points.map((p) => p.date);
  const times = xs.map(parseSceneTime);
  const finiteT = times.filter((t) => Number.isFinite(t));
  const tMin = finiteT.length ? Math.min(...finiteT) : NaN;
  const tMax = finiteT.length ? Math.max(...finiteT) : NaN;

  const yMin = 0;
  const yMax = 1;
  const tickVals = [0, 0.25, 0.5, 0.75, 1];

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  /** Borde inferior del área de trazado (eje y = 0). */
  const yPlotBottom = padT + innerH;
  /** Etiquetas de fecha pegadas al gráfico (evita solaparse con «Fecha» abajo). */
  const yDateTicks = yPlotBottom + 10;
  const yAxisCaption = H - 5;

  const usePixels = Array.isArray(pixelSeriesList) && pixelSeriesList.length > 0;

  const outlierIqrFactor = isS1Sar ? 2.5 : 1.5;
  const outlierMinSeries = isS1Sar ? 10 : 4;
  const outlierResult = usePixels
    ? filterPixelSeriesOutliers(pixelSeriesList, outlierIqrFactor, outlierMinSeries)
    : null;
  const filteredSeries = outlierResult?.kept ?? [];
  const nOutliersRemoved = outlierResult?.removed ?? 0;
  const nSeriesRaw = usePixels ? pixelSeriesList.length : 0;

  const meanCurvePixels =
    usePixels && filteredSeries.length > 0 ? meanAcrossSeriesAtEachDate(filteredSeries) : [];
  const { mean: muTemporalCurve, std: sigmaTemporalCurve } = temporalMeanAndStd(meanCurvePixels);

  const ysMean = points.map((p) => {
    const v = p.by_index?.[indexKey]?.mean;
    return v != null && Number.isFinite(v) ? v : null;
  });
  const validMean = ysMean.map((y) => y != null && Number.isFinite(y));

  const meanPathSpatialOnly = usePixels
    ? ""
    : buildPathTimeScaled(times, ysMean, W, H, padL, padR, padT, padB, yMin, yMax, tMin, tMax);

  const meanPathRed =
    usePixels && meanCurvePixels.length > 0
      ? buildPathTimeScaled(
          times,
          meanCurvePixels,
          W,
          H,
          padL,
          padR,
          padT,
          padB,
          yMin,
          yMax,
          tMin,
          tMax
        )
      : "";

  const curveForTrend =
    usePixels && meanCurvePixels.length > 0
      ? meanCurvePixels
      : ysMean.map((y) => (y != null && Number.isFinite(y) ? y : NaN));
  const trendFn = curveForTrend.some((y) => Number.isFinite(y))
    ? olsLinearTrendFn(times, curveForTrend)
    : null;
  const trendYs =
    trendFn != null
      ? times.map((t) => {
          if (!Number.isFinite(t)) return null;
          const v = trendFn(t);
          if (!Number.isFinite(v)) return null;
          return clamp01(v);
        })
      : [];
  const trendPath =
    trendFn != null && trendYs.some((y) => y != null && Number.isFinite(y))
      ? buildPathTimeScaled(times, trendYs, W, H, padL, padR, padT, padB, yMin, yMax, tMin, tMax)
      : "";

  const fmtDate = formatDateLabelDdMmYy;

  const nScenes = points.length;
  const activeIdx = (() => {
    const target = normIsoDate(activeSceneDate);
    if (!target) return -1;
    return xs.findIndex((d) => normIsoDate(d) === target);
  })();
  const activeX =
    activeIdx >= 0 ? xPixelAt(activeIdx, times, W, padL, padR, tMin, tMax, xs.length) : null;

  const apiMu = temporalStatsFromApi?.mean;
  const apiSigma = temporalStatsFromApi?.std;

  const statsTooltip = usePixels
    ? `${isS1Sar ? "Fechas" : "Escenas"}: ${nScenes} · series dibujadas: ${filteredSeries.length}${
        nSeriesRaw > 0
          ? ` (muestreo ${nSeriesRaw}${
              perPixelMeta?.n_valid_pixels != null ? ` de ${perPixelMeta.n_valid_pixels.toLocaleString()} píxeles válidos` : ""
            }${nOutliersRemoved > 0 ? ` · ${nOutliersRemoved} atípicas (IQR Tukey, factor ${outlierIqrFactor})` : ""})`
          : ""
      }. Curva media (rojo, tras filtro): μ temporal = ${
        muTemporalCurve != null ? muTemporalCurve.toFixed(4) : "—"
      } · σ temporal = ${sigmaTemporalCurve != null ? sigmaTemporalCurve.toFixed(4) : "—"}${
        apiMu != null && Number.isFinite(apiMu)
          ? ` · ref. escenas (media espacial/fecha): μ = ${apiMu.toFixed(4)}${
              apiSigma != null && Number.isFinite(apiSigma) ? ` · σ = ${apiSigma.toFixed(4)}` : ""
            }`
          : ""
      }`
    : `${isS1Sar ? "Fechas" : "Escenas"}: ${nScenes}. Media espacial por fecha: μ temporal = ${
        apiMu != null && Number.isFinite(apiMu) ? apiMu.toFixed(4) : "—"
      } · σ temporal = ${apiSigma != null && Number.isFinite(apiSigma) ? apiSigma.toFixed(4) : "—"}`;

  return (
    <div className="vts-chart-block">
      <div className="vts-chart-heading">
        <h4 className="vts-chart-title">
          {indexKey} <span className="vts-chart-scale-hint">(0–1)</span>
        </h4>
        <button
          type="button"
          className="vts-info-icon"
          title={`Info ${indexKey}: ${statsTooltip}`}
          aria-label={`Información ${indexKey}`}
        >
          i
        </button>
      </div>
      <svg
        className="vts-chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Series por píxel ${indexKey}`}
      >
        <rect width={W} height={H} fill="#fafafa" rx={4} />
        {tickVals.map((yv, j) => {
          const py = yPixelAt(yv, H, padT, padB, yMin, yMax);
          return (
            <g key={`yt-${j}`}>
              <line
                x1={padL - 4}
                x2={padL + innerW}
                y1={py}
                y2={py}
                stroke="#e0e0e0"
                strokeWidth={j === 0 || j === tickVals.length - 1 ? 1 : 0.6}
                opacity={0.9}
              />
              <text
                x={padL - 8}
                y={py + 4}
                fontSize={11}
                fill="#444"
                textAnchor="end"
              >
                {formatYTick(yv)}
              </text>
            </g>
          );
        })}
        <text
          x={14}
          y={padT + innerH / 2}
          fontSize={11}
          fill="#555"
          transform={`rotate(-90 14 ${padT + innerH / 2})`}
          textAnchor="middle"
        >
          Índice
        </text>
        {Number.isFinite(activeX) ? (
          <line
            x1={activeX}
            x2={activeX}
            y1={padT}
            y2={padT + innerH}
            stroke="#4b5563"
            strokeWidth={2.4}
            strokeDasharray="4 3"
            opacity={0.95}
          />
        ) : null}
        {usePixels
          ? filteredSeries.map((series, idx) => {
              const d = buildPathTimeScaled(
                times,
                series,
                W,
                H,
                padL,
                padR,
                padT,
                padB,
                yMin,
                yMax,
                tMin,
                tMax
              );
              if (!d) return null;
              return (
                <path
                  key={`px-${idx}`}
                  d={d}
                  fill="none"
                  stroke={COLOR_SERIES}
                  strokeWidth={1}
                  strokeOpacity={0.07}
                  strokeLinejoin="round"
                />
              );
            })
          : null}
        {usePixels && meanPathRed ? (
          <path
            d={meanPathRed}
            fill="none"
            stroke={COLOR_MEAN_LINE}
            strokeWidth={2.8}
            strokeLinejoin="round"
          />
        ) : null}
        {!usePixels && meanPathSpatialOnly ? (
          <path
            d={meanPathSpatialOnly}
            fill="none"
            stroke={COLOR_SERIES}
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
        ) : null}
        {trendPath ? (
          <path
            d={trendPath}
            fill="none"
            stroke={COLOR_TREND_LINE}
            strokeWidth={2.2}
            strokeLinejoin="round"
            opacity={0.95}
          />
        ) : null}
        {!usePixels
          ? xs.map((d, i) => {
              if (!validMean[i] || ysMean[i] == null) return null;
              const px = xPixelAt(i, times, W, padL, padR, tMin, tMax, xs.length);
              const yMean = clamp01(ysMean[i]);
              const py = yPixelAt(yMean, H, padT, padB, yMin, yMax);
              const npx = points[i].by_index?.[indexKey]?.n_pixels;
              const lbl = fmtDate(d);
              return (
                <g key={`${d}-${i}`}>
                  <circle cx={px} cy={py} r={4.5} fill={COLOR_SERIES} stroke="#fff" strokeWidth={1.5} />
                  <text
                    x={px}
                    y={yDateTicks}
                    fontSize={10}
                    fill="#333"
                    textAnchor="end"
                    fontWeight={600}
                    transform={`rotate(-45 ${px} ${yDateTicks})`}
                  >
                    {lbl}
                  </text>
                  <text x={px} y={yDateTicks + 16} fontSize={9} fill="#666" textAnchor="middle">
                    N = {npx != null ? npx.toLocaleString() : "—"}
                  </text>
                </g>
              );
            })
          : xs.map((d, i) => {
              const px = xPixelAt(i, times, W, padL, padR, tMin, tMax, xs.length);
              const lbl = fmtDate(d);
              return (
                <text
                  key={`xlab-${d}-${i}`}
                  x={px}
                  y={yDateTicks}
                  fontSize={10}
                  fill="#333"
                  textAnchor="end"
                  fontWeight={600}
                  transform={`rotate(-45 ${px} ${yDateTicks})`}
                >
                  {lbl}
                </text>
              );
            })}
        <text
          x={padL + innerW / 2}
          y={yAxisCaption}
          fontSize={11}
          fill="#444"
          textAnchor="middle"
        >
          Fecha
        </text>
      </svg>
    </div>
  );
}

export default function VegetationTimeSeriesCharts({ data, onlyIndexKey = null, activeSceneDate = null }) {
  const rawPoints = data?.points?.length ? [...data.points] : [];
  const dateFallback =
    Array.isArray(data?.dates) && data.dates.length
      ? data.dates.map((d) => ({ date: d, by_index: {} }))
      : [];
  const points = rawPoints.length ? rawPoints : dateFallback;

  const allKeys = Array.isArray(data.indices) && data.indices.length ? data.indices : INDEX_KEYS;
  const keys =
    onlyIndexKey && allKeys.includes(onlyIndexKey)
      ? [onlyIndexKey]
      : onlyIndexKey
        ? []
        : allKeys;
  const compact = Boolean(onlyIndexKey);

  const pp = data?.per_pixel;
  const seriesMap = pp?.series_by_index;
  const hasPixelSeries =
    seriesMap && typeof seriesMap === "object" && keys.some((k) => (seriesMap[k]?.length ?? 0) > 0);

  if (onlyIndexKey && keys.length === 0) {
    return <p className="vts-empty">Sin serie para el índice {onlyIndexKey}.</p>;
  }

  if (!points.length && !hasPixelSeries) {
    return <p className="vts-empty">Sin datos.</p>;
  }

  const meta = pp
    ? {
        n_sampled: pp.n_sampled,
        n_valid_pixels: pp.n_valid_pixels,
        max_requested: pp.max_requested,
      }
    : null;

  const isS1Sar = data?.source === "s1_sar";
  const isPs = data?.pipeline_variant === "ps";
  const legendTooltip = buildLegendTooltipText({ isS1Sar, isPs, meta });

  return (
    <div className={`vts-charts-wrap${compact ? " vts-charts-wrap--compact" : ""}`}>
      {!compact ? (
        <div className="vts-chart-legend-icon-wrap">
          <button type="button" className="vts-info-icon" title={legendTooltip} aria-label="Información de la serie">
            i
          </button>
        </div>
      ) : null}
      {keys.map((key) => (
        <IndexChart
          key={key}
          indexKey={key}
          points={points}
          pixelSeriesList={hasPixelSeries ? seriesMap[key] || [] : []}
          perPixelMeta={meta}
          temporalStatsFromApi={data?.temporal_stats?.[key]}
          isS1Sar={isS1Sar}
          activeSceneDate={activeSceneDate}
        />
      ))}
    </div>
  );
}
