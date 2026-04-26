import { useEffect, useState } from "react";
import AuthPanel from "./AuthPanel";
import ProjectList from "./ProjectList";
import LayersPanel from "./LayersPanel";
import UploadPanel from "./UploadPanel";
import PreprocessPanel from "./PreprocessPanel";
import Sentinel1Panel from "./Sentinel1Panel";

function isS1StackMode(mode) {
  return (
    mode === "visual-s1-vv" ||
    mode === "visual-s1-vh" ||
    mode === "visual-s1-index" ||
    mode === "visual-s1-sar-indices"
  );
}

function normalizeUserRole(role) {
  const value = String(role || "").trim().toLowerCase();
  if (value === "client") return "cliente";
  return value;
}

export default function Sidebar({
  activeTab,
  setActiveTab,
  recorteLayerId,
  setRecorteLayerId,
  preproGalleryKick,
  preproClusterVizKick,
  preproClusterVizKickPs = 0,
  onOpenPreproGallery,
  onOpenPreproClusterViz,
  token,
  userRole,
  email,
  setEmail,
  password,
  setPassword,
  loading,
  message,
  projects,
  projectId,
  projectName,
  setProjectName,
  mapLayers,
  targetRasterId,
  setTargetRasterId,
  loteFile,
  setLoteFile,
  rasterFile,
  setRasterFile,
  downloadSource,
  setDownloadSource,
  selectedIndices,
  setSelectedIndices,
  indexStacksBusy,
  visualIndexGalleryKick = 0,
  stackMode,
  setStackMode,
  onLogin,
  onLogout,
  authStep = "email",
  otpDebug = null,
  onContinueEmail,
  onVerifyOtp,
  onResetEmailStep,
  onOpenStudyRequest,
  onOpenStudyOrders,
  onSelectProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onToggleVisibility,
  onZoomToLayer,
  onHideLayer,
  onOpenDashboard,
  onOpenClientDashboard,
  onOpenUserManagement,
  onUploadLote,
  onUploadRaster,
  onRunAI,
  onDownload,
  recortePipelineBusy,
  onS2L2aRecortes,
  onPsL2aRecortes,
  onS1GrdRecortes,
  onS1SarIndexStacks,
  s1SarStacksBusy = false,
  onS2IndexStacks,
  onPsIndexStacks,
  clusterElbowLoading,
  clusterGmmLoading,
  clusterElbowResults,
  clusterGmmResults,
  onClusterElbow,
  onClusterGmm,
  onClusterElbowPs,
  onClusterGmmPs,
  onClusterElbowS1,
  onClusterGmmS1,
  onLoadPersistedClusterGmm,
  onLoadPersistedClusterGmmPs,
  onLoadPersistedClusterGmmS1,
  onPsPlanetExtract,
  s2Download,
  s1Download,
  visualIndexGalleryKickPs = 0,
  clusterElbowResultsPs,
  clusterGmmResultsPs,
  clusterElbowResultsS1,
  clusterGmmResultsS1,
}) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [layersPanelOpen, setLayersPanelOpen] = useState(false);

  useEffect(() => {
    if (!visualIndexGalleryKick) return;
    setActiveTab("prepro");
    setPanelOpen(true);
    setLayersPanelOpen(false);
  }, [visualIndexGalleryKick]);

  useEffect(() => {
    if (!visualIndexGalleryKickPs) return;
    setActiveTab("ps");
    setPanelOpen(true);
    setLayersPanelOpen(false);
  }, [visualIndexGalleryKickPs]);

  const normalizedRole = normalizeUserRole(userRole);
  const isAdmin = !!token && normalizedRole === "admin";
  const isCliente = !!token && normalizedRole === "cliente";
  const showStudyCta = !!token && isCliente;
  const canShowAdminTabs = isAdmin;
  const canShowClientDashboardTab = isCliente;
  return (
    <aside className="panel">
      <img className="brand-logo" src="/logo-bioagro.png" alt="BioAgroMap" />
      <div className="top-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={panelOpen && activeTab === "admin"}
          className={panelOpen && activeTab === "admin" ? "active" : ""}
          onClick={() => {
            setActiveTab("admin");
            setPanelOpen(true);
            setLayersPanelOpen(false);
          }}
        >
          Ingresar
        </button>
        {canShowAdminTabs ? (
          <>
            <button
              role="tab"
              aria-selected={panelOpen && activeTab === "cargar"}
              className={panelOpen && activeTab === "cargar" ? "active" : ""}
              onClick={() => {
                setActiveTab("cargar");
                setPanelOpen(true);
                setLayersPanelOpen(false);
              }}
            >
              Cargar
            </button>
            <button
              role="tab"
              aria-selected={panelOpen && activeTab === "s1"}
              type="button"
              className={
                (panelOpen && activeTab === "s1" ? "active " : "") + "top-tab-s1"
              }
              onClick={() => {
                setActiveTab("s1");
                setPanelOpen(true);
                setLayersPanelOpen(false);
              }}
            >
              SI
            </button>
            <button
              role="tab"
              aria-selected={panelOpen && activeTab === "prepro"}
              className={panelOpen && activeTab === "prepro" ? "active" : ""}
              onClick={() => {
                setActiveTab("prepro");
                setPanelOpen(true);
                setLayersPanelOpen(false);
                if (isS1StackMode(stackMode)) setStackMode("visual-rgb");
              }}
            >
              S2
            </button>
            <button
              role="tab"
              aria-selected={panelOpen && activeTab === "ps"}
              type="button"
              className={(panelOpen && activeTab === "ps" ? "active " : "") + "top-tab-ps"}
              onClick={() => {
                setActiveTab("ps");
                setPanelOpen(true);
                setLayersPanelOpen(false);
                if (isS1StackMode(stackMode)) setStackMode("visual-rgb");
              }}
            >
              PS
            </button>
          </>
        ) : null}
        {canShowClientDashboardTab ? (
          <button
            role="tab"
            aria-selected={panelOpen && activeTab === "dashboard"}
            className={panelOpen && activeTab === "dashboard" ? "active" : ""}
            onClick={() => {
              setActiveTab("dashboard");
              setPanelOpen(true);
              setLayersPanelOpen(false);
              onOpenClientDashboard?.();
            }}
          >
            Dashboard
          </button>
        ) : null}
        <button
          role="tab"
          aria-selected={layersPanelOpen}
          className={layersPanelOpen ? "tab-toggle active" : "tab-toggle"}
          onClick={() => {
            setLayersPanelOpen((p) => {
              if (!p) setPanelOpen(false);
              return !p;
            });
          }}
          title={layersPanelOpen ? "Cerrar capas" : "Abrir capas"}
        >
          Capas
        </button>
      </div>

      {layersPanelOpen ? (
        <LayersPanel
          mapLayers={mapLayers}
          onToggleVisibility={onToggleVisibility}
          onZoomToLayer={onZoomToLayer}
          onHideLayer={onHideLayer}
          onOpenDashboard={onOpenDashboard}
          dashboardDisabled={!token || !projectId || userRole !== "admin"}
        />
      ) : null}

      {panelOpen && !layersPanelOpen && activeTab === "admin" ? (
        <>
          {!token ? (
            <AuthPanel
              email={email}
              setEmail={setEmail}
              password={password}
              setPassword={setPassword}
              loading={loading}
              authStep={authStep}
              otpDebug={otpDebug}
              onContinueEmail={onContinueEmail}
              onVerifyOtp={onVerifyOtp}
              onResetEmailStep={onResetEmailStep}
              onLogin={onLogin}
            />
          ) : (
            <>
              <div className="session-info">
                <span>{email} ({userRole || "sin rol"})</span>
                <button onClick={onLogout} disabled={loading} className="btn-link">
                  Cerrar sesion
                </button>
              </div>
              {showStudyCta ? (
                <button
                  type="button"
                  className="study-primary-cta"
                  onClick={() => onOpenStudyRequest?.()}
                  disabled={loading}
                >
                  Solicitar estudio AgroGeoFísico
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  type="button"
                  className="layers-dashboard-btn"
                  onClick={() => onOpenUserManagement?.()}
                  disabled={loading}
                  title="Abrir gestion de usuarios y roles"
                >
                  Gestion Usuario
                </button>
              ) : null}
              {isAdmin ? (
                <button
                  type="button"
                  className="layers-dashboard-btn study-orders-btn"
                  onClick={() => onOpenStudyOrders?.()}
                  disabled={loading}
                  title="Ver solicitudes AgroGeoFísico"
                >
                  Gestion de ordenes
                </button>
              ) : null}
              {isAdmin ? (
                <div className="admin-project-field">
                  <label className="admin-project-label" htmlFor="admin-project-select">
                    Proyecto de trabajo
                  </label>
                  <select
                    id="admin-project-select"
                    className="admin-project-select"
                    value={
                      projectId != null && projectId !== ""
                        ? String(projectId)
                        : ""
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) onSelectProject(Number(v));
                    }}
                    disabled={loading || !projects?.length}
                  >
                    <option value="">— Elija proyecto —</option>
                    {(projects || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.status ?? "—"})
                      </option>
                    ))}
                  </select>
                  {!projects?.length ? (
                    <p className="admin-project-hint">
                      No hay proyectos. Los clientes crean proyectos al solicitar un estudio.
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="projects-empty">
                  Sesion iniciada como cliente. Usa el boton "Dashboard" para ver tus proyectos.
                </div>
              )}
            </>
          )}
        </>
      ) : null}

      {panelOpen && !layersPanelOpen && activeTab === "dashboard" && isCliente ? (
        <>
          {showStudyCta ? (
            <button
              type="button"
              className="study-primary-cta"
              onClick={() => onOpenStudyRequest?.()}
              disabled={loading}
            >
              Solicitar estudio AgroGeoFísico
            </button>
          ) : null}
          <button
            type="button"
            className="layers-dashboard-btn"
            onClick={() => onOpenClientDashboard?.()}
            disabled={loading}
            title="Abrir dashboard con resultados publicados"
          >
            Abrir dashboard de resultados
          </button>
          <ProjectList
            projects={projects}
            projectId={projectId}
            projectName={projectName}
            setProjectName={setProjectName}
            loading={loading}
            onSelectProject={onSelectProject}
            onCreateProject={onCreateProject}
            onUpdateProject={onUpdateProject}
            onDeleteProject={onDeleteProject}
            onLogout={onLogout}
            email={email}
            readOnly
            title="Dashboard - Mis Proyectos"
          />
        </>
      ) : null}

      {canShowAdminTabs && panelOpen && !layersPanelOpen && activeTab === "s1" ? (
        <Sentinel1Panel
          token={token}
          projectId={projectId}
          loading={loading}
          mapLayers={mapLayers}
          recorteLayerId={recorteLayerId}
          setRecorteLayerId={setRecorteLayerId}
          stackMode={stackMode}
          setStackMode={setStackMode}
          onOpenPreproGallery={onOpenPreproGallery}
          onOpenPreproClusterViz={onOpenPreproClusterViz}
          recortePipelineBusy={recortePipelineBusy}
          s1SarStacksBusy={s1SarStacksBusy}
          onS1GrdRecortes={onS1GrdRecortes}
          onS1SarIndexStacks={onS1SarIndexStacks}
          clusterElbowLoading={clusterElbowLoading}
          clusterGmmLoading={clusterGmmLoading}
          clusterElbowResults={clusterElbowResultsS1}
          clusterGmmResults={clusterGmmResultsS1}
          onClusterElbow={onClusterElbowS1}
          onClusterGmm={onClusterGmmS1}
          onLoadPersistedClusterGmm={onLoadPersistedClusterGmmS1}
        />
      ) : null}

      {canShowAdminTabs && panelOpen && !layersPanelOpen && activeTab === "cargar" ? (
        <UploadPanel
          token={token}
          projectId={projectId}
          loading={loading}
          targetRasterId={targetRasterId}
          setTargetRasterId={setTargetRasterId}
          onUploadLote={onUploadLote}
          onUploadRaster={onUploadRaster}
          onRunAI={onRunAI}
          onDownload={onDownload}
          loteFile={loteFile}
          setLoteFile={setLoteFile}
          rasterFile={rasterFile}
          setRasterFile={setRasterFile}
          downloadSource={downloadSource}
          setDownloadSource={setDownloadSource}
          mapLayers={mapLayers}
          s2Download={s2Download}
          s1Download={s1Download}
        />
      ) : null}

      {canShowAdminTabs && panelOpen && !layersPanelOpen && activeTab === "prepro" ? (
        <PreprocessPanel
          token={token}
          projectId={projectId}
          loading={loading}
          selectedIndices={selectedIndices}
          setSelectedIndices={setSelectedIndices}
          stackMode={stackMode}
          setStackMode={setStackMode}
          mapLayers={mapLayers}
          recortePipelineBusy={recortePipelineBusy}
          indexStacksBusy={indexStacksBusy}
          visualIndexGalleryKick={visualIndexGalleryKick}
          recorteLayerId={recorteLayerId}
          setRecorteLayerId={setRecorteLayerId}
          preproGalleryKick={preproGalleryKick}
          preproClusterVizKick={preproClusterVizKick}
          onS2L2aRecortes={onS2L2aRecortes}
          onS2IndexStacks={onS2IndexStacks}
          clusterElbowLoading={clusterElbowLoading}
          clusterGmmLoading={clusterGmmLoading}
          clusterElbowResults={clusterElbowResults}
          clusterGmmResults={clusterGmmResults}
          onClusterElbow={onClusterElbow}
          onClusterGmm={onClusterGmm}
          onLoadPersistedClusterGmm={onLoadPersistedClusterGmm}
          pipelineVariant="s2"
        />
      ) : null}

      {canShowAdminTabs && panelOpen && !layersPanelOpen && activeTab === "ps" ? (
        <PreprocessPanel
          token={token}
          projectId={projectId}
          loading={loading}
          selectedIndices={selectedIndices}
          setSelectedIndices={setSelectedIndices}
          stackMode={stackMode}
          setStackMode={setStackMode}
          mapLayers={mapLayers}
          recortePipelineBusy={recortePipelineBusy}
          indexStacksBusy={indexStacksBusy}
          visualIndexGalleryKick={visualIndexGalleryKickPs}
          recorteLayerId={recorteLayerId}
          setRecorteLayerId={setRecorteLayerId}
          preproGalleryKick={preproGalleryKick}
          preproClusterVizKick={preproClusterVizKickPs}
          onS2L2aRecortes={onPsL2aRecortes}
          onS2IndexStacks={onPsIndexStacks}
          clusterElbowLoading={clusterElbowLoading}
          clusterGmmLoading={clusterGmmLoading}
          clusterElbowResults={clusterElbowResultsPs}
          clusterGmmResults={clusterGmmResultsPs}
          onClusterElbow={onClusterElbowPs}
          onClusterGmm={onClusterGmmPs}
          onLoadPersistedClusterGmm={onLoadPersistedClusterGmmPs}
          pipelineVariant="ps"
          onPsPlanetExtract={onPsPlanetExtract}
        />
      ) : null}

      {message && (
        <div className="status-msg">{loading ? "Procesando..." : message}</div>
      )}
      <div className="powered-by">
        <span>Powered by</span>
        <img src="/wd-white.png" alt="WaveData" />
      </div>
    </aside>
  );
}
