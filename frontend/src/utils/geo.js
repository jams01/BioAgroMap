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
