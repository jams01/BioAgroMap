import { useEffect, useMemo, useState } from "react";
import api, { setAuthToken } from "../api";
import OrderPreviewMap from "./OrderPreviewMap";

const STATUS_OPTS = [
  { value: "pendiente", label: "Pendiente" },
  { value: "procesado", label: "Procesado" },
  { value: "publicado", label: "Publicado" },
];

export default function AdminStudyOrdersModal({ open, token, onClose, onStatusMessage }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState("");
  const [confirmationMsg, setConfirmationMsg] = useState("");

  const groupedOrders = useMemo(() => {
    const byEmail = new Map();
    for (const r of rows) {
      const email = (r.user_email || "").trim() || "(sin correo)";
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(r);
    }
    for (const [, list] of byEmail) {
      list.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    }
    return Array.from(byEmail.entries()).sort(([a], [b]) => a.localeCompare(b, "es", { sensitivity: "base" }));
  }, [rows]);

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      setAuthToken(token);
      const res = await api.get("/study-orders");
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Error al cargar órdenes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !token) return;
    loadList();
  }, [open, token]);

  async function openDetail(id) {
    setError("");
    setConfirmationMsg("");
    try {
      setAuthToken(token);
      const res = await api.get(`/study-orders/${id}`);
      setDetail(res.data);
      setSelectedStatus(String(res.data?.status || ""));
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Error al cargar detalle");
    }
  }

  async function saveStatus() {
    if (!detail) return;
    const newStatus = String(selectedStatus || "").trim().toLowerCase();
    if (!newStatus || newStatus === detail.status) return;
    setSaving(true);
    setError("");
    setConfirmationMsg("");
    try {
      setAuthToken(token);
      const res = await api.patch(`/study-orders/${detail.id}`, { status: newStatus });
      setDetail(res.data);
      setSelectedStatus(newStatus);
      setRows((prev) => prev.map((r) => (r.id === detail.id ? { ...r, status: newStatus } : r)));
      if (newStatus === "publicado") {
        const msg = `Orden #${detail.id} publicada. El cliente ya puede ver sus resultados en el dashboard.`;
        setConfirmationMsg(msg);
        onStatusMessage?.(msg);
      } else {
        onStatusMessage?.(`Estado actualizado: orden #${detail.id} -> ${newStatus}`);
      }
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "No se pudo guardar");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="index-modal-overlay" role="dialog" aria-modal="true">
      <div className="rgb-gallery-backdrop" onClick={onClose} />
      <div className="index-modal user-mgmt-modal orders-modal">
        <div className="index-modal-header">
          <h3 className="orders-modal-title">
            {detail ? (
              <>
                <strong className="orders-head-id">Orden #{detail.id}</strong>
                <span className="orders-head-sep" aria-hidden="true">
                  {" "}
                  ·{" "}
                </span>
                <strong className="orders-head-project">{detail.project_name || "—"}</strong>
              </>
            ) : (
              "Órdenes AgroGeoFísico"
            )}
          </h3>
          <button type="button" className="index-modal-close" onClick={onClose} aria-label="Cerrar">
            &times;
          </button>
        </div>
        <div className="index-modal-body user-mgmt-body">
          {error ? <p className="status-msg">{error}</p> : null}
          {confirmationMsg ? <p className="status-msg">{confirmationMsg}</p> : null}

          {!detail ? (
            <>
              <div className="orders-toolbar">
                <button type="button" className="user-mgmt-btn secondary" onClick={loadList} disabled={loading}>
                  {loading ? "Cargando…" : "Actualizar"}
                </button>
              </div>
              {loading && rows.length === 0 ? <p className="projects-empty">Cargando…</p> : null}
              {!loading && rows.length === 0 ? <p className="projects-empty">No hay solicitudes.</p> : null}
              {rows.length > 0 ? (
                <div className="orders-groups">
                  {groupedOrders.map(([email, list], gidx) => (
                    <section key={email} className="orders-group" aria-labelledby={`orders-user-${gidx}`}>
                      <h4 id={`orders-user-${gidx}`} className="orders-group-user">
                        {email}
                      </h4>
                      <ul className="orders-list">
                        {list.map((r) => (
                          <li key={r.id} className="orders-row">
                            <div className="orders-row-text">
                              <div className="orders-row-primary">
                                <strong className="orders-order-id">#{r.id}</strong>
                                <span className="orders-primary-sep" aria-hidden="true">
                                  {" "}
                                  ·{" "}
                                </span>
                                <strong className="orders-project-name">
                                  {r.project_name || (r.project_id != null ? `Proyecto #${r.project_id}` : "Sin proyecto")}
                                </strong>
                              </div>
                              <div className="orders-meta">
                                {r.created_at} · cultivo: {r.crop || "—"} ·{" "}
                                <span className="orders-status">{r.status}</span>
                              </div>
                            </div>
                            <button type="button" className="user-mgmt-btn secondary" onClick={() => openDetail(r.id)}>
                              Ver detalle
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="order-detail">
              <button type="button" className="user-mgmt-btn secondary order-back" onClick={() => setDetail(null)}>
                ← Lista
              </button>
              <div className="order-detail-grid">
                <div className="order-detail-mapwrap">
                  <OrderPreviewMap key={detail.id} geojson={detail.geometry} />
                </div>
                <div className="order-detail-fields">
                  <p>
                    <strong>Correo usuario:</strong> {detail.user_email}
                  </p>
                  <p>
                    <strong>Proyecto:</strong> {detail.project_name || detail.project_id || "—"}
                  </p>
                  <p>
                    <strong>Nombre:</strong> {detail.applicant_name}
                  </p>
                  <p>
                    <strong>Celular:</strong> {detail.applicant_phone}
                  </p>
                  <p>
                    <strong>Empresa:</strong> {detail.company || "—"}
                  </p>
                  <p>
                    <strong>Fechas estudio:</strong> {detail.study_date_start} → {detail.study_date_end}
                  </p>
                  <p>
                    <strong>Cultivo:</strong> {detail.crop || "—"}
                  </p>
                  <p>
                    <strong>Edad:</strong> {detail.age_years != null ? detail.age_years : "—"}
                  </p>
                  <p>
                    <strong>Meteorológicos:</strong> {detail.has_weather_data ? "Sí" : "No"}
                  </p>
                  <p>
                    <strong>Suelo:</strong> {detail.has_soil_data ? "Sí" : "No"}
                  </p>
                  <p>
                    <strong>Notas:</strong> {detail.extra_notes || "—"}
                  </p>
                  <p>
                    <strong>Solicitud:</strong> {detail.created_at}
                  </p>
                  <label className="order-status-edit">
                    Estado
                    <select
                      value={selectedStatus}
                      disabled={saving}
                      onChange={(ev) => setSelectedStatus(ev.target.value)}
                    >
                      {STATUS_OPTS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="user-mgmt-btn secondary"
                    disabled={saving || !selectedStatus || selectedStatus === detail.status}
                    onClick={saveStatus}
                    title="Confirmar cambio de estado de la orden"
                  >
                    Aceptar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
