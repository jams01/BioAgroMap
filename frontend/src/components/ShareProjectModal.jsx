import { useEffect, useState } from "react";
import api, { setAuthToken } from "../api";

export default function ShareProjectModal({
  open,
  token,
  projectId,
  projectName,
  onClose,
  onStatusMessage,
}) {
  const [shares, setShares] = useState([]);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [error, setError] = useState("");

  async function loadShares() {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      setAuthToken(token);
      const res = await api.get(`/projects/${projectId}/shares`);
      setShares(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Error al cargar accesos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !token || !projectId) return;
    setEmail("");
    loadShares();
  }, [open, token, projectId]);

  async function handleShare(e) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !projectId) return;
    setSaving(true);
    setError("");
    try {
      setAuthToken(token);
      const res = await api.post(`/projects/${projectId}/shares`, { email: trimmed });
      const entry = res.data;
      setShares((prev) => {
        const exists = prev.some((s) => s.user_id === entry.user_id);
        if (exists) {
          return prev.map((s) => (s.user_id === entry.user_id ? entry : s));
        }
        return [...prev, entry];
      });
      setEmail("");
      onStatusMessage?.(`Proyecto compartido con ${entry.email}`);
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "No se pudo compartir el proyecto");
    } finally {
      setSaving(false);
    }
  }

  async function revokeShare(userId, shareEmail) {
    if (!window.confirm(`Quitar acceso de ${shareEmail} al proyecto?`)) return;
    setRevokingId(userId);
    setError("");
    try {
      setAuthToken(token);
      await api.delete(`/projects/${projectId}/shares/${userId}`);
      setShares((prev) => prev.filter((s) => s.user_id !== userId));
      onStatusMessage?.(`Acceso revocado: ${shareEmail}`);
    } catch (err) {
      setError(err?.response?.data?.detail || err?.message || "No se pudo revocar el acceso");
    } finally {
      setRevokingId(null);
    }
  }

  if (!open) return null;

  const title = projectName ? `Compartir «${projectName}»` : "Compartir proyecto";

  return (
    <div className="index-modal-overlay" role="dialog" aria-modal="true">
      <div className="rgb-gallery-backdrop" onClick={onClose} />
      <div className="index-modal share-project-modal">
        <div className="index-modal-header">
          <h3>{title}</h3>
          <button type="button" className="index-modal-close" onClick={onClose} aria-label="Cerrar">
            &times;
          </button>
        </div>
        <div className="index-modal-body share-project-body">
          <p className="share-project-hint">
            El usuario cliente verá este proyecto en su lista. Si el proyecto está{" "}
            <strong>publicado</strong>, podrá abrir el dashboard de resultados.
          </p>
          {error ? <p className="status-msg">{error}</p> : null}
          <form className="share-project-form" onSubmit={handleShare}>
            <label>
              Correo del usuario cliente
              <input
                type="email"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                placeholder="usuario@ejemplo.com"
                autoComplete="off"
                disabled={saving || !projectId}
                required
              />
            </label>
            <button type="submit" disabled={saving || !email.trim() || !projectId}>
              {saving ? "Compartiendo…" : "Compartir proyecto"}
            </button>
          </form>
          <div className="share-project-list-title">Usuarios con acceso compartido</div>
          {loading ? <p className="projects-empty">Cargando…</p> : null}
          {!loading && shares.length === 0 ? (
            <p className="projects-empty">Nadie más tiene acceso compartido por admin.</p>
          ) : null}
          {!loading && shares.length > 0 ? (
            <ul className="share-project-list">
              {shares.map((s) => (
                <li key={s.user_id} className="share-project-item">
                  <div className="share-project-item-main">
                    <div className="share-project-item-email">{s.email}</div>
                    {s.full_name ? <div className="share-project-item-name">{s.full_name}</div> : null}
                    {s.granted_by_email ? (
                      <div className="share-project-item-meta">
                        Compartido por {s.granted_by_email}
                        {s.created_at ? ` · ${s.created_at}` : ""}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="share-project-revoke"
                    disabled={revokingId === s.user_id}
                    onClick={() => revokeShare(s.user_id, s.email)}
                  >
                    {revokingId === s.user_id ? "…" : "Quitar"}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
