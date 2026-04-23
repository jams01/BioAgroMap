function normIso(s) {
  return String(s || "").slice(0, 10);
}

function monthLabelFromIso(iso) {
  const d = normIso(iso);
  if (d.length < 7) return d;
  return `${d.slice(5, 7)}/${d.slice(2, 4)}`;
}

function parseSceneTime(iso) {
  const d = normIso(iso);
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
}

function computeScale(data, keys) {
  const vals = [];
  for (const r of data || []) {
    for (const k of keys) {
      const v = Number(r?.[k]);
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.08;
  const lo = min - (pad || 1);
  const hi = max + (pad || 1);
  return { min: lo, max: hi };
}

function yPixel(v, scale, padT, innerH) {
  if (!scale || !Number.isFinite(v) || scale.max <= scale.min) return padT + innerH / 2;
  return padT + (1 - (v - scale.min) / (scale.max - scale.min)) * innerH;
}

function pathForVar(data, key, xs, scale, padT, innerH) {
  const parts = [];
  for (let i = 0; i < data.length; i += 1) {
    const v = Number(data[i]?.[key]);
    if (!Number.isFinite(v)) continue;
    const px = xs[i];
    const py = yPixel(v, scale, padT, innerH);
    parts.push(`${parts.length === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)}`);
  }
  return parts.join(" ");
}

function axisTicks(scale, n = 4) {
  if (!scale) return [];
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(scale.min + ((scale.max - scale.min) * i) / n);
  }
  return out;
}

export default function ClimateTimeSeriesChart({ data, activeVars, activeSceneDate }) {
  if (!data?.length) return <p className="adv-climate-empty">Sin datos agroclimáticos.</p>;
  const enabled = ["precip", "temp", "humidity", "radiation"].filter((k) => activeVars?.[k]);
  if (!enabled.length) return <p className="adv-climate-empty">Activa al menos una variable climática.</p>;

  const leftKeys = enabled.filter((k) => k === "precip" || k === "radiation");
  const rightKeys = enabled.filter((k) => k === "temp" || k === "humidity");
  const leftScale = computeScale(data, leftKeys);
  const rightScale = computeScale(data, rightKeys);
  const fallbackScale = leftScale || rightScale;

  const W = 900;
  const H = 180;
  const padL = 58;
  const padR = 20;
  const padT = 16;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const times = data.map((d) => parseSceneTime(d?.date));
  const finiteT = times.filter((t) => Number.isFinite(t));
  const tMin = finiteT.length ? Math.min(...finiteT) : NaN;
  const tMax = finiteT.length ? Math.max(...finiteT) : NaN;
  const xAt = (i) => {
    const t = times[i];
    if (!Number.isFinite(t) || !Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax === tMin) {
      return padL + (i * innerW) / Math.max(data.length - 1, 1);
    }
    return padL + ((t - tMin) / (tMax - tMin)) * innerW;
  };
  const xs = data.map((_, i) => xAt(i));
  const activeIdx = data.findIndex((d) => normIso(d.date) === normIso(activeSceneDate));
  const activeX = activeIdx >= 0 ? xs[activeIdx] : null;
  const step = Math.max(1, Math.ceil(data.length / 8));

  const colors = { precip: "#1976d2", temp: "#e65100", humidity: "#2e7d32", radiation: "#6a1b9a" };
  const varAxis = {
    precip: leftScale ? "left" : "right",
    radiation: leftScale ? "left" : "right",
    temp: rightScale ? "right" : "left",
    humidity: rightScale ? "right" : "left",
  };

  const leftTicks = axisTicks(leftScale || (rightScale ? null : fallbackScale));
  const rightTicks = axisTicks(rightScale || null);

  return (
    <svg className="adv-climate-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Serie climática mensual">
      <rect x={0} y={0} width={W} height={H} fill="#fff" rx={6} />

      {leftTicks.map((t, i) => {
        const py = yPixel(t, leftScale || fallbackScale, padT, innerH);
        return (
          <g key={`left-tick-${i}`}>
            <line x1={padL} x2={padL + innerW} y1={py} y2={py} stroke="#e5e7eb" strokeWidth="1" />
            <text x={padL - 6} y={py + 4} fontSize={10} fill="#6b7280" textAnchor="end">
              {t.toFixed(1)}
            </text>
          </g>
        );
      })}

      {rightTicks.map((t, i) => {
        const py = yPixel(t, rightScale, padT, innerH);
        return (
          <text key={`right-tick-${i}`} x={W - 2} y={py + 4} fontSize={10} fill="#6b7280" textAnchor="end">
            {t.toFixed(1)}
          </text>
        );
      })}

      {Number.isFinite(activeX) ? (
        <line
          x1={activeX}
          x2={activeX}
          y1={padT}
          y2={padT + innerH}
          stroke="#4b5563"
          strokeWidth="2.2"
          strokeDasharray="4 3"
          opacity={0.9}
        />
      ) : null}

      {enabled.map((k) => {
        const scale = varAxis[k] === "left" ? leftScale || fallbackScale : rightScale || fallbackScale;
        const d = pathForVar(data, k, xs, scale, padT, innerH);
        if (!d) return null;
        return <path key={k} d={d} fill="none" stroke={colors[k]} strokeWidth="2.1" />;
      })}

      {data.map((d, i) => {
        if (i % step !== 0 && i !== data.length - 1) return null;
        return (
          <text key={`x-${d.date}-${i}`} x={xs[i]} y={H - 8} fontSize={10} fill="#4b5563" textAnchor="middle">
            {monthLabelFromIso(d.date)}
          </text>
        );
      })}

      <text x={padL} y={12} fontSize={10} fill="#6b7280" textAnchor="start">
        Eje izq: Precipitación / Radiación
      </text>
      <text x={padL + innerW} y={12} fontSize={10} fill="#6b7280" textAnchor="end">
        Eje der: Temperatura / Humedad
      </text>
    </svg>
  );
}
