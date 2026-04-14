import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildBaseStyle } from "../utils/geo";

export default function MapView({ mapRef, mapLayersRef, baseStyle, setBaseStyle }) {
  const containerRef = useRef(null);
  const [showBaseOptions, setShowBaseOptions] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      style: buildBaseStyle("vectorial"),
      center: [-74.2973, 4.5709],
      zoom: 5.5,
    });
    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(buildBaseStyle(baseStyle));
    const repaint = () => {
      mapLayersRef.current.forEach((l) => {
        if (!l.geojsonData) return;
        if (map.getSource(l.id)) {
          try { map.removeLayer(l.id + "_outline"); } catch (_) {}
          try { map.removeLayer(l.id); } catch (_) {}
          map.removeSource(l.id);
        }
        map.addSource(l.id, { type: "geojson", data: l.geojsonData });
        map.addLayer({
          id: l.id,
          type: "fill",
          source: l.id,
          paint: { "fill-color": "#2d6cdf", "fill-opacity": 0.35 },
          layout: { visibility: l.visible ? "visible" : "none" },
        });
        map.addLayer({
          id: l.id + "_outline",
          type: "line",
          source: l.id,
          paint: { "line-color": "#1a3f8c", "line-width": 2 },
          layout: { visibility: l.visible ? "visible" : "none" },
        });
      });
    };
    map.once("load", repaint);
  }, [baseStyle]);

  return (
    <main className="map-container">
      <div className="map-base-control">
        <button
          className="layers-toggle"
          type="button"
          onClick={() => setShowBaseOptions((prev) => !prev)}
          aria-label="Cambiar mapa base"
          title="Capas de mapa"
        >
          <span className="layers-icon" />
        </button>
        {showBaseOptions ? (
          <div className="layers-menu">
            <button
              type="button"
              className={baseStyle === "vectorial" ? "active" : ""}
              onClick={() => {
                setBaseStyle("vectorial");
                setShowBaseOptions(false);
              }}
            >
              Vectorial
            </button>
            <button
              type="button"
              className={baseStyle === "satelital" ? "active" : ""}
              onClick={() => {
                setBaseStyle("satelital");
                setShowBaseOptions(false);
              }}
            >
              Satelital
            </button>
            <button
              type="button"
              className={baseStyle === "hibrido" ? "active" : ""}
              onClick={() => {
                setBaseStyle("hibrido");
                setShowBaseOptions(false);
              }}
            >
              Hibrido
            </button>
          </div>
        ) : null}
      </div>
      <div className="map" ref={containerRef} />
    </main>
  );
}
