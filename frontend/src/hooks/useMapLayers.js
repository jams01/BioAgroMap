import { useRef, useState } from "react";
import { bboxFromGeojson } from "../utils/geo";

export default function useMapLayers(mapRef) {
  const [mapLayers, setMapLayers] = useState([]);
  const mapLayersRef = useRef([]);
  const layerIdCounter = useRef(1);
  const [pendingDeletes, setPendingDeletes] = useState([]);
  const [dirty, setDirty] = useState(false);

  function addMapLayer(name, kind, geojsonData, serverId) {
    const lid = `layer_${layerIdCounter.current++}`;
    const bbox = geojsonData ? bboxFromGeojson(geojsonData) : null;
    const entry = {
      id: lid,
      name,
      kind,
      visible: true,
      geojsonData,
      bbox,
      serverId: serverId || null,
    };
    setMapLayers((prev) => {
      const next = [entry, ...prev];
      mapLayersRef.current = next;
      return next;
    });
    return lid;
  }

  function removeMapLayer(lid) {
    const map = mapRef.current;
    if (map) {
      if (map.getLayer(lid)) map.removeLayer(lid);
      if (map.getLayer(lid + "_outline")) map.removeLayer(lid + "_outline");
      if (map.getSource(lid)) map.removeSource(lid);
    }
    const removed = mapLayersRef.current.find((l) => l.id === lid);
    if (removed && removed.serverId) {
      setPendingDeletes((prev) => [
        ...prev,
        { kind: removed.kind, serverId: removed.serverId },
      ]);
      setDirty(true);
    }
    setMapLayers((prev) => {
      const next = prev.filter((l) => l.id !== lid);
      mapLayersRef.current = next;
      return next;
    });
  }

  function toggleLayerVisibility(lid) {
    setMapLayers((prev) => {
      const next = prev.map((l) => {
        if (l.id !== lid) return l;
        const vis = !l.visible;
        const map = mapRef.current;
        if (map && map.getLayer(lid)) {
          map.setLayoutProperty(lid, "visibility", vis ? "visible" : "none");
        }
        return { ...l, visible: vis };
      });
      mapLayersRef.current = next;
      return next;
    });
  }

  function clearAllMapLayers() {
    const map = mapRef.current;
    mapLayersRef.current.forEach((l) => {
      if (map) {
        if (map.getLayer(l.id)) map.removeLayer(l.id);
        if (map.getLayer(l.id + "_outline")) map.removeLayer(l.id + "_outline");
        if (map.getSource(l.id)) map.removeSource(l.id);
      }
    });
    setMapLayers([]);
    mapLayersRef.current = [];
    layerIdCounter.current = 1;
  }

  return {
    mapLayers,
    mapLayersRef,
    pendingDeletes,
    setPendingDeletes,
    dirty,
    setDirty,
    addMapLayer,
    removeMapLayer,
    toggleLayerVisibility,
    clearAllMapLayers,
  };
}
