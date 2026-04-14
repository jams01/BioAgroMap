export default function ProjectList({
  projects,
  projectId,
  projectName,
  setProjectName,
  loading,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onLogout,
  email,
}) {
  return (
    <>
      <div className="session-info">
        <span>{email}</span>
        <button onClick={onLogout} disabled={loading} className="btn-link">
          Cerrar sesion
        </button>
      </div>

      <div className="projects-section">
        <div className="projects-header">Mis Proyectos</div>
        {projects.length === 0 ? (
          <div className="projects-empty">Sin proyectos. Crea uno nuevo.</div>
        ) : (
          <ul className="projects-list">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`projects-item${p.id === Number(projectId) ? " active" : ""}`}
                onClick={() => onSelectProject(p.id)}
              >
                <span className="projects-item-name">{p.name}</span>
                {p.id === Number(projectId) && (
                  <span className="projects-item-check">&#10003;</span>
                )}
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
              </li>
            ))}
          </ul>
        )}
      </div>

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
    </>
  );
}
