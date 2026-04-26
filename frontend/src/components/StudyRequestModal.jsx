import { useEffect, useState } from "react";
import api, { setAuthToken } from "../api";
import { bboxFromGeojson, kmlToGeojson, kmzToGeojson } from "../utils/geo";

const CROPS = ["Maíz", "Arroz", "Café", "Caña", "Palma", "Otro"];

export default function StudyRequestModal({
  open,
  onClose,
  token,
  onOrderSuccess,
  addMapLayer,
  paintLayerOnMap,
  mapRef,
  bboxFromGeojson: bboxFn,
  setStudyDraw,
  finalizeStudyPolygon,
  setMessage,
  drawMode,
}) {
  const [step, setStep] = useState("source");
  const [geometry, setGeometry] = useState(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [error, setError] = useState("");
  const [successOrderId, setSuccessOrderId] = useState(null);
  const [mapHint, setMapHint] = useState("");

  const [projectName, setProjectName] = useState("");
  const [studyDateStart, setStudyDateStart] = useState("");
  const [studyDateEnd, setStudyDateEnd] = useState("");
  const [company, setCompany] = useState("");
  const [crop, setCrop] = useState("");
  const [cropOther, setCropOther] = useState("");
  const [ageYears, setAgeYears] = useState("");
  const [hasWeather, setHasWeather] = useState(false);
  const [hasSoil, setHasSoil] = useState(false);
  const [extraNotes, setExtraNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("source");
    setGeometry(null);
    setError("");
    setSuccessOrderId(null);
    setMapHint("");
    setFileBusy(false);
    setSubmitBusy(false);
    setProjectName("");
    setStudyDateStart("");
    setStudyDateEnd("");
    setCompany("");
    setCrop("");
    setCropOther("");
    setAgeYears("");
    setHasWeather(false);
    setHasSoil(false);
    setExtraNotes("");
    setStudyDraw?.(null);
  }, [open, setStudyDraw]);

  function handleClose() {
    setStudyDraw?.(null);
    setStep("source");
    setGeometry(null);
    setError("");
    setSuccessOrderId(null);
    setMapHint("");
    onClose?.();
  }

  function applyGeometryToMap(gj, originLabel) {
    setGeometry(gj);
    const lid = addMapLayer("Estudio AgroGeoFísico (lote)", "vector", gj, null, { append: true });
    paintLayerOnMap(lid, gj);
    const bbox = bboxFn(gj);
    if (bbox && mapRef?.current) {
      mapRef.current.fitBounds(bbox, { padding: 80, maxZoom: 17 });
    }
    setStep("form");
    setStudyDraw?.(null);
    setMapHint(originLabel || "");
    setMessage?.("Área aplicada en el mapa y en Capas. Complete el paso 2.");
  }

  async function onPickFile(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !token) return;
    setFileBusy(true);
    setError("");
    setMapHint("");
    try {
      const lower = file.name.toLowerCase();
      let gj = null;
      if (lower.endsWith(".geojson") || lower.endsWith(".json")) {
        const text = await file.text();
        gj = JSON.parse(text);
      } else if (lower.endsWith(".kml")) {
        const text = await file.text();
        gj = kmlToGeojson(text);
      } else if (lower.endsWith(".kmz")) {
        gj = await kmzToGeojson(file);
      }
      if (!gj) {
        setAuthToken(token);
        const form = new FormData();
        form.append("file", file);
        const res = await api.post("/study-orders/parse-vector", form);
        gj = res.data;
      }
      if (!gj) throw new Error("No se pudo obtener geometría del archivo");
      applyGeometryToMap(gj, `Archivo: ${file.name}`);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "No se pudo leer el archivo. Revise el formato.");
    } finally {
      setFileBusy(false);
    }
  }

  function startPolygonDraw() {
    setError("");
    setMapHint("");
    setStep("draw");
    setStudyDraw({
      active: true,
      mode: "polygon",
      finalizePolygonKey: 0,
      onPolygonTooFew: () => {
        setError("Añada al menos 3 puntos en el mapa (clics) y pulse «Finalizar polígono».");
      },
      onComplete: (gj) => {
        applyGeometryToMap(gj, "Polígono dibujado a mano alzada");
      },
    });
  }

  function startRectangleDraw() {
    setError("");
    setMapHint("");
    setStep("draw");
    setStudyDraw({
      active: true,
      mode: "rectangle",
      finalizePolygonKey: 0,
      onComplete: (gj) => {
        applyGeometryToMap(gj, "Rectángulo en el mapa");
      },
    });
  }

  function cancelDraw() {
    setStudyDraw?.(null);
    setStep("source");
    setError("");
    setMapHint("");
  }

  async function submitOrder(e) {
    e.preventDefault();
    if (!geometry) {
      setError("Primero debe definir el área del lote (paso 1).");
      return;
    }
    if (!projectName.trim() || !studyDateStart || !studyDateEnd) {
      setError("Nombre del proyecto y ambas fechas del estudio son obligatorios.");
      return;
    }
    const cropVal = crop === "Otro" ? cropOther.trim() : crop.trim();
    let age = null;
    if (String(ageYears).trim() !== "") {
      const n = Number(ageYears);
      if (!Number.isFinite(n) || n < 0) {
        setError("Indique una edad válida o déjela vacía.");
        return;
      }
      age = Math.floor(n);
    }
    setSubmitBusy(true);
    setError("");
    try {
      setAuthToken(token);
      const res = await api.post("/study-orders", {
        geometry,
        project_name: projectName.trim(),
        study_date_start: studyDateStart,
        study_date_end: studyDateEnd,
        company: company.trim() || null,
        crop: cropVal || null,
        age_years: age,
        has_weather_data: hasWeather,
        has_soil_data: hasSoil,
        extra_notes: extraNotes.trim() || null,
      });
      const id = res.data?.id;
      setSuccessOrderId(id != null ? Number(id) : null);
      setStep("success");
      setMessage?.("");
      onOrderSuccess?.();
    } catch (err) {
      const d = err?.response?.data?.detail;
      setError(typeof d === "string" ? d : err?.message || "No se pudo enviar. Intente de nuevo.");
    } finally {
      setSubmitBusy(false);
    }
  }

  if (!open) return null;

  const isDrawing = step === "draw";
  const step1Active = step === "source" || step === "draw";
  const step1Done = step === "form" || step === "success";
  const step2Active = step === "form";
  const step2Done = step === "success";
  const step3Active = step === "success";

  return (
    <div
      className={`study-modal-overlay${isDrawing ? " study-modal-overlay--drawing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="study-modal-title"
      aria-busy={fileBusy || submitBusy}
    >
      <div
        className="study-modal-backdrop"
        onClick={() => {
          if (step !== "success") handleClose();
        }}
      />
      <div className={`study-modal${isDrawing ? " study-modal--drawing" : ""}`}>
        <div className="study-modal-header">
          <h3 id="study-modal-title">Solicitud de estudio AgroGeoFísico</h3>
          <button type="button" className="index-modal-close" onClick={handleClose} aria-label="Cerrar">
            &times;
          </button>
        </div>

        <nav className="study-stepper" aria-label="Progreso del trámite">
          <div
            className={`study-stepper-item${step1Active ? " study-stepper-item--active" : ""}${step1Done ? " study-stepper-item--done" : ""}`}
          >
            <span className="study-stepper-num" aria-hidden="true">
              {step1Done ? "✓" : "1"}
            </span>
            <span className="study-stepper-label">Área del lote</span>
          </div>
          <span className={`study-stepper-line${step1Done ? " study-stepper-line--done" : ""}`} aria-hidden="true" />
          <div
            className={`study-stepper-item${step2Active ? " study-stepper-item--active" : ""}${step2Done ? " study-stepper-item--done" : ""}`}
          >
            <span className="study-stepper-num" aria-hidden="true">
              {step2Done ? "✓" : "2"}
            </span>
            <span className="study-stepper-label">Datos del estudio</span>
          </div>
          <span className={`study-stepper-line${step2Done ? " study-stepper-line--done" : ""}`} aria-hidden="true" />
          <div className={`study-stepper-item${step3Active ? " study-stepper-item--active study-stepper-item--success" : ""}`}>
            <span className="study-stepper-num" aria-hidden="true">
              {step3Active ? "✓" : "3"}
            </span>
            <span className="study-stepper-label">Confirmación</span>
          </div>
        </nav>

        <div className="study-modal-body">
          <div className="study-live-region" role="status" aria-live="polite">
            {fileBusy ? "Procesando archivo del polígono…" : ""}
            {submitBusy ? "Enviando solicitud…" : ""}
            {isDrawing && drawMode === "polygon" ? "Modo dibujo: polígono libre activo en el mapa." : ""}
            {isDrawing && drawMode === "rectangle" ? "Modo dibujo: rectángulo — dos clics en el mapa." : ""}
          </div>

          {error ? (
            <div className="study-alert study-alert--error" role="alert">
              {error}
            </div>
          ) : null}

          {step === "source" ? (
            <div className={`study-source-grid${fileBusy ? " study-source-grid--busy" : ""}`}>
              <p className="study-intro">
                <strong>Paso 1 de 2.</strong> Indique el lote o área de interés. Verá el contorno en el mapa y en la
                pestaña Capas antes de continuar.
              </p>

              <div className="study-option-card study-option-card--file">
                {fileBusy ? (
                  <div className="study-card-overlay" aria-hidden="true">
                    <span className="study-spinner" />
                    <p>Leyendo archivo…</p>
                    <p className="study-card-overlay-hint">Puede tardar unos segundos en shapefiles grandes.</p>
                  </div>
                ) : null}
                <h4>Opción A: Subir polígono</h4>
                <p className="study-option-meta">KML, KMZ, shapefile (.zip con .shp/.dbf/.shx) o GeoJSON</p>
                <label className={`study-file-btn${fileBusy ? " study-file-btn--disabled" : ""}`}>
                  {fileBusy ? "Procesando…" : "Elegir archivo"}
                  <input type="file" accept=".kml,.kmz,.zip,.shp,.geojson,.json" hidden disabled={fileBusy} onChange={onPickFile} />
                </label>
              </div>

              <div className={`study-option-card${fileBusy ? " study-option-card--dim" : ""}`}>
                <h4>Opción B: Dibujar en el mapa</h4>
                <p className="study-option-meta">Use el mapa a la derecha. El borde del panel se resalta mientras dibuja.</p>
                <div className="study-draw-btns">
                  <button type="button" onClick={startPolygonDraw} disabled={fileBusy}>
                    Polígono libre
                  </button>
                  <button type="button" onClick={startRectangleDraw} disabled={fileBusy}>
                    Rectángulo (2 clics)
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {step === "draw" ? (
            <div className="study-draw-panel">
              <div className="study-draw-banner">
                <span className="study-spinner study-spinner--inline" aria-hidden="true" />
                <div>
                  <strong>Dibujo activo</strong>
                  <p className="study-draw-banner-text">
                    {drawMode === "polygon"
                      ? "Cada clic en el mapa añade un vértice. Termine con «Finalizar polígono» (mínimo 3 vértices)."
                      : "Haga dos clics en esquinas opuestas del rectángulo sobre el mapa."}
                  </p>
                </div>
              </div>
              <div className="study-draw-actions">
                {drawMode === "polygon" ? (
                  <button type="button" className="study-btn-primary" onClick={() => finalizeStudyPolygon?.()}>
                    Finalizar polígono
                  </button>
                ) : null}
                <button type="button" className="btn-secondary" onClick={cancelDraw}>
                  Volver y cancelar dibujo
                </button>
              </div>
            </div>
          ) : null}

          {step === "form" ? (
            <form className="study-form" onSubmit={submitOrder}>
              <div className="study-alert study-alert--success">
                <strong>Área lista.</strong>{" "}
                {mapHint ? (
                  <>
                    {mapHint}. Ya puede completar el formulario.
                  </>
                ) : (
                  "El polígono está en el mapa y en Capas."
                )}
              </div>
              <p className="study-form-lead">
                <strong>Paso 2 de 2.</strong> Nombre del nuevo proyecto, fechas del estudio y datos del cultivo. Los campos con{" "}
                <span className="req">*</span> son obligatorios. Su nombre y correo de la cuenta se usarán como contacto.
              </p>

              <label>
                Nombre del proyecto <span className="req">*</span>
                <input
                  value={projectName}
                  onChange={(ev) => setProjectName(ev.target.value)}
                  required
                  aria-required="true"
                  maxLength={255}
                  minLength={1}
                  placeholder="Ej. Finca Norte 2026"
                  autoComplete="off"
                />
              </label>
              <p className="study-option-meta" style={{ marginTop: "-6px" }}>
                Obligatorio: será el nombre del proyecto en el sistema (cada nueva solicitud puede tener un nombre distinto).
              </p>
              <label>
                Fecha de inicio del estudio <span className="req">*</span>
                <input type="date" value={studyDateStart} onChange={(ev) => setStudyDateStart(ev.target.value)} required />
              </label>
              <label>
                Fecha final del estudio <span className="req">*</span>
                <input type="date" value={studyDateEnd} onChange={(ev) => setStudyDateEnd(ev.target.value)} required />
              </label>
              <label>
                Empresa <span className="optional-tag">opcional</span>
                <input value={company} onChange={(ev) => setCompany(ev.target.value)} />
              </label>
              <label>
                Cultivo <span className="optional-tag">opcional</span>
                <select value={crop} onChange={(ev) => setCrop(ev.target.value)}>
                  <option value="">— Seleccione o use «Otro» —</option>
                  {CROPS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              {crop === "Otro" ? (
                <label>
                  Especifique el cultivo
                  <input value={cropOther} onChange={(ev) => setCropOther(ev.target.value)} placeholder="Ej. aguacate" />
                </label>
              ) : null}
              <label>
                Edad del cultivo (años) <span className="optional-tag">opcional</span>
                <input type="number" min={0} max={150} value={ageYears} onChange={(ev) => setAgeYears(ev.target.value)} />
              </label>
              <fieldset className="study-bool-row">
                <legend>¿Tiene datos meteorológicos?</legend>
                <label>
                  <input type="radio" checked={hasWeather === true} onChange={() => setHasWeather(true)} /> Sí
                </label>
                <label>
                  <input type="radio" checked={hasWeather === false} onChange={() => setHasWeather(false)} /> No
                </label>
              </fieldset>
              <fieldset className="study-bool-row">
                <legend>¿Tiene datos de análisis de suelo?</legend>
                <label>
                  <input type="radio" checked={hasSoil === true} onChange={() => setHasSoil(true)} /> Sí
                </label>
                <label>
                  <input type="radio" checked={hasSoil === false} onChange={() => setHasSoil(false)} /> No
                </label>
              </fieldset>
              <label>
                Si tiene más información sobre el cultivo, puede indicarla aquí
                <textarea value={extraNotes} onChange={(ev) => setExtraNotes(ev.target.value)} rows={4} />
              </label>

              <div className={`study-form-actions${submitBusy ? " study-form-actions--busy" : ""}`}>
                <button type="button" className="btn-secondary" disabled={submitBusy} onClick={() => setStep("source")}>
                  Volver al paso 1
                </button>
                <button
                  type="submit"
                  className="study-btn-submit"
                  disabled={submitBusy || !projectName.trim() || !studyDateStart || !studyDateEnd}
                >
                  {submitBusy ? (
                    <>
                      <span className="study-spinner study-spinner--inline" aria-hidden="true" />
                      Enviando…
                    </>
                  ) : (
                    "Enviar solicitud de estudio"
                  )}
                </button>
              </div>
            </form>
          ) : null}

          {step === "success" ? (
            <div className="study-success">
              <div className="study-success-icon" aria-hidden="true">
                ✓
              </div>
              <h4 className="study-success-title">Solicitud enviada correctamente</h4>
              <p className="study-success-text">
                Su pedido de estudio AgroGeoFísico quedó registrado. Recibirá notificación al correo asociado a la cuenta
                y nuestro equipo revisará el área enviada.
              </p>
              {successOrderId != null ? (
                <p className="study-success-ref">
                  Referencia de solicitud: <strong>#{successOrderId}</strong>
                </p>
              ) : null}
              <ul className="study-success-list">
                <li>Conserve el número de referencia por si necesita dar seguimiento.</li>
                <li>Revise la bandeja de entrada y spam por si llega confirmación automática.</li>
              </ul>
              <button type="button" className="study-btn-primary study-success-close" onClick={handleClose}>
                Entendido, cerrar
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
