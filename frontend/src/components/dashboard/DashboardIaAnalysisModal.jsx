import { useEffect, useMemo, useState } from "react";
import api, { formatApiErrorDetail } from "../../api";
import { appendPlanetIntegralAppendix, buildDashboardIaTechnicalReport } from "./dashboardIaAnalysis";
import { ensureMortalidadFigures, getCustomIaReportUrl } from "./customIaReports";

export function DigitalBrainIcon({ className, size = 22 }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M12 3.5c-1.2 0-2.2.55-2.85 1.4-.25-.08-.52-.12-.8-.12-1.1 0-2 .75-2.25 1.75-.85.25-1.45 1-1.45 1.9 0 .45.15.85.4 1.2-.15.35-.25.75-.25 1.15 0 .95.55 1.75 1.35 2.15v.85c0 1.15.9 2.1 2.05 2.1h.15c.55.95 1.55 1.6 2.7 1.6s2.2-.65 2.75-1.6h.2c1.1 0 2-.95 2-2.1v-.85c.85-.4 1.4-1.2 1.4-2.15 0-.4-.1-.8-.25-1.15.25-.35.4-.75.4-1.2 0-.9-.6-1.65-1.45-1.9-.25-1-1.15-1.75-2.25-1.75-.28 0-.55.04-.8.12C14.2 4.05 13.2 3.5 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="10" r="0.9" fill="currentColor" />
      <circle cx="15" cy="10" r="0.9" fill="currentColor" />
      <path d="M12 12.2v2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M6.5 8.5h-1M17.5 8.5h1M7 14.5H6M18 14.5h-1M12 5.5V4"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
}

/** `**negrita**` y `` `código` `` sin asteriscos/backticks sueltos (evita fallos con `**texto:**` etc.). */
function renderReportInline(text, keyPrefix) {
  const s = String(text);
  const out = [];
  let i = 0;
  let part = 0;
  const pushPlain = (from, to) => {
    if (from < to) out.push(<span key={`${keyPrefix}-p-${part++}`}>{s.slice(from, to)}</span>);
  };
  while (i < s.length) {
    if (s.slice(i, i + 2) === "**") {
      const j = s.indexOf("**", i + 2);
      if (j === -1) {
        pushPlain(i, s.length);
        break;
      }
      out.push(
        <strong key={`${keyPrefix}-b-${part++}`} className="adv-ia-strong">
          {s.slice(i + 2, j)}
        </strong>,
      );
      i = j + 2;
      continue;
    }
    if (s[i] === "`") {
      const j = s.indexOf("`", i + 1);
      if (j === -1) {
        pushPlain(i, s.length);
        break;
      }
      out.push(
        <code key={`${keyPrefix}-c-${part++}`} className="adv-ia-code">
          {s.slice(i + 1, j)}
        </code>,
      );
      i = j + 1;
      continue;
    }
    const ns = s.indexOf("**", i);
    const nb = s.indexOf("`", i);
    let next = s.length;
    if (ns >= 0) next = Math.min(next, ns);
    if (nb >= 0) next = Math.min(next, nb);
    pushPlain(i, next);
    i = next;
  }
  return out;
}

function parseTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
  return cells.length ? cells : null;
}

function isTableSeparatorRow(line) {
  const cells = parseTableRow(line);
  if (!cells) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseImageLine(line) {
  const trimmed = String(line || "").trim();
  const m = trimmed.match(/^!\[([^\]]*)\]\((.+)\)$/);
  if (!m) return null;
  return { alt: m[1].trim(), src: m[2].trim() };
}

function parseCaptionLine(line) {
  const trimmed = String(line || "").trim();
  const m = trimmed.match(/^\*([^*]+)\*$/);
  if (!m) return null;
  return m[1].trim();
}

function formatBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let buf = [];
  let tableRows = [];

  const flushPara = () => {
    if (buf.length) {
      blocks.push(buf.join("\n"));
      buf = [];
    }
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const header = tableRows[0];
    const body = tableRows.slice(1);
    blocks.push({ type: "table", header, rows: body });
    tableRows = [];
  };

  for (const line of lines) {
    const row = parseTableRow(line);
    if (row && !isTableSeparatorRow(line)) {
      flushPara();
      tableRows.push(row);
      continue;
    }
    if (row && isTableSeparatorRow(line)) {
      continue;
    }
    flushTable();
    const image = parseImageLine(line);
    if (image) {
      flushPara();
      blocks.push({ type: "figure", alt: image.alt, src: image.src, caption: null });
      continue;
    }
    const caption = parseCaptionLine(line);
    if (caption && blocks.length && blocks[blocks.length - 1]?.type === "figure") {
      const prev = blocks[blocks.length - 1];
      if (!prev.caption) {
        blocks[blocks.length - 1] = { ...prev, caption };
        continue;
      }
    }
    if (line.startsWith("# ")) {
      flushPara();
      blocks.push({ type: "h1", text: line.slice(2).trim() });
    } else if (line.startsWith("## ")) {
      flushPara();
      blocks.push({ type: "h", text: line.slice(3).trim() });
    } else if (line.startsWith("### ")) {
      flushPara();
      blocks.push({ type: "h3", text: line.slice(4).trim() });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      buf.push(line);
    }
  }
  flushTable();
  flushPara();
  return blocks;
}

