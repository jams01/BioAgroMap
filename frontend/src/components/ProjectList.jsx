import { useState } from "react";

function projectStatusLabel(status) {
  const s = String(status || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "en proceso" || s.replace(" ", "") === "enproceso") return "En proceso";
  const map = {
    pendiente: "Pendiente",
    procesado: "Procesado",
    publicado: "Publicado",
  };
  return map[s] || status || "—";
}

function projectStatusClass(status) {
  const s = String(status || "").trim().toLowerCase().replace(/\s+/g, "-");
  return s.replace(/[^a-z0-9-]/g, "") || "unknown";
}

export default function ProjectList({
  projects,
  projectId,
  projectName,
  setProjectName,
  loading,
  onSelectProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onLogout,
  email,
  readOnly = false,
  title = "Mis Proyectos",
  /** Si ya se muestra sesión arriba (p. ej. en pestaña Ingresar admin), evitar duplicar Cerrar sesión. */
  hideSessionHeader = false,
}) {
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");

  async function saveRename() {
    if (editingId == null) return;
    const ok = await onUpdateProject(editingId, editingName);
    if (ok) {
      setEditingId(null);
      setEditingName("");
    }
  }

  function cancelRename() {
    setEditingId(null);
    setEditingName("");
  }

  return (
    <>
      {!hideSessionHeader ? (
        <div className="session-info">
          <span>{email}</span>
          <button onClick={onLogout} disabled={loading} className="btn-link">
            Cerrar sesion
          </button>
        </div>
      ) : null}

      <div className="projects-section">
        <div className="projects-header">{title}</div>
        {projects.length === 0 ? (
          <div className="projects-empty">Sin proyectos. Crea uno nuevo.</div>
        ) : (
          <ul className="projects-list">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`projects-item${p.id === Number(projectId) ? " active" : ""}${editingId === p.id ? " editing" : ""}`}
                onClick={() => {
                  if (editingId === p.id) return;
                  onSelectProject(p.id);
                }}
              >
                {editingId === p.id ? (
                  <div className="projects-item-edit" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      className="projects-item-edit-input"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      disabled={loading}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") cancelRename();
                      }}
                    />
                    <div className="projects-item-edit-actions">
                      <button type="button" className="projects-item-edit-save" onClick={saveRename} disabled={loading}>
                        Guardar
                      </button>
                      <button type="button" className="projects-item-edit-cancel" onClick={cancelRename} disabled={loading}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="projects-item-title-row">
                      <span className="projects-item-name">{p.name}</span>
                      {p.status ? (
                        <span
                          className={`projects-item-status projects-item-status--${projectStatusClass(p.status)}`}
                          title="Estado del proyecto"
                        >
                          {projectStatusLabel(p.status)}
                        </span>
                      ) : null}
                    </div>
                    {p.id === Number(projectId) && (
                      <span className="projects-item-check">&#10003;</span>
                    )}
                    {!readOnly ? (
                      <>
                        <button
                          type="button"
                          className="projects-item-rename"
                          title="Renombrar proyecto"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(p.id);
                            setEditingName(p.name);
                          }}
                        >
                          &#9998;
                        </button>
                        <button
                          className="projects-item-delete"
                          title="Eliminar proyecto"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteProject(p.id);
                          }}
                        >
                          &times;
                        </button>
                      </>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {!readOnly ? (
        <div className="create-project-row">
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Nombre nuevo proyecto"
            disabled={loading}
          />
          <button onClick={onCreateProject} disabled={loading || !projectName.trim()}>
            + Crear
          </button>
        </div>
      ) : null}
    </>
  );
}
