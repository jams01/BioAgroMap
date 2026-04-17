import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { API_URL } from "../api";
import { buildBaseStyle, rasterSortKeyFromMetadata } from "../utils/geo";

/** Capas visibles arriba; ocultas abajo, para que al apagar la superior se vea la inferior. */
function reorderRasterStack(map, rasterList) {
  if (!map || !rasterList.length) return;
  const sorted = [...rasterList].sort((a, b) => {
    const ka = rasterSortKeyFromMetadata(a.metadata);
    const kb = rasterSortKeyFromMetadata(b.metadata);
    const c = ka.localeCompare(kb);
    if (c !== 0) return c;
    return (a.serverId || 0) - (b.serverId || 0);
  });
  const hidden = sorted.filter((l) => !l.visible);
  const visible = sorted.filter((l) => l.visible);
  [...hidden, ...visible].forEach((l) => {
    if (!map.getLayer(l.id)) return;
    try {
      map.moveLayer(l.id);
    } catch (_) {}
  });
  try {
    map.triggerRepaint();
  } catch (_) {}
}

export default function MapView({
  mapRef,
  mapLayers,
  mapLayersRef,
  projectId,
  token,
  baseStyle,
  setBaseStyle,
}) {
  const containerRef = useRef(null);
  const [showBaseOptions, setShowBaseOptions] = useState(false);
  const rasterBlobUrlsRef = useRef(new Map());
  const rasterFetchInFlightRef = useRef(new Set());

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

    for (const [, url] of rasterBlobUrlsRef.current.entries()) {
      URL.revokeObjectURL(url);
    }
    rasterBlobUrlsRef.current.clear();
    try {
      mapLayersRef.current.forEach((l) => {
        if (l.kind !== "raster") return;
        if (map.getLayer(l.id)) map.removeLayer(l.id);
        if (map.getSource(l.id)) map.removeSource(l.id);
      });
    } catch (_) {
      /* style may be invalid mid-switch */
    }

    map.setStyle(buildBaseStyle(baseStyle));
    const repaint = () => {
      mapLayersRef.current.forEach((l) => {
        if (!l.geojsonData) return;
        if (map.getSource(l.id)) {
          try {
            map.removeLayer(l.id + "_outline");
          } catch (_) {}
          try {
            map.removeLayer(l.id);
          } catch (_) {}
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !projectId || !token) return;

    const syncRasters = () => {
      if (!map.isStyleLoaded()) return;
      const layers = mapLayersRef.current.filter(
        (l) => l.kind === "raster" && l.serverId && l.bbox
      );
      const wanted = new Set(layers.map((l) => l.id));

      for (const [id, url] of [...rasterBlobUrlsRef.current.entries()]) {
        if (!wanted.has(id)) {
          URL.revokeObjectURL(url);
          rasterBlobUrlsRef.current.delete(id);
          try {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
          } catch (_) {}
        }
      }

      const base = API_URL.replace(/\/$/, "");
      layers.forEach((l) => {
        if (map.getSource(l.id)) {
          if (map.getLayer(l.id)) {
            map.setLayoutProperty(l.id, "visibility", l.visible ? "visible" : "none");
          }
          return;
        }
        if (rasterFetchInFlightRef.current.has(l.id)) return;

        const previewUrl = `${base}/raster/${projectId}/${l.serverId}/preview?v=${l.serverId}`;
        rasterFetchInFlightRef.current.add(l.id);
        fetch(previewUrl, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        })
          .then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.blob();
          })
          .then((blob) => {
            if (!map.isStyleLoaded()) return;
            if (!mapLayersRef.current.some((x) => x.id === l.id)) return;
            const objectUrl = URL.createObjectURL(blob);
            rasterBlobUrlsRef.current.set(l.id, objectUrl);
            const bbox = l.bbox;
            const coordinates = [
              [bbox[0][0], bbox[1][1]],
              [bbox[1][0], bbox[1][1]],
              [bbox[1][0], bbox[0][1]],
              [bbox[0][0], bbox[0][1]],
            ];
            if (map.getSource(l.id)) return;
            const cur = mapLayersRef.current.find((x) => x.id === l.id);
            const visNow = cur ? cur.visible : l.visible;
            map.addSource(l.id, { type: "image", url: objectUrl, coordinates });
            map.addLayer({
              id: l.id,
              type: "raster",
              source: l.id,
              paint: { "raster-opacity": 0.92, "raster-fade-duration": 0 },
              layout: { visibility: visNow ? "visible" : "none" },
            });
            reorderRasterStack(
              map,
              mapLayersRef.current.filter(
                (x) => x.kind === "raster" && x.serverId && x.bbox
              )
            );
          })
          .catch(() => {
            /* 404 mientras Celery genera el GeoTIFF; el intervalo reintenta */
          })
          .finally(() => {
            rasterFetchInFlightRef.current.delete(l.id);
          });
      });

      reorderRasterStack(map, layers);
    };

    const run = () => {
      if (map.isStyleLoaded()) syncRasters();
      else map.once("load", syncRasters);
    };
    run();

    const iv = setInterval(() => {
      const pending = mapLayersRef.current.filter(
        (l) => l.kind === "raster" && l.serverId && l.bbox && !map.getSource(l.id)
      );
      if (pending.length && map.isStyleLoaded()) syncRasters();
    }, 2500);

    return () => clearInterval(iv);
  }, [mapLayers, projectId, token, baseStyle]);

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
