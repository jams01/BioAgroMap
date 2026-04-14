import { useState } from "react";
import AuthPanel from "./AuthPanel";
import ProjectList from "./ProjectList";
import LayersPanel from "./LayersPanel";
import UploadPanel from "./UploadPanel";
import PreprocessPanel from "./PreprocessPanel";

export default function Sidebar({
  token,
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
  dirty,
  targetRasterId,
  setTargetRasterId,
  loteFile,
  setLoteFile,
  rasterFile,
  setRasterFile,
  downloadSource,
  setDownloadSource,
  indiceType,
  setIndiceType,
  stackMode,
  setStackMode,
  onLogin,
  onRegister,
  onLogout,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onToggleVisibility,
  onZoomToLayer,
  onRemoveLayer,
  onSave,
  onUploadLote,
  onUploadRaster,
  onRunAI,
  onDownload,
  onCrop,
  onIndices,
  onStack,
  onCluster,
}) {
  const [activeTab, setActiveTab] = useState("admin");
  const [panelOpen, setPanelOpen] = useState(true);
  const [layersPanelOpen, setLayersPanelOpen] = useState(false);

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
          Admin
        </button>
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
          aria-selected={panelOpen && activeTab === "prepro"}
          className={panelOpen && activeTab === "prepro" ? "active" : ""}
          onClick={() => {
            setActiveTab("prepro");
            setPanelOpen(true);
            setLayersPanelOpen(false);
          }}
        >
          Preprocesamiento
        </button>
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
          projectId={projectId}
          dirty={dirty}
          loading={loading}
          onToggleVisibility={onToggleVisibility}
          onZoomToLayer={onZoomToLayer}
          onRemoveLayer={onRemoveLayer}
          onSave={onSave}
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
              onLogin={onLogin}
              onRegister={onRegister}
            />
          ) : (
            <ProjectList
              projects={projects}
              projectId={projectId}
              projectName={projectName}
              setProjectName={setProjectName}
              loading={loading}
              onSelectProject={onSelectProject}
              onCreateProject={onCreateProject}
              onDeleteProject={onDeleteProject}
              onLogout={onLogout}
              email={email}
            />
          )}
        </>
      ) : null}

      {panelOpen && !layersPanelOpen && activeTab === "cargar" ? (
        <UploadPanel
          token={token}
          projectId={projectId}
          loading={loading}
          targetRasterId={targetRasterId}
          setTargetRasterId={setTargetRasterId}
          onUploadLote={onUploadLote}
          onUploadRaster={onUploadRaster}
          onRunAI={onRunAI}
          loteFile={loteFile}
          setLoteFile={setLoteFile}
          rasterFile={rasterFile}
          setRasterFile={setRasterFile}
        />
      ) : null}

      {panelOpen && !layersPanelOpen && activeTab === "prepro" ? (
        <PreprocessPanel
          token={token}
          projectId={projectId}
          loading={loading}
          targetRasterId={targetRasterId}
          downloadSource={downloadSource}
          setDownloadSource={setDownloadSource}
          indiceType={indiceType}
          setIndiceType={setIndiceType}
          stackMode={stackMode}
          setStackMode={setStackMode}
          onDownload={onDownload}
          onCrop={onCrop}
          onIndices={onIndices}
          onStack={onStack}
          onCluster={onCluster}
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
