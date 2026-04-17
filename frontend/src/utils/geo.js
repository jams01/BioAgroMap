export function kmlToGeojson(kmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(kmlText, "text/xml");
  const placemarks = xml.getElementsByTagName("Placemark");
  const features = [];
  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const nameEl = pm.getElementsByTagName("name")[0];
    const name = nameEl ? nameEl.textContent : "";
    const coordsEls = pm.getElementsByTagName("coordinates");
    if (coordsEls.length === 0) continue;
    const raw = coordsEls[0].textContent.trim();
    const points = raw
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => {
        const [lng, lat, alt] = s.split(",").map(Number);
        return [lng, lat, ...(alt ? [alt] : [])];
      });
    let geometry;
    if (points.length === 1) {
      geometry = { type: "Point", coordinates: points[0] };
    } else if (
      points.length > 2 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]
    ) {
      geometry = { type: "Polygon", coordinates: [points] };
    } else {
      geometry = { type: "LineString", coordinates: points };
    }
    features.push({ type: "Feature", properties: { name }, geometry });
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}

export async function kmzToGeojson(file) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);
  const kmlEntry =
    zip.file("doc.kml") ||
    Object.values(zip.files).find((f) => f.name.endsWith(".kml"));
  if (!kmlEntry) return null;
  const kmlText = await kmlEntry.async("string");
  return kmlToGeojson(kmlText);
}

/** bounds_wgs84: [west, south, east, north] → par MapLibre fitBounds [[w,s],[e,n]] */
export function bboxFromBoundsWgs84(bounds) {
  if (!bounds || bounds.length < 4) return null;
  const [w, s, e, n] = bounds;
  if (![w, s, e, n].every((x) => Number.isFinite(x))) return null;
  return [
    [w, s],
    [e, n],
  ];
}

export function bboxFromGeojson(geojson) {
  const coords = [];
  const collect = (geom) => {
    if (!geom) return;
    if (geom.type === "Point") coords.push(geom.coordinates);
    else if (geom.type === "MultiPoint" || geom.type === "LineString")
      geom.coordinates.forEach((c) => coords.push(c));
    else if (geom.type === "MultiLineString" || geom.type === "Polygon")
      geom.coordinates.forEach((ring) => ring.forEach((c) => coords.push(c)));
    else if (geom.type === "MultiPolygon")
      geom.coordinates.forEach((poly) =>
        poly.forEach((ring) => ring.forEach((c) => coords.push(c)))
      );
    else if (geom.type === "GeometryCollection" && geom.geometries)
      geom.geometries.forEach(collect);
  };
  if (geojson.type === "FeatureCollection") {
    geojson.features.forEach((f) => collect(f.geometry));
  } else if (geojson.type === "Feature") {
    collect(geojson.geometry);
  } else {
    collect(geojson);
  }
  if (coords.length === 0) return null;
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

export function buildBaseStyle(kind) {
  if (kind === "hibrido") {
    return {
      version: 8,
      sources: {
        esri: {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Esri World Imagery",
        },
        labels: {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Esri Reference",
        },
      },
      layers: [
        { id: "esri", type: "raster", source: "esri" },
        { id: "labels", type: "raster", source: "labels" },
      ],
    };
  }
  if (kind === "satelital") {
    return {
      version: 8,
      sources: {
        esri: {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Esri World Imagery",
        },
      },
      layers: [{ id: "esri", type: "raster", source: "esri" }],
    };
  }
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

/** Clave YYYY-MM-DD para ordenar recortes Sentinel */
export function rasterSortKeyFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const sk = metadata.s2_sort_key;
  if (typeof sk === "string" && sk) return sk;
  const dl = metadata.s2_date_label;
  if (typeof dl === "string" && dl.split("/").length === 3) {
    const [dd, mm, yyyy] = dl.split("/").map((x) => x.trim());
    if (yyyy && yyyy.length === 4) {
      return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    }
  }
  return "";
}

/**
 * Título dd/mm/aaaa_clip desde metadatos; si falta, intenta el nombre legado ("… 03/04/2026").
 */
export function formatRecorteDisplayName(metadata, fallbackName) {
  if (metadata && typeof metadata === "object") {
    const sk = metadata.s2_sort_key;
    if (typeof sk === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sk)) {
      const [y, mo, dd] = sk.split("-");
      return `${dd}/${mo}/${y}_clip`;
    }
    const dl = metadata.s2_date_label;
    if (typeof dl === "string" && dl.includes("/")) {
      const parts = dl.trim().split("/");
      if (parts.length === 3) {
        const [dd, mm, yy] = parts.map((x) => x.trim());
        return `${dd.padStart(2, "0")}/${mm.padStart(2, "0")}/${yy}_clip`;
      }
    }
  }
  if (typeof fallbackName === "string") {
    const m = fallbackName.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[1]}/${m[2]}/${m[3]}_clip`;
  }
  return null;
}