function ReportFigure({ src, alt, caption, keyPrefix }) {
  return (
    <figure className="adv-ia-figure">
      <img
        className="adv-ia-figure-img"
        src={src}
        alt={alt || caption || "Figura del informe"}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.display = "none";
          const msg = e.currentTarget.nextElementSibling;
          if (msg?.classList?.contains("adv-ia-figure-fallback")) return;
          const el = document.createElement("p");
          el.className = "adv-ia-figure-fallback";
          el.textContent = "No se pudo cargar la imagen. Recargue la pagina (Ctrl+F5).";
          e.currentTarget.parentElement?.appendChild(el);
        }}
      />
      {caption ? (
        <figcaption className="adv-ia-figure-caption">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

function ReportTable({ header, rows, keyPrefix }) {
  return (
    <div className="adv-ia-table-wrap">
      <table className="adv-ia-table">
        <thead>
          <tr>
            {header.map((cell, ci) => (
              <th key={`${keyPrefix}-h-${ci}`}>{renderReportInline(cell, `${keyPrefix}-th-${ci}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={`${keyPrefix}-r-${ri}`}>
              {row.map((cell, ci) => (
                <td key={`${keyPrefix}-c-${ri}-${ci}`}>{renderReportInline(cell, `${keyPrefix}-td-${ri}-${ci}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardIaAnalysisModal({ open, onClose, iaContext }) {
  const [planetIntegral, setPlanetIntegral] = useState(null);
  const [integralLoading, setIntegralLoading] = useState(false);
  const [integralError, setIntegralError] = useState("");
  const [customMarkdown, setCustomMarkdown] = useState("");
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState("");

  const customReportUrl = useMemo(
    () =>
      iaContext
        ? getCustomIaReportUrl({
            projectId: iaContext.projectId,
            projectName: iaContext.projectName,
          })
        : null,
    [iaContext?.projectId, iaContext?.projectName],
  );

  const base = useMemo(() => {
    if (!iaContext || customReportUrl) return { report: "", disclaimer: "" };
    return buildDashboardIaTechnicalReport(iaContext);
  }, [iaContext, customReportUrl]);

  useEffect(() => {
    if (!open || !iaContext?.projectId || customReportUrl) {
      setPlanetIntegral(null);
      setIntegralError("");
      setIntegralLoading(false);
      return undefined;
    }
    let cancelled = false;
    setIntegralLoading(true);
    setIntegralError("");
    setPlanetIntegral(null);
    (async () => {
      try {
        const { data } = await api.get(`/preprocess/dashboard-ia-planet-integral/${iaContext.projectId}`, {
          params: { max_scenes: 48 },
        });
        if (!cancelled) setPlanetIntegral(data);
      } catch (e) {
        if (!cancelled) setIntegralError(formatApiErrorDetail(e));
      } finally {
        if (!cancelled) setIntegralLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, iaContext?.projectId, customReportUrl]);

  useEffect(() => {
    if (!open || !customReportUrl) {
      setCustomMarkdown("");
      setCustomError("");
      setCustomLoading(false);
      return undefined;
    }
    let cancelled = false;
    setCustomLoading(true);
    setCustomError("");
    (async () => {
      try {
        const res = await fetch(`${customReportUrl}?v=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`No se pudo cargar el informe (${res.status})`);
        const text = await res.text();
        if (!cancelled) setCustomMarkdown(text);
      } catch (e) {
        if (!cancelled) setCustomError(e?.message || "Error al cargar el informe");
      } finally {
        if (!cancelled) setCustomLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, customReportUrl]);

  const fullReport = useMemo(() => {
    if (customReportUrl) return customMarkdown;
    let r = base.report;
    if (planetIntegral) r = appendPlanetIntegralAppendix(r, planetIntegral);
    return r;
  }, [customReportUrl, customMarkdown, base.report, planetIntegral]);

  const isCustom = !!customReportUrl;

  const blocks = useMemo(() => {
    let parsed = formatBlocks(fullReport);
    if (isCustom) parsed = ensureMortalidadFigures(parsed);
    return parsed;
  }, [fullReport, isCustom]);

  if (!open) return null;

  return (
    <div className="adv-ia-overlay" role="dialog" aria-modal="true" aria-labelledby="adv-ia-report-title">
      <div className="adv-ia-backdrop" onClick={onClose} />
      <div className={`adv-ia-window adv-ia-window--report${isCustom ? " adv-ia-window--report-custom" : ""}`}>
        <div className="adv-ia-header adv-ia-header--report">
          <div className="adv-ia-header-title">
            <DigitalBrainIcon className="adv-ia-header-icon" size={24} />
            <h3 id="adv-ia-report-title">
              {isCustom ? "Informe agronómico — Palma Vichada" : "Informe técnico (ingeniería agronómica)"}
            </h3>
          </div>
          <button type="button" className="adv-close-btn" onClick={onClose} aria-label="Cerrar ventana">
            ×
          </button>
        </div>
        <p className="adv-ia-sub adv-ia-sub--report">
          {iaContext?.projectName ? `Proyecto: ${String(iaContext.projectName).trim()}` : null}
        </p>
        <div className="adv-ia-body adv-ia-body--report" role="document">
          {isCustom ? (
            <header className="adv-ia-report-hero">
              <img className="adv-ia-report-logo" src="/logo-bioagro.png" alt="BioAgroMap" />
              <h2 className="adv-ia-report-hero-title">Agricultura más Inteligente con BioAgro</h2>
            </header>
          ) : null}
          {customLoading ? (
            <p className="adv-ia-integral-status">Cargando informe Palma Vichada…</p>
          ) : null}
          {customError ? (
            <p className="adv-ia-integral-status adv-ia-integral-status--err">{customError}</p>
          ) : null}
          {!isCustom && integralLoading ? (
            <p className="adv-ia-integral-status">Analizando todas las escenas Planet en servidor (NDVI, RGB, textura)…</p>
          ) : null}
          {!isCustom && integralError ? (
            <p className="adv-ia-integral-status adv-ia-integral-status--err">
              No se pudo completar el análisis multi-escena: {integralError}
            </p>
          ) : null}
          {blocks.map((b, i) => {
            if (typeof b === "object" && b?.type === "h1") {
              const isMortalidad = /4\.\s*ANALISIS DE MORTALIDAD/i.test(String(b.text || ""));
              return (
                <h3
                  key={`h1-${i}`}
                  id={isMortalidad ? "informe-mortalidad" : undefined}
                  className="adv-ia-chapter-title"
                >
                  {renderReportInline(b.text, `h1-${i}`)}
                </h3>
              );
            }
            if (typeof b === "object" && b?.type === "h") {
              return (
                <h4 key={`h-${i}`} className="adv-ia-section-title">
                  {renderReportInline(b.text, `h-${i}`)}
                </h4>
              );
            }
            if (typeof b === "object" && b?.type === "h3") {
              return (
                <h5 key={`h3-${i}`} className="adv-ia-subsection-title">
                  {renderReportInline(b.text, `h3-${i}`)}
                </h5>
              );
            }
            if (typeof b === "object" && b?.type === "table") {
              return (
                <ReportTable
                  key={`tbl-${i}`}
                  keyPrefix={`tbl-${i}`}
                  header={b.header}
                  rows={b.rows}
                />
              );
            }
            if (typeof b === "object" && (b?.type === "figure" || b?.type === "image")) {
              return (
                <ReportFigure
                  key={`fig-${i}`}
                  keyPrefix={`fig-${i}`}
                  src={b.src}
                  alt={b.alt}
                  caption={b.caption || null}
                />
              );
            }
            return (
              <p key={`p-${i}`} className="adv-ia-paragraph">
                {String(b).split("\n").map((line, j) => (
                  <span key={j}>
                    {renderReportInline(line, `p-${i}-${j}`)}
                    {j < String(b).split("\n").length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            );
          })}
        </div>
      </div>
    </div>
  );
}
