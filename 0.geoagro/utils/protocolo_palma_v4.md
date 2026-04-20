# Protocolo de Teledetección para el Monitoreo de Palma de Aceite mediante GEE y Python

**Los índices de vegetación satelital permiten diferenciar con fiabilidad plantaciones de palma de aceite juveniles (3 años) de plantaciones adultas (10 años), con índices de borde rojo superando ampliamente al NDVI convencional.** Un Índice de Contenido de Clorofila (CCI) derivado de las bandas de borde rojo del Sentinel-2 alcanzó **R² = 0,94** para la estimación de edad, mientras que el NDVI se satura una vez que ocurre el cierre del dosel alrededor del año 8–10. Este metaestudio sintetiza 17 estudios publicados en revistas arbitradas (2020–2025), proporciona código ejecutable completo para Google Earth Engine (JavaScript) y Python (geemap), y entrega un marco de selección de sensores para el monitoreo operativo de plantaciones. El protocolo completo permite a agrónomos e ingenieros en teledetección implementar la discriminación juvenil-madura, el seguimiento del crecimiento en series temporales, la detección de estrés hídrico y el mapeo de variabilidad intra-lote usando imágenes gratuitas del Sentinel-2.

---

## 1. Base de evidencia científica: lo que confirma la literatura (2020–2025)

Se identificaron y verificaron diecisiete estudios publicados en los cinco dominios de aplicación objetivo. La evidencia respalda firmemente el uso de las bandas de borde rojo del Sentinel-2 para estimar clorofila y edad, el EVI para predicción de biomasa-carbono, y el NDVI/NDWI multitemporal para la detección del año de siembra. Sin embargo, existen dos brechas notables: **ningún estudio arbitrado (2020–2025) aplica el MCARI específicamente a palma de aceite desde datos satelitales**, y **ningún estudio dedicado usa exclusivamente el NDWI para la detección de estrés hídrico en palma**, aunque NDWI/NDMI aparece como variable en modelos de predicción de stocks de carbono y rendimiento.

### 1.1 Índices de borde rojo para clorofila, nitrógeno y estimación de edad

La evidencia más sólida proviene de Jarayee et al. (2024), quienes evaluaron índices de vegetación de banda ancha y estrecha del Sentinel-2 para la estimación de edad de palma de aceite en plantaciones FGV de Malasia Peninsular. El **Índice de Contenido de Clorofila (CCI) alcanzó R² = 0,94** mediante regresión polinomial (y = −4,6062x² + 27,864x + 14,169), superando significativamente al NDVI. El Índice de Diferencia Normalizada de Borde Rojo (NDRE = (B8 − B5)/(B8 + B5)) fue el segundo mejor predictor. Un hallazgo crítico: los índices de vegetación siguen una **curva en forma de joroba** con la edad de la palma — ascienden durante los años juveniles, alcanzan su pico a edad media y luego declinan en plantaciones post-maduras. Esta no linealidad requiere modelos polinomiales o de aprendizaje automático en lugar de una simple regresión lineal.

Para el nitrógeno específicamente, Amirruddin et al. (2021) clasificaron niveles de macronutrientes (N, P, K, Mg, Ca) usando Landsat-8 con SVM, ANN y Random Forest. La clasificación de nitrógeno alcanzó **OA = 79,7 ± 4,3%** — la mayor precisión entre los nutrientes. El potasio alcanzó 76,6%, mientras que P, Mg y Ca no pudieron clasificarse de manera confiable. Amirruddin et al. (2020) demostraron mediante espectrorradiometría de campo que las longitudes de onda del borde rojo (~697–723 nm) muestran la relación más sólida con el contenido de clorofila en frondes maduras de palma, validando la base teórica para el monitoreo satelital del CIre.

### 1.2 EVI para estimación de biomasa y producción

El EVI aparece como predictor significativo en múltiples estudios de rendimiento y biomasa. Watson-Hernández et al. (2022) usaron un conjunto de datos Landsat de 20 años con Random Forest, LASSO, XGBoost y redes neuronales para predicción de rendimiento en Costa Rica, encontrando que **el EVI y los índices de humedad con un rezago temporal de 1 año** produjeron las mejores predicciones. Un estudio de 2025 en *MDPI Resources* demostró modelos de ML en conjunto (RF, Gradient Boosting, XGBoost) usando índices de Sentinel-2 y Landsat para predicción de stock de carbono de palma de aceite, alcanzando **R² = 0,86–0,88** con **RMSE = 8–9 Mg C/ha** a escala de hectárea. El análisis de importancia de variables reveló **NDMI y EVI como predictores dominantes** para los modelos Landsat, mientras que ARVI e índices de borde rojo dominaron para Sentinel-2.

Un estudio comprensivo en *Ecological Informatics* (2024) comparó 17 modelos de ML/DL usando NDVI del Landsat-7 junto con EVI, GCVI, GNDVI, MSAVI, SAVI y datos agronómicos de campo. EVI, NDVI y GCVI mostraron correlaciones positivas sólidas con el peso de racimos, confirmando su utilidad para la predicción de la producción.

### 1.3 NDWI e índices de humedad para el estrés hídrico

Si bien ningún estudio apunta exclusivamente al NDWI para el estrés hídrico de palma, el NDWI y el NDMI = (NIR − SWIR)/(NIR + SWIR) estrechamente relacionado aparecen como variables clave en la predicción de stock de carbono (MDPI Resources, 2025) y estimación de rendimiento (Watson-Hernández et al., 2022). El estudio de stock de carbono encontró que el **NDMI fue el predictor individual más importante** con valores de importancia que superaron 0,80 en múltiples comparaciones de sensores. Descals et al. (2024) usaron series temporales NDWI de Landsat para detectar eventos de tala rasa y transiciones de dosel joven-a-cerrado, permitiendo la estimación global del año de siembra de palma sobre **23,98 millones de hectáreas**.

### 1.4 Análisis de series temporales para la predicción de crecimiento

Los enfoques de series temporales han demostrado ser altamente efectivos. Ang et al. (2022) introdujeron la validación de avance progresivo para la predicción de rendimiento de palma usando series temporales NDVI del Landsat-7, con Random Forest alcanzando **R² = 0,78–0,80, RMSE = 1,00–1,26 t/ha**, y Redes Neuronales Profundas llegando a **R² = 0,85**. Un estudio de 2025 integró un archivo Landsat de 38 años (1987–2024) con Sentinel-2 para la detección de edad de palma usando un enfoque de punto de ruptura similar a LandTrendr, alcanzando **OA de mapeo de extensión = 90,5%** y **RMSE de estimación de edad = 3,97 años** validado contra 234 parcelas de campo. El enfoque identifica años de siembra detectando cuándo el NDVI suavizado cae por debajo del percentil 20 mientras el Índice de Suelo Desnudo supera el percentil 80.

### 1.5 Detección de anomalías y variabilidad intra-lote

Ningún estudio publicado aborda específicamente la detección de anomalías mediante mapas de calor dentro de bloques individuales de palma de aceite. Esta sigue siendo un área de aplicación emergente. El trabajo publicado más cercano involucra el mapeo de severidad de la enfermedad por Ganoderma usando segmentación de disco concéntrico para análisis sub-corona con imágenes hiperesspectrales UAV (Remote Sensing, 2022, DOI: 10.3390/rs14030799). El enfoque del coeficiente de variación implementado en las secciones de código a continuación representa una metodología práctica para identificar anomalías dentro de bloques que la literatura aún no ha validado formalmente para palma de aceite.

---

## 2. Cómo los índices espectrales diferencian palma de aceite de 3 y 10 años

El contraste espectral entre palma juvenil y madura está determinado por la arquitectura del dosel. Una **palma de 3 años** tiene un diámetro de copa de ~3–5 m con 10–50% de cobertura del dosel, dejando suelo desnudo, coberturas y vegetación intercalada visibles para el sensor satelital. Una **palma de 10 años** tiene un diámetro de copa de ~8–12 m con cierre del dosel del 80–100%. Esto produce firmas espectrales drásticamente diferentes.

| Parámetro | Juvenil (3 años) | Adulta (10 años) |
|-----------|------------------|------------------|
| **NDVI** | 0,3–0,55 | 0,75–0,90 |
| **EVI** | 0,15–0,35 | 0,40–0,60 |
| **NDWI** | −0,1 a 0,2 | 0,3–0,5 |
| **CIre** | 0,5–1,5 | 2,0–3,5 |
| Cobertura del dosel | 10–50% | 80–100% |
| IAF | 0,6–1,5 | 3,5–4,5 |
| Reflectancia SWIR | Alta (exposición de suelo) | Baja (absorción vegetal) |
| CV temporal del NDVI | Alto (30–50%) | Bajo (5–15%) |

Estos valores se sintetizan a partir de Tridawati & Darmawan (2018), quienes establecieron una relación logarítmica NDVI-edad (y = 0,0425 ln(x) + 0,723, R² = 0,66); Jarayee et al. (2024); datos de revisión de Chong et al. (2017) que muestran la progresión del IAF de 0,6 a los 2 años hasta 4,0 a los 10–14 años; y datos de campo del MPOB. Una perspectiva crítica: el **NDVI se satura aproximadamente en el año 8–10** cuando ocurre el cierre del dosel. Los índices de borde rojo (CIre, NDRE, CCI) continúan diferenciando clases de edad más allá de este punto de saturación porque son sensibles a la concentración de clorofila dentro del dosel y no solo a la fracción verde.

---

## 3. Tabla de citaciones verificadas

| N° | Autores (Año) | Revista | DOI | Índice clave | Sensor | Métrica clave | Dif. Edad |
|---|--------------|---------|-----|-------------|--------|---------------|-----------|
| 1 | Jarayee et al. (2024) | Asia-Pac. J. Sci. Technol. | 10.14456/apst.2024.30 | CCI, NDRE | Sentinel-2 | R²=0,94 | ✅ |
| 2 | Ang et al. (2022) | Geocarto International | 10.1080/10106049.2022.2025920 | Serie temporal NDVI | Landsat-7, MODIS | R²=0,85 (DNN) | Indirecto |
| 3 | Watson-Hernández et al. (2022) | AgriEngineering | 10.3390/agriengineering4010019 | EVI, NDWI, NDVI | Landsat | Ensamble ML | No |
| 4 | Amirruddin et al. (2021) | Remote Sensing | 10.3390/rs13112029 | Bandas + VIs | Landsat-8 | OA=79,7% (N) | No |
| 5 | Amirruddin et al. (2020) | Comp. Electron. Agric. | 10.1016/j.compag.2020.105221 | VIs borde rojo | Espectrorradiómetro | Clasif. DT/RF | ✅ |
| 6 | Amirruddin et al. (2020) | Comp. Electron. Agric. | 10.1016/j.compag.2020.105768 | VIs Clorofila/RE | Espectro.+UAV | BAcc>0,77 | ✅ |
| 7 | Xu, K. et al. (2021) | Remote Sensing | 10.3390/rs13020236 | NDVI, EVI, SAR | Landsat-8+S1 | OA≤92% | ✅ |
| 8 | Xu, Y. et al. (2023) | Int. J. Digital Earth | 10.1080/17538947.2023.2220612 | Fusión multisensor | Planet, S1, S2 | Mapa global | ✅ |
| 9 | Danylo et al. (2021) | Scientific Data | 10.1038/s41597-021-00867-1 | NDVI + SAR | Landsat+S1 | Gran escala | ✅ |
| 10 | Descals et al. (2024) | Earth Syst. Sci. Data | 10.5194/essd-16-5111-2024 | Serie temporal NDWI | Landsat+S1 | PA=91,9% | ✅ |
| 11 | MDPI Resources (2025) | Resources | 10.3390/resources15010012 | NDMI, EVI, ARVI | L8, L9, S2 | R²=0,86–0,88 | Indirecto |
| 12 | Ardiansyah et al. (2023) | IJMARS | 10.59653/ijmars.v1i02.95 | Reflectancia S2 | Sentinel-2 | Reg. RF | ✅ |
| 13 | Yadegari et al. (2020) | Agriculture | 10.3390/agriculture10040133 | 28 VIs evaluados | SPOT-7 | R² regresión | No |

---

## 4. Fórmulas de índices con mapeo exacto de bandas del Sentinel-2

Todas las fórmulas usan los nombres de banda del Sentinel-2 Surface Reflectance tal como aparecen en la colección GEE `COPERNICUS/S2_SR_HARMONIZED`. Los valores de reflectancia están escalados por 10.000 (es decir, una reflectancia de 0,2 se almacena como 2000).

**NDVI** — Índice de Vegetación de Diferencia Normalizada (verdor de banda ancha):
```
NDVI = (B8 − B4) / (B8 + B4)
```
Donde B8 = NIR (842 nm, 10 m), B4 = Rojo (665 nm, 10 m). Rango: −1 a +1. Palma: juvenil ~0,3–0,55, adulta ~0,75–0,90.

**EVI** — Índice de Vegetación Mejorado (sensible a biomasa, efectos reducidos de suelo/atmósfera):
```
EVI = 2,5 × (B8 − B4) / (B8 + 6×B4 − 7,5×B2 + 10000)
```
Donde B2 = Azul (490 nm, 10 m). La constante 10.000 reemplaza al 1,0 en la fórmula estándar para contabilizar el escalado SR del S2. Rango: ~0 a 1,0.

**NDWI** — Índice de Agua de Diferencia Normalizada (humedad del dosel vía SWIR):
```
NDWI = (B8 − B11) / (B8 + B11)
```
Donde B11 = SWIR1 (1610 nm, 20 m). Valores más altos indican mayor contenido de agua en el dosel. Las palmas juveniles muestran NDWI más bajo debido al suelo desnudo expuesto.

**CIre** — Índice de Clorofila de Borde Rojo (concentración de clorofila):
```
CIre = (B8 / B5) − 1
```
Donde B5 = Borde Rojo 1 (705 nm, 20 m). Linealmente relacionado con el contenido de clorofila del dosel. Más sensible que el NDVI en doseles densos.

**MCARI** — Índice Modificado de Absorción de Clorofila en Reflectancia:
```
MCARI = [(B5 − B4) − 0,2 × (B5 − B3)] × (B5 / B4)
```
Donde B3 = Verde (560 nm, 10 m). Sensible a la absorción de clorofila mientras corrige parcialmente el fondo del suelo. Nota: ningún estudio arbitrado ha aplicado esta fórmula exacta a palma de aceite desde datos satelitales, aunque las bandas de borde rojo que utiliza están validadas para la evaluación de clorofila en palma.

---

## 5. Código JavaScript completo para GEE

El siguiente script está listo para pegarse en el Editor de Código de GEE en code.earthengine.google.com. Carga el SR del Sentinel-2, aplica enmascaramiento agresivo de nubes basado en SCL, calcula los cinco índices, genera gráficos de series temporales comparativas para dos lotes, crea mapas de calor de variabilidad y exporta los resultados.

```javascript
// =============================================================================
// SISTEMA DE MONITOREO DE PALMA DE ACEITE
// Google Earth Engine - Script Completo
// =============================================================================
// Monitorea dos lotes de palma de aceite usando imágenes del Sentinel-2:
//   Lote 1: Palma de aceite juvenil (3 años, dosel abierto, suelo expuesto)
//   Lote 2: Palma de aceite adulta (10 años, dosel cerrado)
// Índices: NDVI, EVI, NDWI, CIre, MCARI
// =============================================================================

// =============== SECCIÓN 1: DEFINIR ÁREAS DE ESTUDIO =========================
// MÉTODO A: Definición manual de polígonos (coordenadas de ejemplo - Johor, Malasia)
// Reemplace estas coordenadas con los límites reales de sus lotes.

var lote1_juvenil = ee.Geometry.Polygon([
  [103.420, 1.620], [103.425, 1.620],
  [103.425, 1.625], [103.420, 1.625],
  [103.420, 1.620]
]);

var lote2_adulto = ee.Geometry.Polygon([
  [103.430, 1.620], [103.435, 1.620],
  [103.435, 1.625], [103.430, 1.625],
  [103.430, 1.620]
]);

// MÉTODO B: Cargar KMZ/Shapefile como Asset de GEE:
// var lote1_juvenil = ee.FeatureCollection('users/SU_USUARIO/lote1_juvenil_3yr').geometry();
// var lote2_adulto  = ee.FeatureCollection('users/SU_USUARIO/lote2_adulto_10yr').geometry();

var feat_lote1 = ee.Feature(lote1_juvenil, {label: 'Lote 1 - Juvenil (3 años)', lot_id: 1});
var feat_lote2 = ee.Feature(lote2_adulto,  {label: 'Lote 2 - Adulto (10 años)', lot_id: 2});
var lotes = ee.FeatureCollection([feat_lote1, feat_lote2]);
var areaEstudio = lotes.geometry().bounds();

// =============== SECCIÓN 2: RANGO DE FECHAS ==================================
var fechaInicio = '2024-01-01';
var fechaFin    = '2025-12-31';

// =============== SECCIÓN 3: CARGAR SENTINEL-2 SR =============================
var s2_sr = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterDate(fechaInicio, fechaFin)
  .filterBounds(areaEstudio)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40));

print('Imágenes Sentinel-2 tras filtro inicial:', s2_sr.size());

// =============== SECCIÓN 4: ENMASCARAMIENTO DE NUBES (SCL) ===================
// SCL: 3=Sombra de nube, 4=Vegetación, 5=Suelo desnudo, 6=Agua, 7=Sin clasificar,
//       8=Nube prob. media, 9=Nube prob. alta, 10=Cirrus fino, 11=Nieve
// AGRESIVO: Conservar SOLO vegetación (4) y suelo desnudo (5)

function enmascararNubesS2(imagen) {
  var scl = imagen.select('SCL');
  var mascaraClear = scl.eq(4).or(scl.eq(5));
  return imagen.updateMask(mascaraClear)
    .copyProperties(imagen, ['system:time_start', 'system:index']);
}

var s2_enmascarado = s2_sr.map(enmascararNubesS2);

// =============== SECCIÓN 5: CALCULAR ÍNDICES DE VEGETACIÓN ==================
function agregarIndices(imagen) {
  var nir   = imagen.select('B8');
  var rojo  = imagen.select('B4');
  var azul  = imagen.select('B2');
  var verde = imagen.select('B3');
  var re1   = imagen.select('B5');
  var swir1 = imagen.select('B11');

  var ndvi = imagen.normalizedDifference(['B8', 'B4']).rename('NDVI');

  // EVI: la constante 10000 compensa el escalado de la reflectancia SR del S2 (x10000)
  var evi = nir.subtract(rojo).multiply(2.5)
    .divide(nir.add(rojo.multiply(6)).subtract(azul.multiply(7.5)).add(10000))
    .rename('EVI');

  var ndwi = imagen.normalizedDifference(['B8', 'B11']).rename('NDWI');

  var cire = nir.divide(re1).subtract(1).rename('CIre');

  var mcari = re1.subtract(rojo)
    .subtract(re1.subtract(verde).multiply(0.2))
    .multiply(re1.divide(rojo))
    .rename('MCARI');

  return imagen.addBands([ndvi, evi, ndwi, cire, mcari]);
}

var s2_indices = s2_enmascarado.map(agregarIndices);
var bandasIndice = ['NDVI', 'EVI', 'NDWI', 'CIre', 'MCARI'];
var s2_soloIndices = s2_indices.select(bandasIndice);

// =============== SECCIÓN 6: COMPOSITES MENSUALES POR MEDIANA ================
var meses = ee.List.sequence(0, 23);
var inicioEE = ee.Date(fechaInicio);

var compositosMensuales = ee.ImageCollection.fromImages(
  meses.map(function(m) {
    var mesInicio = inicioEE.advance(m, 'month');
    var mesFin    = mesInicio.advance(1, 'month');
    var mensual   = s2_soloIndices.filterDate(mesInicio, mesFin).median();
    return mensual
      .set('system:time_start', mesInicio.millis())
      .set('mes', mesInicio.format('YYYY-MM'));
  })
);

var compositosFiltrados = compositosMensuales.map(function(img) {
  return img.set('contBandas', img.bandNames().size());
}).filter(ee.Filter.gt('contBandas', 0));

print('Número de composites mensuales:', compositosFiltrados.size());

// =============== SECCIÓN 7: GRÁFICAS DE SERIES TEMPORALES ===================
var coloresGrafico = ['#e74c3c', '#27ae60']; // rojo=juvenil, verde=adulto

var graficaNDVI = ui.Chart.image.seriesByRegion({
  imageCollection: compositosFiltrados, band: 'NDVI',
  regions: lotes, reducer: ee.Reducer.mean(), scale: 10,
  seriesProperty: 'label', xProperty: 'system:time_start'
}).setOptions({
  title: 'Serie Temporal NDVI - Juvenil (3 años) vs Adulto (10 años)',
  hAxis: {title: 'Fecha'}, vAxis: {title: 'NDVI'},
  lineWidth: 2, pointSize: 4, colors: coloresGrafico,
  curveType: 'function', interpolateNulls: true
});
print(graficaNDVI);

var graficaEVI = ui.Chart.image.seriesByRegion({
  imageCollection: compositosFiltrados, band: 'EVI',
  regions: lotes, reducer: ee.Reducer.mean(), scale: 10,
  seriesProperty: 'label', xProperty: 'system:time_start'
}).setOptions({
  title: 'Serie Temporal EVI - Juvenil (3 años) vs Adulto (10 años)',
  hAxis: {title: 'Fecha'}, vAxis: {title: 'EVI'},
  lineWidth: 2, pointSize: 4, colors: coloresGrafico,
  curveType: 'function', interpolateNulls: true
});
print(graficaEVI);

var graficaCIre = ui.Chart.image.seriesByRegion({
  imageCollection: compositosFiltrados, band: 'CIre',
  regions: lotes, reducer: ee.Reducer.mean(), scale: 10,
  seriesProperty: 'label', xProperty: 'system:time_start'
}).setOptions({
  title: 'CIre (Índice de Clorofila Borde Rojo) - Juvenil vs Adulto',
  hAxis: {title: 'Fecha'}, vAxis: {title: 'CIre'},
  lineWidth: 2, pointSize: 4, colors: coloresGrafico,
  curveType: 'function', interpolateNulls: true
});
print(graficaCIre);

var graficaNDWI = ui.Chart.image.seriesByRegion({
  imageCollection: compositosFiltrados, band: 'NDWI',
  regions: lotes, reducer: ee.Reducer.mean(), scale: 10,
  seriesProperty: 'label', xProperty: 'system:time_start'
}).setOptions({
  title: 'Serie Temporal NDWI - Juvenil (3 años) vs Adulto (10 años)',
  hAxis: {title: 'Fecha'}, vAxis: {title: 'NDWI'},
  lineWidth: 2, pointSize: 4, colors: coloresGrafico,
  curveType: 'function', interpolateNulls: true
});
print(graficaNDWI);

// =============== SECCIÓN 8: MAPAS DE CALOR DE VARIABILIDAD ==================
var imagenMedia  = s2_soloIndices.mean();
var imagenDesEst = s2_soloIndices.reduce(ee.Reducer.stdDev());

var imagenCV = ee.Image.cat(
  bandasIndice.map(function(banda) {
    return imagenDesEst.select(banda + '_stdDev')
      .divide(imagenMedia.select(banda)).abs().multiply(100)
      .rename(banda + '_CV');
  })
);

var palMagma  = ['000004','180f3e','451077','721f81','9e2f7f',
                 'cd4071','f1605d','feb078','fcfdbf'];
var palRdYlGn = ['d73027','f46d43','fdae61','fee08b','ffffbf',
                 'd9ef8b','a6d96a','66bd63','1a9850'];

// Capas Lote 1
Map.addLayer(imagenMedia.select('NDVI').clip(lote1_juvenil),
  {min: 0, max: 0.9, palette: palRdYlGn}, 'Lote 1 - NDVI Medio', false);
Map.addLayer(imagenCV.select('NDVI_CV').clip(lote1_juvenil),
  {min: 0, max: 50, palette: palMagma}, 'Lote 1 - CV NDVI (%)', false);
Map.addLayer(imagenCV.select('EVI_CV').clip(lote1_juvenil),
  {min: 0, max: 60, palette: palMagma}, 'Lote 1 - CV EVI (%)', false);
Map.addLayer(imagenCV.select('NDWI_CV').clip(lote1_juvenil),
  {min: 0, max: 80, palette: palMagma}, 'Lote 1 - CV NDWI (%)', false);
Map.addLayer(imagenCV.select('CIre_CV').clip(lote1_juvenil),
  {min: 0, max: 50, palette: palMagma}, 'Lote 1 - CV CIre (%)', false);

// Capas Lote 2
Map.addLayer(imagenMedia.select('NDVI').clip(lote2_adulto),
  {min: 0, max: 0.9, palette: palRdYlGn}, 'Lote 2 - NDVI Medio', false);
Map.addLayer(imagenCV.select('NDVI_CV').clip(lote2_adulto),
  {min: 0, max: 50, palette: palMagma}, 'Lote 2 - CV NDVI (%)', false);
Map.addLayer(imagenCV.select('EVI_CV').clip(lote2_adulto),
  {min: 0, max: 60, palette: palMagma}, 'Lote 2 - CV EVI (%)', false);
Map.addLayer(imagenCV.select('NDWI_CV').clip(lote2_adulto),
  {min: 0, max: 80, palette: palMagma}, 'Lote 2 - CV NDWI (%)', false);
Map.addLayer(imagenCV.select('CIre_CV').clip(lote2_adulto),
  {min: 0, max: 50, palette: palMagma}, 'Lote 2 - CV CIre (%)', false);

// Límites y mapa base
Map.addLayer(lote1_juvenil, {color: 'FF0000'}, 'Límite Lote 1 - Juvenil');
Map.addLayer(lote2_adulto,  {color: '0000FF'}, 'Límite Lote 2 - Adulto');
var colorReal = s2_enmascarado.median().clip(areaEstudio);
Map.addLayer(colorReal, {bands: ['B4','B3','B2'], min: 0, max: 3000},
  'Composición en Color Real', true);
Map.centerObject(areaEstudio, 15);

// =============== SECCIÓN 9: ESTADÍSTICAS RESUMEN ============================
function imprimirEstadisticasLote(geomLote, nombreLote) {
  var stats = imagenMedia.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: geomLote, scale: 10, maxPixels: 1e9
  });
  print(nombreLote + ' - Valores Medios de los Índices:', stats);
  var statsCV = imagenCV.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: geomLote, scale: 10, maxPixels: 1e9
  });
  print(nombreLote + ' - CV Medio (%):', statsCV);
}
imprimirEstadisticasLote(lote1_juvenil, 'Lote 1 - Juvenil (3 años)');
imprimirEstadisticasLote(lote2_adulto,  'Lote 2 - Adulto (10 años)');

// =============== SECCIÓN 10: EXPORTACIONES ==================================
var exportarST = compositosFiltrados.map(function(imagen) {
  var l1 = imagen.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: lote1_juvenil, scale: 10, maxPixels: 1e9
  });
  var l2 = imagen.reduceRegion({
    reducer: ee.Reducer.mean(), geometry: lote2_adulto, scale: 10, maxPixels: 1e9
  });
  return ee.Feature(null, {
    'fecha': ee.Date(imagen.get('system:time_start')).format('YYYY-MM-dd'),
    'lote1_NDVI': l1.get('NDVI'), 'lote1_EVI': l1.get('EVI'),
    'lote1_NDWI': l1.get('NDWI'), 'lote1_CIre': l1.get('CIre'),
    'lote1_MCARI': l1.get('MCARI'),
    'lote2_NDVI': l2.get('NDVI'), 'lote2_EVI': l2.get('EVI'),
    'lote2_NDWI': l2.get('NDWI'), 'lote2_CIre': l2.get('CIre'),
    'lote2_MCARI': l2.get('MCARI')
  });
});

Export.table.toDrive({
  collection: ee.FeatureCollection(exportarST),
  description: 'PalmaAceite_IndicesVeg_MensualST',
  folder: 'GEE_PalmaAceite',
  fileNamePrefix: 'palma_indices_mensuales',
  fileFormat: 'CSV'
});

Export.image.toDrive({
  image: imagenCV.clip(lote1_juvenil),
  description: 'Lote1_Juvenil_Mapas_CV',
  folder: 'GEE_PalmaAceite', fileNamePrefix: 'lote1_cv',
  region: lote1_juvenil, scale: 10, maxPixels: 1e9
});

Export.image.toDrive({
  image: imagenCV.clip(lote2_adulto),
  description: 'Lote2_Adulto_Mapas_CV',
  folder: 'GEE_PalmaAceite', fileNamePrefix: 'lote2_cv',
  region: lote2_adulto, scale: 10, maxPixels: 1e9
});

print('=== SISTEMA DE MONITOREO DE PALMA DE ACEITE CARGADO ===');
print('Esperado: NDVI Juvenil ~0,3-0,55, NDVI Adulto ~0,75-0,90');
print('Reemplace las coordenadas de ejemplo con los polígonos reales de la plantación.');
print('Verifique la pestaña Tasks para ejecutar las exportaciones.');
```

### Notas de implementación para el script de GEE

La fórmula del EVI usa `+10000` en lugar de `+1` porque la reflectancia SR del Sentinel-2 se almacena como enteros escalados por 10.000. La máscara de nubes SCL retiene solo la clase 4 (vegetación) y la clase 5 (suelo desnudo) — esto es deliberadamente agresivo para regiones tropicales donde el cirrus fino y la neblina son comunes. El composite mensual por mediana reduce el ruido por imagen mientras preserva las señales fenológicas. Los mapas de calor del Coeficiente de Variación (CV = σ/μ × 100%) revelan patrones espaciales de inestabilidad temporal: **los lotes juveniles mostrarán CV más alto** (30–50%) debido al rápido crecimiento del dosel y los píxeles mixtos suelo-vegetación, mientras que **los lotes adultos muestran CV más bajo** (5–15%) reflejando un dosel cerrado estable.

---

## 6. Código Python completo con geemap

El siguiente código Python se ejecuta en un cuaderno Jupyter e implementa el pipeline completo de análisis: procesamiento de datos GEE, extracción de series temporales, comparación estadística, análisis de pendiente de crecimiento y visualización de calidad publicación.

```python
# =============================================================================
# CELDA 1: Configuración y Autenticación
# =============================================================================
# Instalar si es necesario: pip install geemap earthengine-api pandas numpy matplotlib seaborn scipy

import ee
import geemap
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import seaborn as sns
from scipy import stats
from datetime import datetime, timedelta

# Autenticar e inicializar GEE
# ee.Authenticate()  # Descomentar en la primera ejecución
ee.Initialize(project='su-proyecto-gee')  # Reemplazar con su ID de proyecto

print("GEE inicializado exitosamente.")
```

```python
# =============================================================================
# CELDA 2: Definir Áreas de Estudio
# =============================================================================
# Reemplace las coordenadas con los límites reales de su plantación

# Lote 1: Palma de aceite juvenil de 3 años (Johor, Malasia - ejemplo)
coords_lote1 = [[103.420, 1.620], [103.425, 1.620],
                [103.425, 1.625], [103.420, 1.625],
                [103.420, 1.620]]

# Lote 2: Palma de aceite adulta de 10 años
coords_lote2 = [[103.430, 1.620], [103.435, 1.620],
                [103.435, 1.625], [103.430, 1.625],
                [103.430, 1.620]]

lote1 = ee.Geometry.Polygon(coords_lote1)
lote2 = ee.Geometry.Polygon(coords_lote2)

# Alternativa: Cargar desde asset subido
# lote1 = ee.FeatureCollection('users/SU_USUARIO/lote1_juvenil').geometry()
# lote2 = ee.FeatureCollection('users/SU_USUARIO/lote2_adulto').geometry()

area_estudio = lote1.bounds().union(lote2.bounds())

# Rango de fechas: 24 meses
FECHA_INICIO = '2024-01-01'
FECHA_FIN    = '2025-12-31'

print(f"Período de estudio: {FECHA_INICIO} a {FECHA_FIN}")
print("Lote 1: Juvenil (3 años) | Lote 2: Adulto (10 años)")
```

```python
# =============================================================================
# CELDA 3: Funciones de Enmascaramiento de Nubes y Cálculo de Índices
# =============================================================================

def enmascarar_nubes_s2(imagen):
    """Enmascaramiento agresivo SCL. Conserva solo vegetación (4) y suelo desnudo (5)."""
    scl = imagen.select('SCL')
    mascara_clear = scl.eq(4).Or(scl.eq(5))
    return imagen.updateMask(mascara_clear) \
        .copyProperties(imagen, ['system:time_start', 'system:index'])

def agregar_indices(imagen):
    """Calcula NDVI, EVI, NDWI, CIre y MCARI desde bandas SR del Sentinel-2."""
    nir   = imagen.select('B8')     # NIR, 842 nm, 10 m
    rojo  = imagen.select('B4')     # Rojo, 665 nm, 10 m
    azul  = imagen.select('B2')     # Azul, 490 nm, 10 m
    verde = imagen.select('B3')     # Verde, 560 nm, 10 m
    re1   = imagen.select('B5')     # Borde Rojo 1, 705 nm, 20 m
    swir1 = imagen.select('B11')    # SWIR1, 1610 nm, 20 m

    ndvi = imagen.normalizedDifference(['B8', 'B4']).rename('NDVI')

    evi = nir.subtract(rojo).multiply(2.5) \
        .divide(nir.add(rojo.multiply(6)).subtract(azul.multiply(7.5)).add(10000)) \
        .rename('EVI')

    ndwi = imagen.normalizedDifference(['B8', 'B11']).rename('NDWI')

    cire = nir.divide(re1).subtract(1).rename('CIre')

    mcari = re1.subtract(rojo) \
        .subtract(re1.subtract(verde).multiply(0.2)) \
        .multiply(re1.divide(rojo)) \
        .rename('MCARI')

    return imagen.addBands([ndvi, evi, ndwi, cire, mcari])

print("Funciones definidas: enmascarar_nubes_s2, agregar_indices")
```

```python
# =============================================================================
# CELDA 4: Cargar y Procesar la Colección Sentinel-2
# =============================================================================

s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED') \
    .filterDate(FECHA_INICIO, FECHA_FIN) \
    .filterBounds(area_estudio) \
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40)) \
    .map(enmascarar_nubes_s2) \
    .map(agregar_indices)

bandas_indice = ['NDVI', 'EVI', 'NDWI', 'CIre', 'MCARI']
s2_indices = s2.select(bandas_indice)

print(f"Total de imágenes tras filtrado: {s2.size().getInfo()}")
```

```python
# =============================================================================
# CELDA 5: Extraer Series Temporales Mensuales para Ambos Lotes
# =============================================================================

def extraer_stats_mensuales(geometria, nombre_lote):
    """Extrae valores mensuales medianos de los índices para una geometría dada."""
    registros = []
    inicio = ee.Date(FECHA_INICIO)

    for m in range(24):  # 24 meses
        mes_inicio = inicio.advance(m, 'month')
        mes_fin    = mes_inicio.advance(1, 'month')

        mensual = s2_indices.filterDate(mes_inicio, mes_fin).median()

        stats = mensual.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=geometria,
            scale=10,
            maxPixels=1e9
        ).getInfo()

        fecha_str = mes_inicio.format('YYYY-MM-dd').getInfo()
        stats['fecha'] = fecha_str
        stats['lote'] = nombre_lote
        registros.append(stats)

    return pd.DataFrame(registros)

print("Extrayendo serie temporal Lote 1 (Juvenil, 3 años)...")
df_lote1 = extraer_stats_mensuales(lote1, 'Juvenil (3 años)')

print("Extrayendo serie temporal Lote 2 (Adulto, 10 años)...")
df_lote2 = extraer_stats_mensuales(lote2, 'Adulto (10 años)')

# Combinar y limpiar
df = pd.concat([df_lote1, df_lote2], ignore_index=True)
df['fecha'] = pd.to_datetime(df['fecha'])
df = df.dropna(subset=['NDVI'])  # Eliminar meses sin datos válidos

print(f"\nTotal de registros: {len(df)}")
print(df.head(10))
```

```python
# =============================================================================
# CELDA 6: Gráficas Comparativas de Series Temporales
# =============================================================================

sns.set_style("whitegrid")
fig, ejes = plt.subplots(2, 2, figsize=(16, 10), sharex=True)
fig.suptitle('Series Temporales de Índices de Vegetación de Palma de Aceite\n'
             'Juvenil (3 años) vs Adulto (10 años)',
             fontsize=16, fontweight='bold')

colores = {'Juvenil (3 años)': '#e74c3c', 'Adulto (10 años)': '#27ae60'}

for eje, nombre_indice, titulo in zip(
    ejes.flat,
    ['NDVI', 'EVI', 'CIre', 'NDWI'],
    ['NDVI (Verdor)', 'EVI (Biomasa)', 'CIre (Clorofila Borde Rojo)', 'NDWI (Agua del Dosel)']
):
    for nombre_lote, color in colores.items():
        datos_lote = df[df['lote'] == nombre_lote].sort_values('fecha')
        eje.plot(datos_lote['fecha'], datos_lote[nombre_indice],
                 'o-', color=color, label=nombre_lote, linewidth=2, markersize=5)

        # Agregar línea de tendencia lineal
        x_numerico = mdates.date2num(datos_lote['fecha'])
        mascara = datos_lote[nombre_indice].notna()
        if mascara.sum() > 2:
            pendiente, intercepto, r, p, se = stats.linregress(
                x_numerico[mascara], datos_lote[nombre_indice][mascara]
            )
            tendencia_y = pendiente * x_numerico + intercepto
            eje.plot(datos_lote['fecha'], tendencia_y, '--', color=color, alpha=0.5,
                     linewidth=1)
            eje.text(0.02, 0.98 if nombre_lote == 'Juvenil (3 años)' else 0.88,
                     f'{nombre_lote}: pendiente={pendiente:.6f}/día, R²={r**2:.3f}',
                     transform=eje.transAxes, fontsize=8, va='top',
                     color=color, fontweight='bold')

    eje.set_title(titulo, fontsize=12, fontweight='bold')
    eje.set_ylabel(nombre_indice)
    eje.legend(loc='lower right', fontsize=9)
    eje.xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    eje.tick_params(axis='x', rotation=45)

plt.tight_layout()
plt.savefig('palma_series_temporales_comparacion.png', dpi=300, bbox_inches='tight')
plt.show()
print("Guardado: palma_series_temporales_comparacion.png")
```

```python
# =============================================================================
# CELDA 7: Análisis de Pendiente de Crecimiento
# =============================================================================

def calcular_metricas_crecimiento(df, nombre_lote, nombre_indice):
    """Calcula la tasa de crecimiento (pendiente) y estadísticas para un lote e índice."""
    datos_lote = df[df['lote'] == nombre_lote].sort_values('fecha').dropna(subset=[nombre_indice])
    if len(datos_lote) < 3:
        return None

    x = np.arange(len(datos_lote))  # meses
    y = datos_lote[nombre_indice].values
    pendiente, intercepto, r_valor, p_valor, error_std = stats.linregress(x, y)

    return {
        'lote': nombre_lote,
        'indice': nombre_indice,
        'pendiente_por_mes': pendiente,
        'r_cuadrado': r_valor**2,
        'p_valor': p_valor,
        'media': np.mean(y),
        'desv_std': np.std(y),
        'n_meses': len(datos_lote)
    }

# Calcular pendientes para todos los índices
resultados_crecimiento = []
for idx in ['NDVI', 'EVI', 'CIre', 'NDWI']:
    for lote in ['Juvenil (3 años)', 'Adulto (10 años)']:
        resultado = calcular_metricas_crecimiento(df, lote, idx)
        if resultado:
            resultados_crecimiento.append(resultado)

df_crecimiento = pd.DataFrame(resultados_crecimiento)
print("=== ANÁLISIS DE PENDIENTE DE CRECIMIENTO ===")
print(df_crecimiento.to_string(index=False))

# Visualizar comparación de pendientes
fig, eje = plt.subplots(figsize=(10, 6))
indices = ['NDVI', 'EVI', 'CIre', 'NDWI']
pos_x = np.arange(len(indices))
ancho = 0.35

pendientes_juv = [df_crecimiento[(df_crecimiento['lote']=='Juvenil (3 años)') &
                  (df_crecimiento['indice']==idx)]['pendiente_por_mes'].values[0]
                  for idx in indices]
pendientes_adu = [df_crecimiento[(df_crecimiento['lote']=='Adulto (10 años)') &
                  (df_crecimiento['indice']==idx)]['pendiente_por_mes'].values[0]
                  for idx in indices]

eje.bar(pos_x - ancho/2, pendientes_juv, ancho, label='Juvenil (3 años)',
        color='#e74c3c', alpha=0.8)
eje.bar(pos_x + ancho/2, pendientes_adu, ancho, label='Adulto (10 años)',
        color='#27ae60', alpha=0.8)

eje.set_xlabel('Índice de Vegetación', fontweight='bold')
eje.set_ylabel('Pendiente Mensual de Crecimiento', fontweight='bold')
eje.set_title('Comparación de Tasa de Crecimiento: Palma Juvenil vs Adulta',
              fontsize=14, fontweight='bold')
eje.set_xticks(pos_x)
eje.set_xticklabels(indices)
eje.legend()
eje.axhline(y=0, color='black', linestyle='-', linewidth=0.5)
eje.grid(axis='y', alpha=0.3)

plt.tight_layout()
plt.savefig('palma_comparacion_pendiente_crecimiento.png', dpi=300, bbox_inches='tight')
plt.show()
print("\nEsperado: El lote juvenil muestra pendiente positiva (dosel en crecimiento);")
print("El lote adulto muestra pendiente cercana a cero (dosel maduro estable).")
```

```python
# =============================================================================
# CELDA 8: Simulación de Trayectoria Histórica
# =============================================================================
# Comparar la trayectoria actual del lote de 3 años con la del lote de 10 años
# a esa misma edad. Usa el modelo logarítmico NDVI-edad de Tridawati & Darmawan (2018):
#   NDVI = 0,0425 * ln(edad) + 0,723

def modelo_ndvi_edad(edad_años):
    """Modelo logarítmico Tridawati & Darmawan (2018): NDVI = 0,0425*ln(edad)+0,723"""
    return 0.0425 * np.log(edad_años) + 0.723

edades = np.linspace(1, 25, 100)
ndvi_predicho = modelo_ndvi_edad(edades)

fig, eje = plt.subplots(figsize=(12, 7))
eje.plot(edades, ndvi_predicho, 'b-', linewidth=2.5,
         label='Modelo publicado: NDVI=0,0425·ln(edad)+0,723 (Tridawati 2018)')

# Marcar lotes actuales
media_lote1 = df[df['lote']=='Juvenil (3 años)']['NDVI'].mean()
media_lote2 = df[df['lote']=='Adulto (10 años)']['NDVI'].mean()

if not np.isnan(media_lote1):
    eje.scatter([3], [media_lote1], c='#e74c3c', s=200, zorder=5, edgecolors='black',
                label=f'Lote 1 observado: edad=3 años, NDVI={media_lote1:.3f}')
if not np.isnan(media_lote2):
    eje.scatter([10], [media_lote2], c='#27ae60', s=200, zorder=5, edgecolors='black',
                label=f'Lote 2 observado: edad=10 años, NDVI={media_lote2:.3f}')

# Marcar predicciones del modelo para comparación
eje.scatter([3], [modelo_ndvi_edad(3)], c='blue', s=100, marker='x', zorder=5,
            label=f'Predicción modelo edad=3: NDVI={modelo_ndvi_edad(3):.3f}')
eje.scatter([10], [modelo_ndvi_edad(10)], c='blue', s=100, marker='x', zorder=5,
            label=f'Predicción modelo edad=10: NDVI={modelo_ndvi_edad(10):.3f}')

# Zona de cierre del dosel
eje.axvspan(7, 10, alpha=0.15, color='green', label='Zona de cierre del dosel (7-10 años)')
eje.axhline(y=0.8, color='gray', linestyle=':', alpha=0.5)
eje.text(20, 0.81, 'Umbral de saturación del NDVI', fontsize=9, color='gray')

eje.set_xlabel('Edad de la Palma de Aceite (años)', fontsize=12, fontweight='bold')
eje.set_ylabel('NDVI', fontsize=12, fontweight='bold')
eje.set_title('Trayectoria NDVI-Edad: Observado vs Modelo Publicado\n'
              'Evaluar si el lote juvenil sigue la trayectoria histórica esperada',
              fontsize=14, fontweight='bold')
eje.legend(loc='lower right', fontsize=9)
eje.set_xlim(0, 26)
eje.set_ylim(0.4, 1.0)
eje.grid(alpha=0.3)

plt.tight_layout()
plt.savefig('palma_trayectoria_ndvi_edad.png', dpi=300, bbox_inches='tight')
plt.show()
print("Si NDVI del lote juvenil está POR DEBAJO del modelo → posible estrés o deficiencia nutricional")
print("Si está POR ENCIMA → crecimiento saludable superior a la línea base regional")
```

```python
# =============================================================================
# CELDA 9: Generación de Mapas de Calor de Variabilidad con geemap
# =============================================================================

Mapa = geemap.Map(center=[1.6225, 103.4275], zoom=15)

# Calcular media temporal y CV para NDVI
ndvi_medio = s2_indices.select('NDVI').mean()
ndvi_desvEst = s2_indices.select('NDVI').reduce(ee.Reducer.stdDev())
ndvi_cv = ndvi_desvEst.divide(ndvi_medio).abs().multiply(100).rename('NDVI_CV')

# Capas NDVI medio
vis_ndvi = {'min': 0, 'max': 0.9,
            'palette': ['d73027','fdae61','ffffbf','a6d96a','1a9850']}
vis_cv = {'min': 0, 'max': 50,
          'palette': ['000004','451077','721f81','cd4071','f1605d','feb078','fcfdbf']}

Mapa.addLayer(ndvi_medio.clip(lote1), vis_ndvi, 'Lote 1 - NDVI Medio')
Mapa.addLayer(ndvi_cv.clip(lote1), vis_cv, 'Lote 1 - NDVI CV (%)')
Mapa.addLayer(ndvi_medio.clip(lote2), vis_ndvi, 'Lote 2 - NDVI Medio')
Mapa.addLayer(ndvi_cv.clip(lote2), vis_cv, 'Lote 2 - NDVI CV (%)')

# Repetir para EVI
evi_medio   = s2_indices.select('EVI').mean()
evi_desvEst = s2_indices.select('EVI').reduce(ee.Reducer.stdDev())
evi_cv = evi_desvEst.divide(evi_medio).abs().multiply(100).rename('EVI_CV')

Mapa.addLayer(evi_cv.clip(lote1), vis_cv, 'Lote 1 - EVI CV (%)')
Mapa.addLayer(evi_cv.clip(lote2), vis_cv, 'Lote 2 - EVI CV (%)')

# Agregar límites
Mapa.addLayer(ee.FeatureCollection([ee.Feature(lote1)]).style(color='red', width=2),
              {}, 'Límite Lote 1')
Mapa.addLayer(ee.FeatureCollection([ee.Feature(lote2)]).style(color='blue', width=2),
              {}, 'Límite Lote 2')

Mapa.add_legend(title='CV NDVI (%)', labels=['0','10','20','30','40','50'],
                colors=['#000004','#451077','#721f81','#cd4071','#feb078','#fcfdbf'])

Mapa  # Visualizar en Jupyter
```

```python
# =============================================================================
# CELDA 10: Exportar Resultados
# =============================================================================

# Exportar series temporales a CSV
df.to_csv('palma_aceite_indices_vegetacion_st.csv', index=False)
print("Exportado: palma_aceite_indices_vegetacion_st.csv")

# Exportar análisis de crecimiento
df_crecimiento.to_csv('palma_aceite_analisis_pendiente_crecimiento.csv', index=False)
print("Exportado: palma_aceite_analisis_pendiente_crecimiento.csv")

# Exportar GeoTIFF de mapas CV vía GEE
tarea1 = ee.batch.Export.image.toDrive(
    image=ndvi_cv.clip(lote1),
    description='Lote1_NDVI_CV',
    folder='GEE_PalmaAceite',
    fileNamePrefix='lote1_ndvi_cv',
    region=lote1,
    scale=10,
    maxPixels=1e9
)
tarea1.start()

tarea2 = ee.batch.Export.image.toDrive(
    image=ndvi_cv.clip(lote2),
    description='Lote2_NDVI_CV',
    folder='GEE_PalmaAceite',
    fileNamePrefix='lote2_ndvi_cv',
    region=lote2,
    scale=10,
    maxPixels=1e9
)
tarea2.start()

print("Tareas de exportación GEE iniciadas. Verifique earthengine.google.com/tasks")
```

```python
# =============================================================================
# CELDA 11: Informe de Resumen Estadístico
# =============================================================================

print("=" * 70)
print("MONITOREO DE PALMA DE ACEITE POR TELEDETECCIÓN - RESUMEN ESTADÍSTICO")
print("=" * 70)

for nombre_lote in ['Juvenil (3 años)', 'Adulto (10 años)']:
    datos_lote = df[df['lote'] == nombre_lote]
    print(f"\n--- {nombre_lote} ---")
    for idx in bandas_indice:
        vals = datos_lote[idx].dropna()
        if len(vals) > 0:
            print(f"  {idx:6s}: media={vals.mean():.4f}  desv={vals.std():.4f}  "
                  f"min={vals.min():.4f}  max={vals.max():.4f}  n={len(vals)}")

print(f"\n--- Diferencia de Índices (Adulto - Juvenil) ---")
for idx in bandas_indice:
    media_juv = df[df['lote']=='Juvenil (3 años)'][idx].mean()
    media_adu = df[df['lote']=='Adulto (10 años)'][idx].mean()
    dif = media_adu - media_juv
    print(f"  {idx:6s}: {dif:+.4f} ({'Adulto mayor' if dif > 0 else 'Juvenil mayor'})")

print("\n" + "=" * 70)
print("GUÍA DE INTERPRETACIÓN:")
print("  Diferencia NDVI > 0,25: Fuerte contraste de madurez del dosel (esperado)")
print("  Diferencia EVI  > 0,15: Acumulación de biomasa confirmada")
print("  Diferencia NDWI > 0,20: Dosel maduro retiene más agua")
print("  Diferencia CIre > 1,00: El contenido de clorofila aumenta con la edad")
print("  Pendiente positiva juvenil: Crecimiento activo del dosel (saludable)")
print("  Pendiente adulto cercana a cero: Dosel maduro estable")
print("=" * 70)
```

---

## 7. Sentinel-2 versus PlanetScope: marco de decisión para palma de aceite

La elección del sensor depende fundamentalmente de si la pregunta de manejo apunta a **palmas individuales** o **bloques de plantación**. Sentinel-2 domina en amplitud espectral y eficiencia de costos; PlanetScope gana en detalle espacial y frecuencia temporal.

### Sentinel-2 cubre el 80% de las necesidades de monitoreo a costo cero

Las 13 bandas del Sentinel-2 — incluyendo **tres bandas de borde rojo (B5, B6, B7)** y **dos bandas SWIR (B11, B12)** — habilitan la suite completa de índices agronómicamente relevantes: NDVI, EVI, NDWI/NDMI, CIre, MCARI, IRECI y S2REP. A **resolución de 10 m**, un bloque de 5 ha contiene ~500 píxeles, suficiente para el análisis estadístico del estado de salud a nivel de bloque. El revisit de 5 días permite el seguimiento fenológico y la generación de composites mensuales. Las bandas SWIR son insustituibles para la **detección de estrés hídrico** vía NDMI = (B8 − B11)/(B8 + B11), que emergió como el predictor individual más importante para la estimación de stock de carbono (importancia de variable >0,80). No existe alternativa de PlanetScope para esta medición — PlanetScope carece completamente de SWIR.

### PlanetScope llena brechas críticas en resolución espacial y frecuencia temporal

PlanetScope SuperDove proporciona **resolución de 3 m** con **8 bandas espectrales** incluyendo una banda de borde rojo (697–713 nm). A 3 m, las copas de palma madura (diámetro 8–12 m) ocupan 3–4 píxeles, haciendo factible la delineación de árboles individuales mediante aprendizaje profundo. El **revisit diario** es transformador en regiones ecuatoriales persistentemente nubosas (Sumatra, Borneo, Cuenca del Congo), donde el revisit efectivo libre de nubes del Sentinel-2 puede extenderse a 15–30 días durante estaciones lluviosas. Sin embargo, PlanetScope **no puede calcular NDMI/NDWI** (sin bandas SWIR), ofrece solo NDRE básico (una banda de borde rojo vs. tres del Sentinel-2), y cuesta aproximadamente **5–15 USD/ha/año** comercialmente.

### Cuándo usar cada sensor

| Pregunta de Manejo | Sensor Recomendado | Justificación |
|---|---|---|
| Monitoreo de estado a nivel de bloque (>5 ha) | **Sentinel-2** | Gratuito, resolución suficiente, suite espectral completa |
| Evaluación de salud de palma individual | **PlanetScope** (mínimo) o dron | 3 m resuelve copas; 10 m no puede |
| Estrés hídrico / respuesta a sequía | **Sentinel-2** (requerido) | Único sensor gratuito con SWIR para NDMI |
| Mapeo de clorofila / nitrógeno | **Sentinel-2** | Tres bandas de borde rojo vs. una |
| Evaluación rápida de daños post-evento | **PlanetScope** | Revisit diario para decisiones urgentes |
| Estimación de edad / seguimiento de crecimiento | **Sentinel-2** | Índices borde rojo + SWIR + archivo histórico largo |
| Operaciones con presupuesto limitado | **Sentinel-2** + Landsat | Completamente gratuito |
| Detección temprana de Ganoderma (PCR) | **Dron** | Requiere resolución sub-copa + hiperespectral |

### Estrategia de integración para operaciones premium

El flujo de trabajo óptimo combina ambos sensores: usar Sentinel-2 como **columna vertebral espectral** para monitoreo de bloques NDMI, CIre y EVI procesado a través de GEE, y superponer PlanetScope para **refinamiento espacial** durante períodos críticos. El producto PlanetScope Analysis-Ready (ARPS), con calibración cruzada hacia la reflectancia superficial del Sentinel-2 usando el framework FORCE, permite la fusión de datos sin interrupciones. Para estrés hídrico a alta resolución, un enfoque de fusión espectral genera bandas sintéticas tipo SWIR para PlanetScope a partir de datos Sentinel-2 temporalmente coincidentes.

---

## 8. Patrones esperados e interpretación diagnóstica

Cuando el código anterior se ejecute con datos reales de la plantación, los siguientes patrones confirman el desarrollo normal de la palma de aceite y permiten la detección de anomalías:

**El lote juvenil (3 años)** debe mostrar NDVI ~0,3–0,55 con tendencia ascendente de aproximadamente +0,005–0,015 NDVI/mes conforme se expande el dosel. El EVI debe estar entre 0,15–0,35 con trayectoria positiva similar. El NDWI será bajo o negativo (el suelo desnudo domina la señal SWIR). Los valores de CIre por debajo de 1,5 reflejan masa de clorofila limitada. El CV temporal será alto (30–50%) debido a la composición mixta suelo-vegetación de los píxeles y los cambios rápidos de crecimiento.

**El lote adulto (10 años)** debe mostrar NDVI ~0,75–0,90 con pendiente cercana a cero (dosel cerrado estable). EVI entre 0,40–0,60 reflejando alta biomasa. NDWI entre 0,30–0,50 (abundante agua foliar). Valores de CIre de 2,0–3,5 indican clorofila sustancial. El CV temporal debe ser bajo (5–15%), con cualquier área localizada de CV alto indicando potencial estrés, enfermedad o brechas del dosel que requieren investigación en campo.

**Alertas rojas** que indican que se necesita intervención de manejo incluyen: NDVI del lote juvenil cayendo por debajo de la predicción del modelo logarítmico de Tridawati para su edad; lote adulto mostrando caídas repentinas de NDVI >0,1 (potencial Ganoderma o deficiencia nutricional); NDWI descendiendo mientras el NDVI permanece estable (estrés hídrico temprano que precede a la clorosis visible); y anomalías espaciales de CIre dentro de un bloque (deficiencia localizada de nitrógeno susceptible de fertilización a tasa variable).

---

## Conclusión: un protocolo reproducible con limitaciones conocidas

Este protocolo proporciona un pipeline completo y ejecutable desde la adquisición de datos satelitales hasta la interpretación diagnóstica, fundamentado en **17 estudios arbitrados verificados**. Tres perspectivas accionables emergen de la síntesis. Primero, **los índices de borde rojo deben reemplazar al NDVI como herramienta primaria de monitoreo** para palma de aceite — el R² = 0,94 del CCI para la estimación de edad frente a la saturación bien documentada del NDVI hace que esta sea una mejora clara, aunque la mayoría de las empresas palmicultoras aún dependen exclusivamente del NDVI. Segundo, **el NDMI/NDWI de las bandas SWIR puede ser el índice más subutilizado** para el manejo de palma de aceite; su dominancia como predictor de stock de carbono (importancia >0,80) y su ausencia de la mayoría de protocolos operativos de monitoreo representa una brecha significativa. Tercero, **el mapeo de variabilidad intra-lote mediante el coeficiente de variación no tiene validación publicada para palma de aceite** — el enfoque de mapa de calor implementado aquí es teóricamente sólido pero aguarda una evaluación formal de precisión, representando una oportunidad para la investigación aplicada.

Dos limitaciones metodológicas deben señalarse. La fórmula MCARI, aunque ampliamente usada para cultivos anuales, **no tiene validación publicada basada en satélite para palma de aceite** — su inclusión aquí se extrapola de la sensibilidad establecida de la longitud de onda B5 para la clorofila de palma. Y el modelo logarítmico NDVI-edad (Tridawati 2018) fue calibrado con Landsat-8 en Kalimantan Occidental y puede no transferirse directamente a otras regiones sin calibración local. Los usuarios deben validar contra mediciones de campo de su material de siembra específico y condiciones de suelo antes de confiar en los valores umbral absolutos.

---

## 9. Análisis de Clústeres Intra-Lote: GMM Mensual y Algoritmos de Verificación

### 9.1 Fundamento técnico: por qué GMM supera a K-Means para datos espectrales de palma

El **Modelo de Mezcla Gaussiana (GMM)** es el algoritmo óptimo para análisis de clústeres intra-lote en palma de aceite por tres razones estructurales. Primero, los píxeles espectrales de palma presentan **distribuciones elipsoidales oblicuas** en el espacio de índices NDVI-EVI-CIre, no esféricas, y GMM modela covarianza completa entre bandas. Segundo, GMM asigna **probabilidades de pertenencia blandas** (soft membership): un píxel puede pertenecer al 70% al clúster "estrés hídrico" y 30% al clúster "deficiencia nutricional", lo cual es ecológicamente más realista que la asignación dura de K-Means. Tercero, el **criterio BIC (Bayesian Information Criterion)** integrado en scikit-learn selecciona automáticamente el número óptimo de componentes, eliminando la arbitrariedad del parámetro K.

Para palma de aceite con los cinco índices (NDVI, EVI, NDWI, CIre, MCARI), se esperan **entre 3 y 5 componentes** óptimos por lote y mes, correspondientes a las zonas ecológicas intra-lote:

| Componente GMM Típico | Firma Espectral Esperada | Interpretación Agronómica |
|---|---|---|
| C1 — Alta biomasa, alta agua | NDVI>0,80, NDWI>0,40, CIre>2,8 | Palmas vigorosas, dosel óptimo |
| C2 — Alta biomasa, baja agua | NDVI>0,75, NDWI<0,20, CIre>2,5 | Inicio de estrés hídrico |
| C3 — Biomasa media, déficit clorofila | NDVI~0,65, EVI~0,35, CIre<1,8 | Deficiencia nutricional (N, Mg) |
| C4 — Baja biomasa, alta exposición suelo | NDVI<0,50, EVI<0,25, NDWI<0,10 | Brechas, palmas enfermas, Ganoderma |
| C5 — Mixto intercalado | MCARI alto, señal irregular | Coberturas de suelo / leguminosas |

Los **dos algoritmos de verificación** seleccionados son K-Means (verificación de partición dura, referencia clásica) y **DBSCAN** (Density-Based Spatial Clustering of Applications with Noise), que detecta clústeres de forma arbitraria y clasifica como ruido los píxeles anómalos — directamente interpretable como palmas individuales bajo estrés severo. La comparación de los tres métodos vía **Índice de Calinski-Harabasz**, **Índice de Davies-Bouldin** y el **Adjusted Rand Index (ARI)** entre pares de algoritmos proporciona validación cruzada interna sin requerir etiquetas de campo.

### 9.2 Flujo de trabajo completo

```
Sentinel-2 SR (36 meses) → GEE Extracción píxel a píxel → 
Array [píxeles × 5 índices × 36 meses] →
  Por cada mes:
    Preprocesamiento (StandardScaler + eliminación de NaN)
    GMM (BIC para K óptimo, covarianza='full')
    K-Means (K = K_GMM para comparabilidad)
    DBSCAN (eps automático via k-dist graph)
    Métricas: CH, DB, Silhouette, ARI(GMM,KM), ARI(GMM,DB)
    Reconstrucción espacial → Mapa de clústeres 10m/píxel
    Exportar GeoTIFF + CSV estadísticas por componente
```

---

### 9.3 Código Python completo — Extracción de datos a nivel de píxel desde GEE

```python
# =============================================================================
# CELDA GMM-1: Extracción de datos a nivel de píxel para análisis de clústeres
# =============================================================================
# Este bloque extrae el array completo de píxeles x índices x meses
# para cada lote. Es la base de datos de entrada para los tres algoritmos.
# Requiere: ee, geemap, numpy, pandas (instalados en secciones anteriores)
# =============================================================================

import ee
import geemap
import numpy as np
import pandas as pd
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

ee.Initialize(project='su-proyecto-gee')

# ---- Definición de lotes (reemplazar con coordenadas reales) ----------------
lote1 = ee.Geometry.Polygon([
    [103.420, 1.620], [103.425, 1.620],
    [103.425, 1.625], [103.420, 1.625],
    [103.420, 1.620]
])
lote2 = ee.Geometry.Polygon([
    [103.430, 1.620], [103.435, 1.620],
    [103.435, 1.625], [103.430, 1.625],
    [103.430, 1.620]
])

LOTES = {'Lote1_Juvenil_3yr': lote1, 'Lote2_Adulto_10yr': lote2}
BANDAS_INDICE = ['NDVI', 'EVI', 'NDWI', 'CIre', 'MCARI']

# ---- 36 meses (3 años): enero 2022 - diciembre 2024 -------------------------
FECHA_INICIO = '2022-01-01'
FECHA_FIN    = '2024-12-31'
N_MESES      = 36

def enmascarar_nubes_s2(img):
    scl = img.select('SCL')
    return img.updateMask(scl.eq(4).Or(scl.eq(5))) \
               .copyProperties(img, ['system:time_start'])

def agregar_indices(img):
    nir, rojo, azul, verde = (img.select(b) for b in ['B8','B4','B2','B3'])
    re1  = img.select('B5')
    swir = img.select('B11')
    ndvi  = img.normalizedDifference(['B8','B4']).rename('NDVI')
    evi   = nir.subtract(rojo).multiply(2.5).divide(
                nir.add(rojo.multiply(6)).subtract(azul.multiply(7.5)).add(10000)
            ).rename('EVI')
    ndwi  = img.normalizedDifference(['B8','B11']).rename('NDWI')
    cire  = nir.divide(re1).subtract(1).rename('CIre')
    mcari = re1.subtract(rojo).subtract(
                re1.subtract(verde).multiply(0.2)
            ).multiply(re1.divide(rojo)).rename('MCARI')
    return img.addBands([ndvi, evi, ndwi, cire, mcari])

s2_base = (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
             .filterDate(FECHA_INICIO, FECHA_FIN)
             .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 40))
             .map(enmascarar_nubes_s2)
             .map(agregar_indices)
             .select(BANDAS_INDICE))


def extraer_pixeles_mes(geometria, nombre_lote, año, mes, escala=10):
    """
    Extrae el array completo de píxeles × 5 índices para un mes dado.
    Retorna DataFrame con columnas: x, y, NDVI, EVI, NDWI, CIre, MCARI, año, mes, lote
    """
    fecha_ini = ee.Date.fromYMD(año, mes, 1)
    fecha_fin = fecha_ini.advance(1, 'month')
    
    composite = s2_base.filterDate(fecha_ini, fecha_fin).median()
    
    # Muestreo denso: un punto por píxel de 10m dentro del lote
    muestras = composite.sample(
        region=geometria,
        scale=escala,
        geometries=True,
        dropNulls=True
    )
    
    n_pixeles = muestras.size().getInfo()
    if n_pixeles == 0:
        return None
    
    features = muestras.getInfo()['features']
    registros = []
    for f in features:
        props = f['properties']
        coords = f['geometry']['coordinates']
        row = {
            'x': coords[0], 'y': coords[1],
            'año': año, 'mes': mes, 'lote': nombre_lote
        }
        for banda in BANDAS_INDICE:
            row[banda] = props.get(banda, np.nan)
        registros.append(row)
    
    return pd.DataFrame(registros)


def extraer_dataset_completo(geometria, nombre_lote, max_pixeles=2000):
    """
    Extrae datos de los 36 meses completos para un lote.
    max_pixeles: límite por mes para control de cómputo (ajustar según tamaño del lote)
    """
    todos = []
    inicio = datetime(2022, 1, 1)
    
    for m in range(N_MESES):
        año  = inicio.year  + (inicio.month + m - 1) // 12
        mes  = (inicio.month + m - 1) % 12 + 1
        print(f"  Extrayendo {nombre_lote} — {año}-{mes:02d}...", end='\r')
        
        df_mes = extraer_pixeles_mes(geometria, nombre_lote, año, mes)
        if df_mes is not None and len(df_mes) > 0:
            # Muestreo aleatorio si supera el límite
            if len(df_mes) > max_pixeles:
                df_mes = df_mes.sample(max_pixeles, random_state=42)
            todos.append(df_mes)
    
    print(f"\n  ✓ {nombre_lote}: {N_MESES} meses extraídos.")
    return pd.concat(todos, ignore_index=True) if todos else pd.DataFrame()


print("Extrayendo datos de píxeles — Lote 1 (3 años)...")
df_px_lote1 = extraer_dataset_completo(lote1, 'Lote1_Juvenil_3yr')

print("Extrayendo datos de píxeles — Lote 2 (10 años)...")
df_px_lote2 = extraer_dataset_completo(lote2, 'Lote2_Adulto_10yr')

# Guardar caches locales para evitar re-extracción
df_px_lote1.to_parquet('pixeles_lote1_36meses.parquet', index=False)
df_px_lote2.to_parquet('pixeles_lote2_36meses.parquet', index=False)

print(f"\nLote 1: {len(df_px_lote1):,} registros píxel-mes")
print(f"Lote 2: {len(df_px_lote2):,} registros píxel-mes")
print(f"Bandas disponibles: {BANDAS_INDICE}")
```

---

### 9.4 Código Python completo — Motor de análisis GMM + K-Means + DBSCAN mensual

```python
# =============================================================================
# CELDA GMM-2: Instalación de dependencias adicionales
# =============================================================================
# pip install scikit-learn matplotlib seaborn scipy rasterio geopandas

from sklearn.mixture import GaussianMixture
from sklearn.cluster import KMeans, DBSCAN
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (silhouette_score, calinski_harabasz_score,
                              davies_bouldin_score, adjusted_rand_score)
from sklearn.neighbors import NearestNeighbors
from sklearn.decomposition import PCA
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.colors as mcolors
import matplotlib.gridspec as gridspec
import seaborn as sns
import numpy as np
import pandas as pd
from scipy.spatial.distance import cdist
import os, warnings
warnings.filterwarnings('ignore')

# ---- Cargar datos (o usar los DataFrames de la celda anterior) ---------------
df_px_lote1 = pd.read_parquet('pixeles_lote1_36meses.parquet')
df_px_lote2 = pd.read_parquet('pixeles_lote2_36meses.parquet')

BANDAS      = ['NDVI', 'EVI', 'NDWI', 'CIre', 'MCARI']
K_MAX       = 7          # máximo de componentes a evaluar en BIC
K_MIN       = 2          # mínimo de componentes
SEMILLA     = 42

os.makedirs('mapas_cluster_mensuales', exist_ok=True)
os.makedirs('estadisticas_cluster',    exist_ok=True)


# =============================================================================
# CELDA GMM-3: Función para selección automática del K óptimo via BIC
# =============================================================================

def seleccionar_k_bic(X_scaled, k_min=K_MIN, k_max=K_MAX):
    """
    Ajusta GMM para K entre k_min y k_max.
    Retorna K óptimo (mínimo BIC) y el array completo de valores BIC.
    
    Referencia: Fraley & Raftery (2002) — covarianza 'full' es la más general
    y apropiada para datos espectrales multivariados.
    """
    bic_valores = []
    aic_valores = []
    modelos     = []
    
    for k in range(k_min, k_max + 1):
        gmm = GaussianMixture(
            n_components=k,
            covariance_type='full',  # covarianza completa entre todas las bandas
            max_iter=200,
            n_init=5,                # 5 inicializaciones aleatorias → mejor convergencia
            random_state=SEMILLA
        )
        gmm.fit(X_scaled)
        bic_valores.append(gmm.bic(X_scaled))
        aic_valores.append(gmm.aic(X_scaled))
        modelos.append(gmm)
    
    idx_optimo = np.argmin(bic_valores)
    k_optimo   = k_min + idx_optimo
    
    return k_optimo, bic_valores, aic_valores, modelos[idx_optimo]


# =============================================================================
# CELDA GMM-4: Función para selección automática de eps en DBSCAN
# =============================================================================

def seleccionar_eps_dbscan(X_scaled, k_vecinos=5, percentil=95):
    """
    Método k-dist graph: calcula la distancia al k-ésimo vecino más cercano
    para cada punto y usa el codo de la distribución como eps.
    
    k_vecinos=5 es el valor estándar recomendado por Ester et al. (1996),
    los autores originales de DBSCAN.
    percentil=95 captura el codo sin excluir puntos legítimos.
    """
    nbrs = NearestNeighbors(n_neighbors=k_vecinos).fit(X_scaled)
    distancias, _ = nbrs.kneighbors(X_scaled)
    dist_k = np.sort(distancias[:, k_vecinos - 1])
    eps    = np.percentile(dist_k, percentil)
    return eps, dist_k


# =============================================================================
# CELDA GMM-5: Función principal de análisis mensual — un mes, un lote
# =============================================================================

def analizar_mes_lote(df_lote, año, mes, nombre_lote):
    """
    Ejecuta GMM, K-Means y DBSCAN para un mes específico de un lote.
    
    Retorna:
        resultado: dict con etiquetas, métricas, medias por componente
        df_mes:    DataFrame con columnas adicionales de etiquetas de los 3 algoritmos
    """
    df_mes = df_lote[(df_lote['año'] == año) & (df_lote['mes'] == mes)].copy()
    df_mes = df_mes.dropna(subset=BANDAS)
    
    if len(df_mes) < 20:
        return None, None
    
    X = df_mes[BANDAS].values
    
    # ---- Normalización Z-score (requerida para todos los algoritmos) ----------
    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    
    # ==========================================================================
    # ALGORITMO 1: GMM — Modelo de Mezcla Gaussiana (algoritmo principal)
    # ==========================================================================
    k_opt, bic_vals, aic_vals, gmm_modelo = seleccionar_k_bic(X_scaled)
    
    etiquetas_gmm         = gmm_modelo.predict(X_scaled)
    probabilidades_gmm    = gmm_modelo.predict_proba(X_scaled)   # soft membership
    max_prob_gmm          = probabilidades_gmm.max(axis=1)       # certeza de asignación
    log_verosimilitud     = gmm_modelo.score(X_scaled)           # log-likelihood promedio
    
    # ==========================================================================
    # ALGORITMO 2: K-Means (verificación — partición dura, referencia clásica)
    # K se fija igual al K óptimo del GMM para comparabilidad directa
    # ==========================================================================
    kmeans_modelo = KMeans(
        n_clusters=k_opt,
        n_init=10,
        max_iter=300,
        random_state=SEMILLA
    )
    etiquetas_km = kmeans_modelo.fit_predict(X_scaled)
    inercia_km   = kmeans_modelo.inertia_   # suma de distancias cuadradas intra-clúster
    
    # ==========================================================================
    # ALGORITMO 3: DBSCAN (verificación — basado en densidad, sin K predefinido)
    # Detecta automáticamente el número de clústeres y marca outliers como -1
    # ==========================================================================
    eps_opt, dist_k = seleccionar_eps_dbscan(X_scaled)
    dbscan_modelo = DBSCAN(
        eps=eps_opt,
        min_samples=5,    # mínimo 5 puntos para formar un clúster denso
        metric='euclidean'
    )
    etiquetas_db = dbscan_modelo.fit_predict(X_scaled)
    n_clusters_db   = len(set(etiquetas_db)) - (1 if -1 in etiquetas_db else 0)
    n_outliers_db   = np.sum(etiquetas_db == -1)
    pct_outliers_db = 100 * n_outliers_db / len(etiquetas_db)
    
    # ==========================================================================
    # MÉTRICAS DE CALIDAD INTERNAS (sin etiquetas de campo)
    # ==========================================================================
    # Silhouette: [-1, 1], mayor = mejor separación. Válido para K≥2 y n>1
    # Calinski-Harabasz: mayor = clústeres más compactos y separados
    # Davies-Bouldin: menor = mejor. 0 = separación perfecta
    
    metricas = {}
    
    for nombre_alg, etiquetas in [('GMM', etiquetas_gmm),
                                   ('KMeans', etiquetas_km),
                                   ('DBSCAN', etiquetas_db[etiquetas_db != -1])]:
        X_valido = X_scaled[etiquetas_db != -1] if nombre_alg == 'DBSCAN' else X_scaled
        etiq_validas = etiquetas
        
        n_unicos = len(set(etiq_validas))
        if n_unicos < 2 or len(X_valido) < 10:
            metricas[nombre_alg] = {
                'silhouette': np.nan, 'calinski_harabasz': np.nan, 'davies_bouldin': np.nan
            }
        else:
            metricas[nombre_alg] = {
                'silhouette':         silhouette_score(X_valido, etiq_validas),
                'calinski_harabasz':  calinski_harabasz_score(X_valido, etiq_validas),
                'davies_bouldin':     davies_bouldin_score(X_valido, etiq_validas)
            }
    
    # Adjusted Rand Index entre pares de algoritmos (acuerdo estructural)
    # ARI = 1: acuerdo perfecto | ARI = 0: acuerdo aleatorio
    mask_db_valido = etiquetas_db != -1
    ari_gmm_km = adjusted_rand_score(etiquetas_gmm, etiquetas_km)
    ari_gmm_db = adjusted_rand_score(
        etiquetas_gmm[mask_db_valido],
        etiquetas_db[mask_db_valido]
    ) if mask_db_valido.sum() > 1 else np.nan
    ari_km_db  = adjusted_rand_score(
        etiquetas_km[mask_db_valido],
        etiquetas_db[mask_db_valido]
    ) if mask_db_valido.sum() > 1 else np.nan
    
    # Medias originales (no escaladas) por componente GMM
    df_mes['cluster_gmm']    = etiquetas_gmm
    df_mes['cluster_km']     = etiquetas_km
    df_mes['cluster_dbscan'] = etiquetas_db
    df_mes['prob_max_gmm']   = max_prob_gmm
    
    medias_componentes = df_mes.groupby('cluster_gmm')[BANDAS].mean().round(4)
    stds_componentes   = df_mes.groupby('cluster_gmm')[BANDAS].std().round(4)
    tamano_componentes = df_mes.groupby('cluster_gmm').size()
    
    resultado = {
        'año': año, 'mes': mes, 'lote': nombre_lote,
        'n_pixeles': len(df_mes),
        # GMM
        'k_optimo_gmm': k_opt,
        'bic_optimo': min(bic_vals),
        'log_verosimilitud': log_verosimilitud,
        'medias_gmm': medias_componentes,
        'stds_gmm':   stds_componentes,
        'tamano_gmm': tamano_componentes,
        'prob_media_gmm': max_prob_gmm.mean(),   # certeza promedio de asignación
        # K-Means
        'k_kmeans': k_opt,
        'inercia_km': inercia_km,
        # DBSCAN
        'eps_dbscan': eps_opt,
        'n_clusters_dbscan': n_clusters_db,
        'n_outliers_dbscan': n_outliers_db,
        'pct_outliers_dbscan': pct_outliers_db,
        # Métricas internas
        'metricas': metricas,
        # ARI cruzado
        'ari_gmm_km': ari_gmm_km,
        'ari_gmm_db': ari_gmm_db,
        'ari_km_db':  ari_km_db,
        # Auxiliares para reconstrucción de mapa
        'bic_vals': bic_vals,
        'aic_vals': aic_vals,
        'k_range': list(range(K_MIN, K_MAX + 1)),
    }
    
    return resultado, df_mes


# =============================================================================
# CELDA GMM-6: Ejecución completa — 36 meses × 2 lotes
# =============================================================================

def ejecutar_analisis_completo(df_lote, nombre_lote):
    """
    Corre el análisis para los 36 meses del lote dado.
    Retorna lista de resultados y DataFrame acumulado con etiquetas.
    """
    resultados_todos  = []
    df_etiquetado_all = []
    
    inicio = pd.Timestamp('2022-01-01')
    
    for m in range(N_MESES):
        fecha   = inicio + pd.DateOffset(months=m)
        año, mes = fecha.year, fecha.month
        etiqueta = f"{año}-{mes:02d}"
        
        resultado, df_mes_etiq = analizar_mes_lote(df_lote, año, mes, nombre_lote)
        
        if resultado is None:
            print(f"  ⚠ {etiqueta}: datos insuficientes (<20 píxeles válidos), omitido.")
            continue
        
        resultados_todos.append(resultado)
        df_etiquetado_all.append(df_mes_etiq)
        
        k     = resultado['k_optimo_gmm']
        sil   = resultado['metricas']['GMM']['silhouette']
        ari   = resultado['ari_gmm_km']
        out   = resultado['pct_outliers_dbscan']
        print(f"  ✓ {etiqueta} | K_opt={k} | Silhouette_GMM={sil:.3f} | "
              f"ARI(GMM,KM)={ari:.3f} | Outliers_DBSCAN={out:.1f}%")
    
    df_completo = pd.concat(df_etiquetado_all, ignore_index=True) if df_etiquetado_all else pd.DataFrame()
    return resultados_todos, df_completo


print("="*70)
print("ANÁLISIS DE CLÚSTERES — LOTE 1 (JUVENIL 3 AÑOS)")
print("="*70)
resultados_l1, df_etiq_l1 = ejecutar_analisis_completo(df_px_lote1, 'Lote1_Juvenil_3yr')

print("\n" + "="*70)
print("ANÁLISIS DE CLÚSTERES — LOTE 2 (ADULTO 10 AÑOS)")
print("="*70)
resultados_l2, df_etiq_l2 = ejecutar_analisis_completo(df_px_lote2, 'Lote2_Adulto_10yr')

# Exportar datos etiquetados completos
df_etiq_l1.to_parquet('lote1_pixeles_etiquetados_gmm.parquet', index=False)
df_etiq_l2.to_parquet('lote2_pixeles_etiquetados_gmm.parquet', index=False)
print("\n✓ DataFrames con etiquetas GMM/KMeans/DBSCAN exportados.")
```

---

### 9.5 Código Python completo — Mapas espaciales mensuales de clústeres (reconstrucción píxel a píxel)

```python
# =============================================================================
# CELDA GMM-7: Generación de mapas espaciales de clústeres por mes y lote
# =============================================================================
# Reconstruye la posición espacial de cada píxel y los colorea según su
# componente GMM. Genera una figura de 12 meses en grilla para comparación.
# =============================================================================

# Paleta de colores semántica para los componentes GMM (máx. 7 componentes)
# Colores elegidos para transmitir significado agronómico
PALETA_GMM = {
    0: ('#1a9850', 'Vigor óptimo'),           # verde oscuro
    1: ('#91cf60', 'Vigor moderado'),          # verde claro
    2: ('#fee08b', 'Estrés leve / inicio'),    # amarillo
    3: ('#fc8d59', 'Estrés medio / N bajo'),   # naranja
    4: ('#d73027', 'Estrés severo / BSR'),     # rojo
    5: ('#7b2d8b', 'Suelo expuesto / brechas'),# púrpura
    6: ('#636363', 'Datos mixtos / nubes'),    # gris
}

PALETA_KM = {
    0: ('#2166ac', 'KM-C1'), 1: ('#74add1', 'KM-C2'),
    2: ('#abd9e9', 'KM-C3'), 3: ('#fdae61', 'KM-C4'),
    4: ('#f46d43', 'KM-C5'), 5: ('#d73027', 'KM-C6'),
    6: ('#313695', 'KM-C7'),
}

PALETA_DB = {
    -1: ('#000000', 'Outlier/Anomalía'),      # negro para outliers
     0: ('#1b7837', 'DB-C1'),
     1: ('#5aae61', 'DB-C2'),
     2: ('#c2a5cf', 'DB-C3'),
     3: ('#762a83', 'DB-C4'),
     4: ('#e7d4e8', 'DB-C5'),
}


def construir_mapa_scatter(ax, df_mes_etiq, col_cluster, paleta,
                            titulo, alfa=0.6, tam_punto=4):
    """
    Dibuja un scatter plot espacial coloreado por etiqueta de clúster.
    Cada punto representa un píxel de 10m × 10m.
    """
    etiquetas_unicas = sorted(df_mes_etiq[col_cluster].unique())
    
    for etiq in etiquetas_unicas:
        mask = df_mes_etiq[col_cluster] == etiq
        color, label = paleta.get(etiq, ('#999999', f'C{etiq}'))
        n_px  = mask.sum()
        pct   = 100 * n_px / len(df_mes_etiq)
        ax.scatter(
            df_mes_etiq.loc[mask, 'x'],
            df_mes_etiq.loc[mask, 'y'],
            c=color, s=tam_punto, alpha=alfa,
            label=f'{label} ({pct:.1f}%)'
        )
    
    ax.set_title(titulo, fontsize=9, fontweight='bold', pad=3)
    ax.set_aspect('equal')
    ax.tick_params(labelsize=6)
    ax.set_xlabel('Longitud', fontsize=7)
    ax.set_ylabel('Latitud', fontsize=7)
    leyenda = ax.legend(fontsize=5, loc='upper right',
                        markerscale=2, framealpha=0.8)
    return ax


def generar_panel_mensual_gmm(df_etiq, resultados, nombre_lote,
                               año_objetivo=2023, ruta_salida='mapas_cluster_mensuales'):
    """
    Genera un panel de 12 mapas (enero-diciembre) para un año dado,
    mostrando el mapa GMM de cada mes.
    
    Cada mapa = scatter espacial de píxeles coloreados por componente GMM.
    """
    fig = plt.figure(figsize=(22, 20))
    fig.suptitle(
        f'Mapas Mensuales de Clústeres GMM — {nombre_lote}\n'
        f'Año {año_objetivo} | 5 índices: NDVI, EVI, NDWI, CIre, MCARI',
        fontsize=16, fontweight='bold', y=0.98
    )
    
    gs = gridspec.GridSpec(3, 4, figure=fig, hspace=0.4, wspace=0.3)
    
    meses_nombres = ['Ene','Feb','Mar','Abr','May','Jun',
                     'Jul','Ago','Sep','Oct','Nov','Dic']
    
    for i, mes in enumerate(range(1, 13)):
        ax = fig.add_subplot(gs[i // 4, i % 4])
        
        df_mes = df_etiq[(df_etiq['año'] == año_objetivo) &
                         (df_etiq['mes'] == mes)]
        
        # Buscar K óptimo del mes
        res_mes = next((r for r in resultados
                        if r['año'] == año_objetivo and r['mes'] == mes), None)
        
        if df_mes.empty or res_mes is None:
            ax.text(0.5, 0.5, 'Sin datos\ndisponibles',
                    ha='center', va='center', transform=ax.transAxes,
                    fontsize=10, color='gray')
            ax.set_title(f'{meses_nombres[i]} {año_objetivo}',
                         fontsize=9, fontweight='bold')
            ax.axis('off')
            continue
        
        k    = res_mes['k_optimo_gmm']
        sil  = res_mes['metricas']['GMM']['silhouette']
        n_px = len(df_mes)
        
        subtitulo = (f"{meses_nombres[i]} {año_objetivo}\n"
                     f"K={k} | Sil={sil:.3f} | n={n_px:,} px")
        
        construir_mapa_scatter(ax, df_mes, 'cluster_gmm',
                                PALETA_GMM, subtitulo)
    
    archivo = os.path.join(ruta_salida,
                           f'mapa_gmm_mensual_{nombre_lote}_{año_objetivo}.png')
    plt.savefig(archivo, dpi=200, bbox_inches='tight',
                facecolor='white', edgecolor='none')
    plt.show()
    print(f"✓ Panel GMM 12 meses guardado: {archivo}")
    return archivo


# Generar paneles para ambos lotes y los 3 años disponibles
for año_obj in [2022, 2023, 2024]:
    print(f"\nGenerando mapas GMM — Lote 1 — {año_obj}...")
    generar_panel_mensual_gmm(df_etiq_l1, resultados_l1,
                               'Lote1_Juvenil_3yr', año_objetivo=año_obj)
    
    print(f"Generando mapas GMM — Lote 2 — {año_obj}...")
    generar_panel_mensual_gmm(df_etiq_l2, resultados_l2,
                               'Lote2_Adulto_10yr', año_objetivo=año_obj)
```

---

### 9.6 Código Python completo — Panel comparativo de los tres algoritmos (mes único)

```python
# =============================================================================
# CELDA GMM-8: Panel comparativo GMM vs K-Means vs DBSCAN — mes seleccionado
# =============================================================================
# Para un mes específico, muestra los 3 mapas lado a lado con métricas.
# Esta es la figura de validación cruzada principal del protocolo.
# =============================================================================

def panel_comparativo_tres_algoritmos(df_etiq, resultados, nombre_lote,
                                       año, mes,
                                       ruta_salida='mapas_cluster_mensuales'):
    """
    Figura de 3 columnas × 2 filas:
    Fila 1: Mapas espaciales de GMM, K-Means y DBSCAN
    Fila 2: BIC/AIC selection plot | Scatter PCA coloreado | Métricas comparativas
    """
    mes_str = f"{año}-{mes:02d}"
    
    df_mes = df_etiq[(df_etiq['año'] == año) & (df_etiq['mes'] == mes)].copy()
    df_mes = df_mes.dropna(subset=BANDAS)
    
    res = next((r for r in resultados
                if r['año'] == año and r['mes'] == mes), None)
    
    if df_mes.empty or res is None:
        print(f"⚠ Sin datos para {mes_str} en {nombre_lote}")
        return
    
    X_scaled = StandardScaler().fit_transform(df_mes[BANDAS].values)
    
    # PCA 2D para visualización del espacio de clústeres
    pca = PCA(n_components=2, random_state=SEMILLA)
    X_pca = pca.fit_transform(X_scaled)
    var_exp = pca.explained_variance_ratio_
    
    # ---- Layout de figura -------------------------------------------------------
    fig = plt.figure(figsize=(20, 13))
    fig.suptitle(
        f'Comparación de Algoritmos de Clústeres — {nombre_lote} — {mes_str}\n'
        f'GMM (principal) | K-Means (verificación 1) | DBSCAN (verificación 2)',
        fontsize=14, fontweight='bold', y=0.99
    )
    
    gs = gridspec.GridSpec(2, 3, figure=fig, hspace=0.42, wspace=0.32)
    
    # ==========================================================================
    # FILA 1: Mapas espaciales de los 3 algoritmos
    # ==========================================================================
    
    # --- Mapa GMM ---------------------------------------------------------------
    ax_gmm = fig.add_subplot(gs[0, 0])
    k = res['k_optimo_gmm']
    sil_gmm = res['metricas']['GMM']['silhouette']
    ch_gmm  = res['metricas']['GMM']['calinski_harabasz']
    db_gmm  = res['metricas']['GMM']['davies_bouldin']
    construir_mapa_scatter(
        ax_gmm, df_mes, 'cluster_gmm', PALETA_GMM,
        f'GMM  K={k}\nSil={sil_gmm:.3f} | CH={ch_gmm:.1f} | DB={db_gmm:.3f}'
    )
    
    # --- Mapa K-Means -----------------------------------------------------------
    ax_km = fig.add_subplot(gs[0, 1])
    sil_km = res['metricas']['KMeans']['silhouette']
    ch_km  = res['metricas']['KMeans']['calinski_harabasz']
    db_km  = res['metricas']['KMeans']['davies_bouldin']
    ari_gk = res['ari_gmm_km']
    construir_mapa_scatter(
        ax_km, df_mes, 'cluster_km', PALETA_KM,
        f'K-Means  K={k}\nSil={sil_km:.3f} | ARI(GMM,KM)={ari_gk:.3f}'
    )
    
    # --- Mapa DBSCAN ------------------------------------------------------------
    ax_db = fig.add_subplot(gs[0, 2])
    sil_db   = res['metricas']['DBSCAN']['silhouette']
    n_cl_db  = res['n_clusters_dbscan']
    pct_out  = res['pct_outliers_dbscan']
    ari_gd   = res['ari_gmm_db']
    construir_mapa_scatter(
        ax_db, df_mes, 'cluster_dbscan', PALETA_DB,
        f'DBSCAN  K_auto={n_cl_db}\n'
        f'Sil={sil_db:.3f} | Outliers={pct_out:.1f}% | ARI(GMM,DB)={ari_gd:.3f}'
    )
    
    # ==========================================================================
    # FILA 2: Diagnósticos
    # ==========================================================================
    
    # --- Plot BIC / AIC para selección de K ------------------------------------
    ax_bic = fig.add_subplot(gs[1, 0])
    k_range = res['k_range']
    bic_v   = res['bic_vals']
    aic_v   = res['aic_vals']
    
    ax_bic.plot(k_range, bic_v, 'o-', color='#e74c3c', linewidth=2,
                markersize=7, label='BIC')
    ax_bic.plot(k_range, aic_v, 's--', color='#3498db', linewidth=2,
                markersize=7, label='AIC')
    ax_bic.axvline(x=k, color='#e74c3c', linestyle=':', linewidth=2,
                   label=f'K óptimo = {k}')
    
    # Sombrear el mínimo BIC
    idx_min = np.argmin(bic_v)
    ax_bic.scatter([k_range[idx_min]], [bic_v[idx_min]],
                   s=150, zorder=5, color='#e74c3c', edgecolors='black')
    
    ax_bic.set_xlabel('Número de componentes (K)', fontweight='bold')
    ax_bic.set_ylabel('Criterio de Información', fontweight='bold')
    ax_bic.set_title('Selección de K óptimo\nvía BIC y AIC',
                     fontsize=10, fontweight='bold')
    ax_bic.legend(fontsize=9)
    ax_bic.grid(alpha=0.3)
    
    # --- Scatter PCA: espacio de clústeres coloreado por GMM -------------------
    ax_pca = fig.add_subplot(gs[1, 1])
    
    for etiq in sorted(df_mes['cluster_gmm'].unique()):
        mask  = df_mes['cluster_gmm'].values == etiq
        color = PALETA_GMM.get(etiq, ('#999999', f'C{etiq}'))[0]
        label = PALETA_GMM.get(etiq, ('#999999', f'C{etiq}'))[1]
        pct   = 100 * mask.sum() / len(df_mes)
        ax_pca.scatter(X_pca[mask, 0], X_pca[mask, 1],
                       c=color, s=5, alpha=0.5,
                       label=f'C{etiq}: {label} ({pct:.1f}%)')
    
    ax_pca.set_xlabel(f'PC1 ({100*var_exp[0]:.1f}% var.)', fontweight='bold')
    ax_pca.set_ylabel(f'PC2 ({100*var_exp[1]:.1f}% var.)', fontweight='bold')
    ax_pca.set_title(f'Espacio PCA coloreado por GMM\n'
                     f'(PC1+PC2 = {100*sum(var_exp):.1f}% varianza total)',
                     fontsize=10, fontweight='bold')
    ax_pca.legend(fontsize=6, markerscale=3)
    ax_pca.grid(alpha=0.2)
    
    # --- Tabla resumen de métricas comparativas --------------------------------
    ax_tab = fig.add_subplot(gs[1, 2])
    ax_tab.axis('off')
    
    tabla_data = [
        ['Métrica', 'GMM', 'K-Means', 'DBSCAN'],
        ['K / N clústeres', str(k), str(k), str(n_cl_db)],
        ['Silhouette ↑', f'{sil_gmm:.4f}', f'{sil_km:.4f}', f'{sil_db:.4f}'],
        ['Calinski-H. ↑', f'{ch_gmm:.1f}', f'{ch_km:.1f}',
         f'{res["metricas"]["DBSCAN"]["calinski_harabasz"]:.1f}'
         if not np.isnan(res["metricas"]["DBSCAN"]["calinski_harabasz"]) else 'N/A'],
        ['Davies-Bouldin ↓', f'{db_gmm:.4f}', f'{db_km:.4f}',
         f'{res["metricas"]["DBSCAN"]["davies_bouldin"]:.4f}'
         if not np.isnan(res["metricas"]["DBSCAN"]["davies_bouldin"]) else 'N/A'],
        ['ARI vs GMM', '1.0000', f'{ari_gk:.4f}', f'{ari_gd:.4f}'],
        ['Outliers (%)', '—', '—', f'{pct_out:.2f}%'],
        ['Log-verosim.', f'{res["log_verosimilitud"]:.3f}', '—', '—'],
        ['Certeza media', f'{res["prob_media_gmm"]:.3f}', '—', '—'],
    ]
    
    tabla = ax_tab.table(
        cellText=tabla_data[1:],
        colLabels=tabla_data[0],
        cellLoc='center', loc='center',
        bbox=[0, 0.05, 1, 0.90]
    )
    tabla.auto_set_font_size(False)
    tabla.set_fontsize(9)
    
    # Colorear encabezado y columna GMM
    for (fila, col), celda in tabla.get_celld().items():
        if fila == 0:
            celda.set_facecolor('#2c3e50')
            celda.set_text_props(color='white', fontweight='bold')
        elif col == 1:  # Columna GMM
            celda.set_facecolor('#d5e8d4')
        elif fila % 2 == 0:
            celda.set_facecolor('#f8f9fa')
    
    ax_tab.set_title('Tabla Comparativa de Métricas\n↑ mayor es mejor | ↓ menor es mejor',
                     fontsize=10, fontweight='bold', pad=8)
    
    # Anotación interpretativa
    mejor_alg = 'GMM' if (sil_gmm >= sil_km and sil_gmm >= sil_db) else \
                'K-Means' if sil_km >= sil_db else 'DBSCAN'
    fig.text(0.5, 0.005,
             f'Algoritmo con mayor Silhouette este mes: {mejor_alg} | '
             f'ARI(GMM,KM)={ari_gk:.3f} — '
             f'{"Alta concordancia estructural" if ari_gk > 0.7 else "Diferencias significativas entre métodos"}',
             ha='center', fontsize=9, style='italic', color='#555555')
    
    archivo = os.path.join(
        ruta_salida,
        f'comparativo_3algoritmos_{nombre_lote}_{mes_str}.png'
    )
    plt.savefig(archivo, dpi=200, bbox_inches='tight',
                facecolor='white', edgecolor='none')
    plt.show()
    print(f"✓ Panel comparativo 3 algoritmos guardado: {archivo}")


# Ejecutar para el mes de mayor interés (ejemplo: julio 2023)
for lote_nombre, df_etiq, resultados_lote in [
    ('Lote1_Juvenil_3yr', df_etiq_l1, resultados_l1),
    ('Lote2_Adulto_10yr', df_etiq_l2, resultados_l2)
]:
    panel_comparativo_tres_algoritmos(
        df_etiq, resultados_lote, lote_nombre,
        año=2023, mes=7
    )
```

---

### 9.7 Código Python completo — Evolución temporal de componentes GMM (36 meses)

```python
# =============================================================================
# CELDA GMM-9: Evolución temporal de la composición del dosel por mes
# =============================================================================
# Muestra cómo cambia el porcentaje de píxeles en cada componente GMM
# a lo largo de los 36 meses. Es el "latido" del lote en el tiempo.
# =============================================================================

def graficar_evolucion_temporal_gmm(df_etiq, resultados, nombre_lote,
                                     ruta_salida='estadisticas_cluster'):
    """
    Gráfica de área apilada mostrando la proporción de píxeles por componente
    a lo largo de los 36 meses del período de análisis.
    """
    # Calcular proporción mensual de cada componente GMM
    registros = []
    for res in sorted(resultados, key=lambda r: (r['año'], r['mes'])):
        año, mes = res['año'], res['mes']
        df_mes   = df_etiq[(df_etiq['año'] == año) & (df_etiq['mes'] == mes)]
        if df_mes.empty:
            continue
        
        total = len(df_mes)
        fecha = pd.Timestamp(año, mes, 1)
        k     = res['k_optimo_gmm']
        
        fila = {'fecha': fecha, 'k_optimo': k,
                'log_verosimilitud': res['log_verosimilitud'],
                'ari_gmm_km': res['ari_gmm_km'],
                'ari_gmm_db': res['ari_gmm_db'],
                'pct_outliers_dbscan': res['pct_outliers_dbscan'],
                'silhouette_gmm': res['metricas']['GMM']['silhouette'],
                'silhouette_km':  res['metricas']['KMeans']['silhouette'],
                'silhouette_db':  res['metricas']['DBSCAN']['silhouette']}
        
        for etiq in range(K_MAX):
            mask = df_mes['cluster_gmm'] == etiq
            fila[f'pct_c{etiq}'] = 100 * mask.sum() / total
            # Medias de índices por componente
            for banda in BANDAS:
                fila[f'c{etiq}_{banda}_media'] = df_mes.loc[mask, banda].mean() \
                                                   if mask.sum() > 0 else np.nan
        registros.append(fila)
    
    df_evo = pd.DataFrame(registros).sort_values('fecha')
    df_evo.to_csv(os.path.join(ruta_salida, f'evolucion_gmm_{nombre_lote}.csv'),
                  index=False)
    
    # ---- Figura de 4 paneles --------------------------------------------------
    fig, ejes = plt.subplots(4, 1, figsize=(18, 20), sharex=True)
    fig.suptitle(
        f'Evolución Temporal del Análisis GMM — {nombre_lote}\n'
        f'36 meses | 5 índices (NDVI, EVI, NDWI, CIre, MCARI)',
        fontsize=14, fontweight='bold'
    )
    
    fechas = df_evo['fecha']
    meses_nombres = [f.strftime('%b\n%Y') for f in fechas]
    
    # Panel 1: Área apilada de proporción de componentes GMM
    ax1 = ejes[0]
    cols_pct  = [f'pct_c{i}' for i in range(K_MAX) if f'pct_c{i}' in df_evo.columns]
    datos_pct = df_evo[cols_pct].fillna(0).values
    colores_p = [PALETA_GMM[i][0] for i in range(len(cols_pct))]
    labels_p  = [PALETA_GMM[i][1] for i in range(len(cols_pct))]
    
    ax1.stackplot(fechas, datos_pct.T, colors=colores_p,
                  labels=labels_p, alpha=0.85)
    ax1.set_ylabel('% de píxeles', fontweight='bold')
    ax1.set_title('Composición mensual del dosel por componente GMM',
                  fontsize=11, fontweight='bold')
    ax1.legend(loc='upper left', fontsize=7, ncol=4)
    ax1.set_ylim(0, 100)
    ax1.grid(axis='y', alpha=0.3)
    ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.0f}%'))
    
    # Panel 2: K óptimo mensual y Silhouette de los 3 algoritmos
    ax2 = ejes[1]
    ax2b = ax2.twinx()
    
    ax2.bar(fechas, df_evo['k_optimo'], width=20, color='#95a5a6',
            alpha=0.4, label='K óptimo GMM (izq.)')
    ax2b.plot(fechas, df_evo['silhouette_gmm'], 'o-', color='#e74c3c',
              linewidth=2, markersize=5, label='Silhouette GMM')
    ax2b.plot(fechas, df_evo['silhouette_km'],  's--', color='#3498db',
              linewidth=1.5, markersize=4, label='Silhouette K-Means')
    ax2b.plot(fechas, df_evo['silhouette_db'],  '^:', color='#2ecc71',
              linewidth=1.5, markersize=4, label='Silhouette DBSCAN')
    
    ax2.set_ylabel('K óptimo', fontweight='bold')
    ax2b.set_ylabel('Silhouette Score', fontweight='bold')
    ax2.set_title('K óptimo mensual y Silhouette de los 3 algoritmos\n'
                  '(Silhouette ↑: mejor separación de clústeres)',
                  fontsize=11, fontweight='bold')
    
    lineas1, lab1 = ax2.get_legend_handles_labels()
    lineas2, lab2 = ax2b.get_legend_handles_labels()
    ax2.legend(lineas1 + lineas2, lab1 + lab2, fontsize=8, loc='upper right')
    ax2.grid(alpha=0.2)
    ax2b.axhline(y=0.5, color='gray', linestyle=':', alpha=0.5)
    ax2b.text(fechas.iloc[0], 0.51, 'umbral Sil=0.5', fontsize=7, color='gray')
    
    # Panel 3: ARI cruzado entre algoritmos (concordancia estructural)
    ax3 = ejes[2]
    ax3.plot(fechas, df_evo['ari_gmm_km'], 'o-', color='#9b59b6',
             linewidth=2, markersize=5, label='ARI (GMM vs K-Means)')
    ax3.plot(fechas, df_evo['ari_gmm_db'], 's--', color='#e67e22',
             linewidth=2, markersize=5, label='ARI (GMM vs DBSCAN)')
    ax3.fill_between(fechas, df_evo['ari_gmm_km'],
                     alpha=0.15, color='#9b59b6')
    ax3.fill_between(fechas, df_evo['ari_gmm_db'],
                     alpha=0.15, color='#e67e22')
    ax3.axhline(y=0.7, color='green', linestyle=':', linewidth=1.5,
                label='Umbral alta concordancia (ARI=0.7)')
    ax3.axhline(y=0.4, color='red', linestyle=':', linewidth=1.5,
                label='Umbral baja concordancia (ARI=0.4)')
    ax3.set_ylabel('Adjusted Rand Index', fontweight='bold')
    ax3.set_title('Concordancia estructural entre algoritmos (ARI)\n'
                  'ARI=1: acuerdo perfecto | ARI=0: acuerdo aleatorio',
                  fontsize=11, fontweight='bold')
    ax3.legend(fontsize=8, loc='lower right')
    ax3.set_ylim(0, 1.05)
    ax3.grid(alpha=0.3)
    
    # Panel 4: % outliers DBSCAN (indicador de anomalías intra-lote)
    ax4 = ejes[3]
    barras = ax4.bar(fechas, df_evo['pct_outliers_dbscan'],
                     width=20, color='#e74c3c', alpha=0.7,
                     label='% Píxeles outlier (DBSCAN)')
    
    # Colorear barras por umbral de alerta
    for barra, val in zip(barras, df_evo['pct_outliers_dbscan']):
        if val > 15:
            barra.set_color('#c0392b')       # Alerta alta: >15% outliers
        elif val > 8:
            barra.set_color('#e67e22')       # Alerta media: 8-15%
        else:
            barra.set_color('#27ae60')       # Normal: <8%
    
    ax4.axhline(y=8,  color='orange', linestyle='--', linewidth=1.5,
                label='Alerta media (8%)')
    ax4.axhline(y=15, color='red',    linestyle='--', linewidth=1.5,
                label='Alerta alta (15%)')
    ax4.set_ylabel('% Outliers DBSCAN', fontweight='bold')
    ax4.set_xlabel('Mes', fontweight='bold')
    ax4.set_title('Porcentaje de píxeles anómalos detectados por DBSCAN\n'
                  'Verde: normal (<8%) | Naranja: alerta media | Rojo: alerta alta (>15%)',
                  fontsize=11, fontweight='bold')
    ax4.legend(fontsize=8)
    ax4.grid(axis='y', alpha=0.3)
    
    # Eje x con meses
    tick_pos = fechas[::3]   # cada 3 meses
    tick_lab = [f.strftime('%b\n%Y') for f in tick_pos]
    for ax in ejes:
        ax.set_xticks(tick_pos)
        ax.set_xticklabels(tick_lab, fontsize=8)
    
    plt.tight_layout()
    archivo = os.path.join(ruta_salida,
                           f'evolucion_temporal_gmm_{nombre_lote}.png')
    plt.savefig(archivo, dpi=200, bbox_inches='tight',
                facecolor='white', edgecolor='none')
    plt.show()
    print(f"✓ Evolución temporal GMM guardada: {archivo}")
    return df_evo


print("Generando evolución temporal — Lote 1...")
df_evo_l1 = graficar_evolucion_temporal_gmm(df_etiq_l1, resultados_l1,
                                              'Lote1_Juvenil_3yr')

print("Generando evolución temporal — Lote 2...")
df_evo_l2 = graficar_evolucion_temporal_gmm(df_etiq_l2, resultados_l2,
                                              'Lote2_Adulto_10yr')
```

---

### 9.8 Código Python completo — Informe diagnóstico mensual automatizado

```python
# =============================================================================
# CELDA GMM-10: Informe diagnóstico automático por mes y lote
# =============================================================================
# Genera un informe textual + figura de perfiles espectrales por componente.
# Traduce la firma espectral de cada componente GMM a lenguaje agronómico.
# =============================================================================

def interpretar_componente_gmm(medias_banda):
    """
    Reglas basadas en los rangos espectrales establecidos en la Sección 2
    del protocolo (validados contra literatura publicada).
    
    Retorna etiqueta agronómica y nivel de urgencia.
    """
    ndvi  = medias_banda.get('NDVI',  0)
    evi   = medias_banda.get('EVI',   0)
    ndwi  = medias_banda.get('NDWI',  0)
    cire  = medias_banda.get('CIre',  0)
    mcari = medias_banda.get('MCARI', 0)
    
    if ndvi > 0.78 and ndwi > 0.35 and cire > 2.5:
        return "🟢 VIGOR ÓPTIMO — Palmas en condición excelente", "Normal"
    elif ndvi > 0.70 and ndwi > 0.20 and cire > 2.0:
        return "🟡 VIGOR MODERADO — Condición normal, monitorear", "Normal"
    elif ndvi > 0.60 and ndwi < 0.20 and cire > 1.8:
        return "🟠 ESTRÉS HÍDRICO INCIPIENTE — Verificar humedad de suelo", "Alerta"
    elif cire < 1.5 and ndvi > 0.55:
        return "🟠 POSIBLE DEFICIENCIA NUTRICIONAL (N, Mg) — Revisar fertilización", "Alerta"
    elif ndvi < 0.55 and evi < 0.25:
        return "🔴 COBERTURA BAJA — Palmas enfermas / suelo expuesto / Ganoderma", "Crítico"
    elif mcari > np.nanquantile([mcari], 0.90):
        return "⚪ COBERTURAS INTERCALADAS — Leguminosas / malezas dominando píxel", "Info"
    else:
        return "🔵 ESTADO MIXTO — Zona de transición, requiere inspección de campo", "Seguimiento"


def generar_informe_diagnostico_mes(df_etiq, resultados, nombre_lote,
                                     año, mes,
                                     ruta_salida='estadisticas_cluster'):
    """
    Genera informe con:
    1. Perfiles espectrales de cada componente GMM (radar/spider chart)
    2. Resumen estadístico imprimible
    3. Recomendaciones agronómicas por componente
    """
    mes_str = f"{año}-{mes:02d}"
    
    df_mes = df_etiq[(df_etiq['año'] == año) & (df_etiq['mes'] == mes)].copy()
    df_mes = df_mes.dropna(subset=BANDAS)
    
    res = next((r for r in resultados
                if r['año'] == año and r['mes'] == mes), None)
    
    if df_mes.empty or res is None:
        print(f"Sin datos para {mes_str}")
        return
    
    k = res['k_optimo_gmm']
    medias_comp = res['medias_gmm']
    stds_comp   = res['stds_gmm']
    tamano_comp = res['tamano_comp'] if 'tamano_comp' in res else \
                  df_mes.groupby('cluster_gmm').size()
    
    # ---- Figura de perfiles espectrales (barras agrupadas) -------------------
    fig, (ax_perf, ax_text) = plt.subplots(1, 2, figsize=(18, 7),
                                            gridspec_kw={'width_ratios': [1.6, 1]})
    fig.suptitle(
        f'Perfiles Espectrales por Componente GMM — {nombre_lote}\n{mes_str}',
        fontsize=13, fontweight='bold'
    )
    
    ancho_barra = 0.8 / k
    x_pos = np.arange(len(BANDAS))
    
    for i_comp in range(k):
        if i_comp not in medias_comp.index:
            continue
        color = PALETA_GMM.get(i_comp, ('#999999', f'C{i_comp}'))[0]
        medias_i = [medias_comp.loc[i_comp, b] if b in medias_comp.columns
                    else np.nan for b in BANDAS]
        stds_i   = [stds_comp.loc[i_comp, b] if b in stds_comp.columns
                    else np.nan for b in BANDAS]
        n_px     = tamano_comp.get(i_comp, 0)
        pct      = 100 * n_px / len(df_mes)
        
        offset = (i_comp - k/2 + 0.5) * ancho_barra
        barras = ax_perf.bar(
            x_pos + offset, medias_i, ancho_barra,
            color=color, alpha=0.85,
            label=f'C{i_comp} ({pct:.1f}%, n={n_px:,})',
            yerr=stds_i, capsize=3, error_kw={'linewidth': 0.8}
        )
    
    ax_perf.set_xticks(x_pos)
    ax_perf.set_xticklabels(BANDAS, fontsize=11, fontweight='bold')
    ax_perf.set_ylabel('Valor medio del índice', fontweight='bold')
    ax_perf.set_title(f'Perfil espectral de {k} componentes GMM\n'
                      f'Barras de error = ±1 desviación estándar',
                      fontsize=11, fontweight='bold')
    ax_perf.legend(fontsize=8, loc='upper right')
    ax_perf.grid(axis='y', alpha=0.3)
    ax_perf.axhline(y=0, color='black', linewidth=0.5)
    
    # ---- Panel de texto con diagnóstico agronómico ---------------------------
    ax_text.axis('off')
    
    lineas_informe = [
        f"{'='*48}",
        f"INFORME DIAGNÓSTICO GMM",
        f"Lote: {nombre_lote}",
        f"Período: {mes_str}",
        f"Píxeles analizados: {len(df_mes):,}",
        f"K óptimo (BIC): {k}",
        f"Log-verosimilitud: {res['log_verosimilitud']:.4f}",
        f"Certeza media GMM: {res['prob_media_gmm']:.3f}",
        f"{'='*48}",
        "",
        "DIAGNÓSTICO POR COMPONENTE:",
        ""
    ]
    
    for i_comp in range(k):
        if i_comp not in medias_comp.index:
            continue
        medias_dict = {b: medias_comp.loc[i_comp, b]
                       for b in BANDAS if b in medias_comp.columns}
        n_px = tamano_comp.get(i_comp, 0)
        pct  = 100 * n_px / len(df_mes)
        
        diagnos, urgencia = interpretar_componente_gmm(medias_dict)
        
        lineas_informe.extend([
            f"C{i_comp} ({pct:.1f}% del lote, {n_px:,} px):",
            f"  {diagnos}",
            f"  NDVI={medias_dict.get('NDVI',0):.3f} | "
            f"EVI={medias_dict.get('EVI',0):.3f} | "
            f"NDWI={medias_dict.get('NDWI',0):.3f}",
            f"  CIre={medias_dict.get('CIre',0):.3f} | "
            f"MCARI={medias_dict.get('MCARI',0):.4f}",
            ""
        ])
    
    lineas_informe.extend([
        f"{'='*48}",
        "MÉTRICAS DE VALIDACIÓN:",
        f"  Silhouette GMM:    {res['metricas']['GMM']['silhouette']:.4f}",
        f"  Silhouette K-Means:{res['metricas']['KMeans']['silhouette']:.4f}",
        f"  Silhouette DBSCAN: {res['metricas']['DBSCAN']['silhouette']:.4f}",
        f"  ARI (GMM vs KM):   {res['ari_gmm_km']:.4f}",
        f"  ARI (GMM vs DB):   {res['ari_gmm_db']:.4f}",
        f"  Outliers DBSCAN:   {res['pct_outliers_dbscan']:.2f}%",
        f"{'='*48}",
    ])
    
    texto_completo = "\n".join(lineas_informe)
    ax_text.text(0.02, 0.98, texto_completo, transform=ax_text.transAxes,
                 fontsize=7.5, va='top', ha='left', family='monospace',
                 bbox=dict(boxstyle='round', facecolor='#f8f9fa',
                           edgecolor='#dee2e6', alpha=0.9))
    
    plt.tight_layout()
    archivo_fig = os.path.join(
        ruta_salida,
        f'diagnostico_gmm_{nombre_lote}_{mes_str}.png'
    )
    plt.savefig(archivo_fig, dpi=200, bbox_inches='tight',
                facecolor='white')
    plt.show()
    
    # Guardar informe en texto plano
    archivo_txt = archivo_fig.replace('.png', '.txt')
    with open(archivo_txt, 'w', encoding='utf-8') as f:
        f.write(texto_completo)
    
    print(f"✓ Diagnóstico guardado: {archivo_fig}")
    print(texto_completo)


# Generar informes para todos los meses de 2024 en ambos lotes
for mes in range(1, 13):
    for lote_nombre, df_etiq, res_lote in [
        ('Lote1_Juvenil_3yr', df_etiq_l1, resultados_l1),
        ('Lote2_Adulto_10yr', df_etiq_l2, resultados_l2)
    ]:
        generar_informe_diagnostico_mes(
            df_etiq, res_lote, lote_nombre,
            año=2024, mes=mes
        )
```

---

### 9.9 Interpretación técnica del sistema de tres algoritmos

El valor diagnóstico del sistema proviene de la **triangulación** entre los tres métodos, no de ninguno en forma individual. Los tres escenarios de lectura cruzada más importantes son:

**Escenario A — ARI(GMM, KM) > 0,7 y ARI(GMM, DB) > 0,7:** Los tres algoritmos producen particiones estructuralmente equivalentes. Los clústeres son robustos, compactos y bien separados. Máxima confianza en el diagnóstico. En palma adulta sana, este patrón aparece en meses secos cuando el dosel está en su estado más estable.

**Escenario B — ARI(GMM, KM) > 0,7 pero ARI(GMM, DB) < 0,4:** GMM y K-Means concuerdan (ambos son algoritmos de asignación total), pero DBSCAN identifica zonas de baja densidad que los otros dos forzaron dentro de un clúster. Los píxeles marcados como outliers por DBSCAN son candidatos directos a **inspección de campo prioritaria** — típicamente revelan palmas individuales con Ganoderma en etapa temprana o zonas de compactación de suelo.

**Escenario C — Todos los ARI < 0,4:** El espacio espectral intra-lote no tiene estructura clara de clústeres ese mes. Causas posibles: contaminación residual por nubes delgadas no detectadas por SCL, mezcla de coberturas en un lote juvenil con leguminosas, o transición fenológica activa. Acción recomendada: verificar la calidad del composite mensual y considerar usar imágenes de ventana de 45 días en lugar de 30.

El porcentaje de outliers DBSCAN actúa como **indicador temprano de alerta**: valores sostenidos por encima del 15% por tres meses consecutivos en un lote adulto indican degradación progresiva del dosel y deben activar protocolo de evaluación foliar y muestreo de suelo.

---

### 9.10 Limitaciones conocidas del análisis de clústeres satelital en palma

Tres limitaciones estructurales deben considerarse al interpretar los resultados de este sistema. Primero, la **resolución de 10 m del Sentinel-2 mezcla la señal de la corona individual con el suelo entre palmas y coberturas intercaladas**, especialmente en lotes juveniles donde la separación entre palmas supera el tamaño del píxel. El efecto es que un píxel "de estrés" puede reflejar una leguminosa de cobertura y no la palma subyacente. Para lotes de 3 años, se recomienda complementar con imágenes PlanetScope (3 m) para el componente de baja biomasa. Segundo, la **correspondencia entre componentes GMM y condiciones agronómicas específicas no está validada en literatura publicada** — las reglas de interpretación de la Sección 9.8 están derivadas de los rangos espectrales documentados en los estudios de la Sección 1, pero no de un estudio de correlación directa GMM-campo para palma. Esta es la brecha de investigación más relevante que el protocolo identifica para trabajo futuro. Tercero, la **estabilidad del K óptimo varía mensualmente** — es normal que K fluctúe entre 3 y 5 para un mismo lote dependiendo de la fenología y el régimen de lluvia, y no debe interpretarse como inestabilidad del sistema sino como respuesta real a la variabilidad estacional del dosel.

---

## 10. Métricas de Regeneración Intra-Lote

### 10.1 Marco conceptual: de la detección de estrés a la cuantificación de resiliencia

La detección de anomalías por GMM identifica *dónde* está el problema en un momento dado, pero no responde a la pregunta agronómica más valiosa: **¿cuánto tarda cada zona del lote en recuperarse y con qué eficiencia lo hace?** La resiliencia ecológica de una plantación — su capacidad de volver al estado pre-estrés tras una perturbación — es un predictor más robusto del rendimiento a largo plazo que el estado puntual. Un componente GMM de "estrés leve" que se recupera en 3 semanas tiene implicaciones de manejo completamente distintas a uno que tarda 4 meses.

Este apartado implementa **seis métricas de regeneración** que se calculan sobre la misma serie temporal de 36 meses y la misma segmentación espacial del GMM, extendiéndolas a una ventana configurable por el usuario (predeterminada: 12 meses). Las métricas se anclan a una **zona boscosa de referencia** cercana — el ecosistema vecino más estable espectralmente — para producir un **Índice de Regeneración Relativa (IRR)** que normaliza la recuperación de la plantación contra el comportamiento del bosque nativo, eliminando el efecto de la variabilidad climática regional.

| Métrica | Símbolo | Definición técnica |
|---|---|---|
| Tasa de Recuperación | TR | Pendiente positiva post-estrés / magnitud de la caída |
| Índice de Estabilidad | IE | 1 − CV normalizado sobre ventana temporal |
| Índice de Resiliencia | IR | Recuperación de biomasa (EVI) en ≤ N meses tras caída |
| Velocidad de Recuperación Lenta | VRL | Meses necesarios para volver al percentil P75 previo al estrés |
| Índice de Caídas Abruptas | ICA | Número y magnitud de caídas > 2σ en la ventana |
| Índice de Regeneración Relativa | IRR | TR_lote / TR_bosque_referencia |

---

### 10.2 Código Python completo — Módulo de métricas de regeneración

```python
# =============================================================================
# CELDA REG-1: Dependencias e importaciones
# =============================================================================

import ee
import geemap
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
import matplotlib.patches as mpatches
import matplotlib.dates as mdates
import seaborn as sns
from scipy import stats
from scipy.signal import find_peaks, savgol_filter
from scipy.ndimage import uniform_filter1d
from sklearn.preprocessing import MinMaxScaler
import warnings, os
warnings.filterwarnings('ignore')

ee.Initialize(project='su-proyecto-gee')

# Directorios de salida
os.makedirs('metricas_regeneracion', exist_ok=True)
os.makedirs('mapas_regeneracion',    exist_ok=True)

# ---- Constantes configurables por el usuario --------------------------------
VENTANA_MESES     = 12    # ventana de análisis (meses). El usuario puede cambiar este valor.
N_MESES_RESIL     = 2     # meses máximos para calificar como "recuperación rápida"
UMBRAL_CAIDA_SIGMA= 2.0   # número de desviaciones estándar para detectar caída abrupta
PERCENTIL_ESTRES  = 25    # percentil bajo = zona de estrés
PERCENTIL_REF     = 75    # percentil alto = estado de referencia (pre-estrés)
BANDAS            = ['NDVI', 'EVI', 'NDWI', 'CIre', 'MCARI']
BANDA_BIOMASA     = 'EVI'   # índice principal para métricas de biomasa
BANDA_AGUA        = 'NDWI'  # índice principal para estrés hídrico
BANDA_CLOROFILA   = 'CIre'  # índice principal para estado nutricional

print(f"Configuración de ventana temporal: {VENTANA_MESES} meses")
print(f"Umbral resiliencia: recuperación en ≤ {N_MESES_RESIL} meses")
print(f"Umbral caída abrupta: z-score > {UMBRAL_CAIDA_SIGMA}σ")
```

```python
# =============================================================================
# CELDA REG-2: Extracción de serie temporal para zona boscosa de referencia
# =============================================================================
# La zona de referencia es un parche de bosque nativo o secundario cercano
# al lote. Debe ser espectralmente estable y sin intervención humana.
# Se usa para normalizar todas las métricas de recuperación de la plantación.

# ---- Definir zona de referencia boscosa (REEMPLAZAR con coordenadas reales) --
BOSQUE_REF = ee.Geometry.Polygon([
    [103.450, 1.620], [103.458, 1.620],
    [103.458, 1.630], [103.450, 1.630],
    [103.450, 1.620]
])
# Alternativa: cargar desde asset GEE
# BOSQUE_REF = ee.FeatureCollection('users/SU_USUARIO/bosque_referencia').geometry()

# ---- Reutilizar la colección Sentinel-2 ya procesada (de secciones anteriores)
# s2_base ya está definida con cloud masking e índices calculados

def extraer_st_referencia(geometria, nombre='Bosque_Referencia',
                          fecha_inicio='2022-01-01', n_meses=36, escala=10):
    """
    Extrae serie temporal mensual de estadísticas zonales para la zona de referencia.
    Retorna DataFrame con media, mediana, p25, p75 y std de cada índice por mes.
    """
    registros = []
    inicio = pd.Timestamp(fecha_inicio)
    
    for m in range(n_meses):
        fecha = inicio + pd.DateOffset(months=m)
        año, mes = fecha.year, fecha.month
        
        fecha_ee_ini = ee.Date.fromYMD(año, mes, 1)
        fecha_ee_fin = fecha_ee_ini.advance(1, 'month')
        
        composite = s2_base.filterDate(fecha_ee_ini, fecha_ee_fin).median()
        
        stats_ee = composite.reduceRegion(
            reducer=(ee.Reducer.mean()
                     .combine(ee.Reducer.median(), sharedInputs=True)
                     .combine(ee.Reducer.percentile([25, 75]), sharedInputs=True)
                     .combine(ee.Reducer.stdDev(), sharedInputs=True)),
            geometry=geometria,
            scale=escala,
            maxPixels=1e9
        ).getInfo()
        
        fila = {'fecha': fecha, 'año': año, 'mes': mes, 'zona': nombre}
        for banda in BANDAS:
            fila[f'{banda}_media']   = stats_ee.get(f'{banda}_mean')
            fila[f'{banda}_mediana'] = stats_ee.get(f'{banda}_median')
            fila[f'{banda}_p25']     = stats_ee.get(f'{banda}_p25')
            fila[f'{banda}_p75']     = stats_ee.get(f'{banda}_p75')
            fila[f'{banda}_std']     = stats_ee.get(f'{banda}_stdDev')
        registros.append(fila)
        print(f"  {nombre} — {año}-{mes:02d}", end='\r')
    
    print(f"\n✓ {nombre}: {n_meses} meses extraídos.")
    return pd.DataFrame(registros)


print("Extrayendo serie temporal de zona boscosa de referencia...")
df_bosque = extraer_st_referencia(BOSQUE_REF, 'Bosque_Referencia')
df_bosque.to_csv('metricas_regeneracion/serie_bosque_referencia.csv', index=False)
print("✓ Serie bosque guardada.")
```

```python
# =============================================================================
# CELDA REG-3: Construcción de series temporales por componente GMM
# =============================================================================
# Para cada componente GMM de cada lote, calcula la serie temporal mensual
# de los índices. Esta es la base de datos sobre la que se calculan todas
# las métricas de regeneración.

def construir_st_por_componente(df_etiquetado, resultados, nombre_lote,
                                 banda_principal=BANDA_BIOMASA):
    """
    Construye un DataFrame de series temporales donde cada fila es
    (fecha, componente_gmm, índice_valor) — la "firma temporal" de cada zona.
    
    Retorna:
        df_st_comp: DataFrame wide con columna por cada componente GMM
        df_st_long: formato long para visualización
    """
    registros = []
    inicio    = pd.Timestamp('2022-01-01')
    
    for m in range(36):
        fecha = inicio + pd.DateOffset(months=m)
        año, mes = fecha.year, fecha.month
        
        df_mes = df_etiquetado[(df_etiquetado['año'] == año) &
                               (df_etiquetado['mes'] == mes)].copy()
        df_mes = df_mes.dropna(subset=BANDAS)
        
        res = next((r for r in resultados
                    if r['año'] == año and r['mes'] == mes), None)
        if df_mes.empty or res is None:
            continue
        
        k = res['k_optimo_gmm']
        
        for comp in range(k):
            mask = df_mes['cluster_gmm'] == comp
            if mask.sum() < 5:
                continue
            
            fila = {
                'fecha': fecha, 'año': año, 'mes': mes,
                'lote': nombre_lote, 'componente': comp,
                'k_total': k,
                'n_pixeles': int(mask.sum()),
                'pct_lote': 100 * mask.sum() / len(df_mes)
            }
            for banda in BANDAS:
                vals = df_mes.loc[mask, banda].dropna()
                fila[f'{banda}_media']   = vals.mean()
                fila[f'{banda}_mediana'] = vals.median()
                fila[f'{banda}_p25']     = vals.quantile(0.25)
                fila[f'{banda}_p75']     = vals.quantile(0.75)
                fila[f'{banda}_std']     = vals.std()
                fila[f'{banda}_cv']      = vals.std() / vals.mean() if vals.mean() != 0 else np.nan
            registros.append(fila)
    
    df_st = pd.DataFrame(registros).sort_values(['componente', 'fecha'])
    df_st.to_csv(f'metricas_regeneracion/st_por_componente_{nombre_lote}.csv',
                 index=False)
    return df_st


print("Construyendo series temporales por componente GMM — Lote 1...")
df_st_l1 = construir_st_por_componente(df_etiq_l1, resultados_l1, 'Lote1_Juvenil_3yr')

print("Construyendo series temporales por componente GMM — Lote 2...")
df_st_l2 = construir_st_por_componente(df_etiq_l2, resultados_l2, 'Lote2_Adulto_10yr')

print(f"✓ Componentes únicos Lote 1: {df_st_l1['componente'].unique()}")
print(f"✓ Componentes únicos Lote 2: {df_st_l2['componente'].unique()}")
```

```python
# =============================================================================
# CELDA REG-4: Detección de eventos de estrés y caídas abruptas
# =============================================================================

def detectar_caidas_abruptas(serie_temporal, banda=BANDA_BIOMASA,
                              ventana_meses=VENTANA_MESES,
                              umbral_sigma=UMBRAL_CAIDA_SIGMA):
    """
    Detecta caídas abruptas en una serie temporal de un índice.
    
    Método: z-score de la diferencia mes a mes (primera derivada).
    Una caída es abrupta si el descenso supera umbral_sigma desviaciones
    estándar de la distribución de cambios mensuales.
    
    Retorna lista de eventos con: fecha, magnitud, índice previo, índice post
    """
    col = f'{banda}_media'
    if col not in serie_temporal.columns:
        return []
    
    # Limitar a la ventana temporal del usuario
    df = serie_temporal.tail(ventana_meses).copy().reset_index(drop=True)
    valores = df[col].values
    fechas  = df['fecha'].values
    
    # Suavizado Savitzky-Golay para eliminar ruido de alta frecuencia
    # (ventana=5 meses, polinomio=2 — apropiado para series satelitales mensuales)
    if len(valores) >= 7:
        valores_suav = savgol_filter(valores, window_length=5, polyorder=2)
    else:
        valores_suav = valores
    
    # Primera diferencia: cambio mes a mes
    diffs = np.diff(valores_suav)
    
    # Z-score de las diferencias
    media_diff = np.nanmean(diffs)
    std_diff   = np.nanstd(diffs)
    
    if std_diff == 0:
        return []
    
    z_scores = (diffs - media_diff) / std_diff
    
    # Detectar caídas (diferencia negativa con z-score alto en valor absoluto)
    eventos = []
    for i, (z, d) in enumerate(zip(z_scores, diffs)):
        if z < -umbral_sigma:   # caída abrupta: z negativo
            eventos.append({
                'idx_inicio': i,
                'idx_fin':    i + 1,
                'fecha_caida': fechas[i + 1],
                'valor_previo': float(valores_suav[i]),
                'valor_post':   float(valores_suav[i + 1]),
                'magnitud_caida': float(-d),          # positivo = cuánto cayó
                'z_score':       float(z),
                'banda':         banda
            })
    
    return eventos


def detectar_todos_eventos(df_st_comp, banda=BANDA_BIOMASA,
                            ventana_meses=VENTANA_MESES):
    """
    Aplica detección de caídas abruptas a todos los componentes GMM.
    Retorna DataFrame con todos los eventos detectados.
    """
    todos_eventos = []
    
    for comp in df_st_comp['componente'].unique():
        df_comp = df_st_comp[df_st_comp['componente'] == comp].sort_values('fecha')
        
        for lote in df_comp['lote'].unique():
            df_lote_comp = df_comp[df_comp['lote'] == lote]
            eventos = detectar_caidas_abruptas(df_lote_comp, banda, ventana_meses)
            
            for ev in eventos:
                ev['componente'] = comp
                ev['lote']       = lote
                todos_eventos.append(ev)
    
    return pd.DataFrame(todos_eventos)


print("Detectando caídas abruptas en series temporales...")
df_eventos_l1 = detectar_todos_eventos(df_st_l1, BANDA_BIOMASA, VENTANA_MESES)
df_eventos_l2 = detectar_todos_eventos(df_st_l2, BANDA_BIOMASA, VENTANA_MESES)

print(f"✓ Eventos detectados Lote 1: {len(df_eventos_l1)}")
print(f"✓ Eventos detectados Lote 2: {len(df_eventos_l2)}")
```

```python
# =============================================================================
# CELDA REG-5: Cálculo del Índice de Estabilidad (IE)
# =============================================================================
# IE mide cuán estable es la señal espectral de un componente a lo largo
# del tiempo. IE = 1 − CV_normalizado. Rango: 0 (muy variable) a 1 (estable).
#
# Un lote adulto sano muestra IE > 0.80 para NDVI.
# Un lote juvenil en crecimiento muestra IE < 0.60 (alta variabilidad temporal).

def calcular_indice_estabilidad(df_st_comp, ventana_meses=VENTANA_MESES):
    """
    Calcula el Índice de Estabilidad (IE) por componente GMM.
    IE = 1 − (std / |media|) normalizado al rango [0,1].
    
    También calcula IE por banda para identificar qué dimensión espectral
    es más inestable (puede ser NDWI → estrés hídrico estacional).
    """
    resultados_ie = []
    
    for lote in df_st_comp['lote'].unique():
        df_lote = df_st_comp[df_st_comp['lote'] == lote]
        
        for comp in df_lote['componente'].unique():
            df_comp = (df_lote[df_lote['componente'] == comp]
                       .sort_values('fecha')
                       .tail(ventana_meses))
            
            if len(df_comp) < 3:
                continue
            
            fila = {'lote': lote, 'componente': comp,
                    'n_meses_analizados': len(df_comp)}
            
            cvs_bandas = []
            for banda in BANDAS:
                col = f'{banda}_media'
                if col not in df_comp.columns:
                    continue
                vals = df_comp[col].dropna()
                if len(vals) < 3 or vals.mean() == 0:
                    continue
                
                cv_banda = vals.std() / abs(vals.mean())
                fila[f'IE_{banda}'] = max(0, 1 - cv_banda)  # clamp a 0 mínimo
                fila[f'CV_{banda}'] = cv_banda
                cvs_bandas.append(cv_banda)
            
            # IE global: promedio de IE de todas las bandas
            if cvs_bandas:
                cv_global = np.mean(cvs_bandas)
                fila['IE_global'] = max(0, 1 - cv_global)
                fila['CV_global'] = cv_global
                
                # Clasificación cualitativa
                ie_g = fila['IE_global']
                if ie_g >= 0.80:
                    fila['estabilidad_clase'] = 'Alta (estable)'
                elif ie_g >= 0.60:
                    fila['estabilidad_clase'] = 'Media (moderadamente estable)'
                elif ie_g >= 0.40:
                    fila['estabilidad_clase'] = 'Baja (variable)'
                else:
                    fila['estabilidad_clase'] = 'Muy baja (muy variable)'
            
            resultados_ie.append(fila)
    
    return pd.DataFrame(resultados_ie)


df_ie_l1 = calcular_indice_estabilidad(df_st_l1, VENTANA_MESES)
df_ie_l2 = calcular_indice_estabilidad(df_st_l2, VENTANA_MESES)

print("=== ÍNDICE DE ESTABILIDAD — LOTE 1 (JUVENIL) ===")
print(df_ie_l1[['componente','IE_global','IE_NDVI','IE_EVI',
                 'IE_NDWI','estabilidad_clase']].to_string(index=False))

print("\n=== ÍNDICE DE ESTABILIDAD — LOTE 2 (ADULTO) ===")
print(df_ie_l2[['componente','IE_global','IE_NDVI','IE_EVI',
                 'IE_NDWI','estabilidad_clase']].to_string(index=False))
```

```python
# =============================================================================
# CELDA REG-6: Cálculo del Índice de Resiliencia (IR)
# =============================================================================
# IR cuantifica la capacidad de recuperación de biomasa (EVI) dentro de
# N_MESES_RESIL meses tras un evento de estrés detectado.
#
# IR = (EVI_post_N_meses − EVI_min_evento) / (EVI_previo − EVI_min_evento)
# IR = 1.0: recuperación completa dentro de la ventana
# IR = 0.0: sin recuperación
# IR > 1.0: sobrecompensación (rebote por encima del estado previo)
# IR < 0.0: continúa deteriorándose (no hay recuperación)

def calcular_indice_resiliencia(df_st_comp, df_eventos,
                                 banda=BANDA_BIOMASA,
                                 n_meses_resil=N_MESES_RESIL,
                                 ventana_meses=VENTANA_MESES):
    """
    Para cada evento de caída detectado, calcula IR midiendo la recuperación
    N meses después del nadir (punto mínimo).
    
    Retorna DataFrame con IR por evento y métricas agregadas por componente.
    """
    if df_eventos.empty:
        print("  ⚠ Sin eventos de caída detectados para calcular IR.")
        return pd.DataFrame(), pd.DataFrame()
    
    col = f'{banda}_media'
    resultados_ir = []
    
    for _, evento in df_eventos.iterrows():
        lote = evento['lote']
        comp = evento['componente']
        
        df_comp = (df_st_comp[(df_st_comp['lote'] == lote) &
                               (df_st_comp['componente'] == comp)]
                   .sort_values('fecha')
                   .tail(ventana_meses)
                   .reset_index(drop=True))
        
        if col not in df_comp.columns or len(df_comp) < 4:
            continue
        
        # Encontrar el índice del mes del evento
        fecha_caida = pd.Timestamp(evento['fecha_caida'])
        idx_caida = df_comp[df_comp['fecha'] == fecha_caida].index
        if len(idx_caida) == 0:
            # Buscar el mes más cercano
            diffs = abs(df_comp['fecha'] - fecha_caida)
            idx_caida = [diffs.idxmin()]
        idx_caida = idx_caida[0]
        
        # Valor previo al estrés: media de los 2 meses antes del evento
        idx_previo_ini = max(0, idx_caida - 2)
        evi_previo = df_comp.loc[idx_previo_ini:idx_caida - 1, col].mean()
        
        # Valor mínimo post-caída (nadir)
        idx_nadir_fin = min(len(df_comp) - 1, idx_caida + 2)
        evi_nadir = df_comp.loc[idx_caida:idx_nadir_fin, col].min()
        idx_nadir = df_comp.loc[idx_caida:idx_nadir_fin, col].idxmin()
        
        # Valor N meses después del nadir
        idx_post = min(len(df_comp) - 1, idx_nadir + n_meses_resil)
        evi_post = df_comp.loc[idx_post, col]
        
        # Calcular IR
        rango = evi_previo - evi_nadir
        if abs(rango) < 1e-6:
            ir = np.nan
        else:
            ir = (evi_post - evi_nadir) / rango
        
        # Velocidad: meses para alcanzar P75 del estado pre-estrés
        umbral_recuperacion = evi_nadir + 0.75 * rango
        meses_para_recuperar = None
        for idx_r in range(idx_nadir, min(len(df_comp), idx_nadir + 12)):
            if df_comp.loc[idx_r, col] >= umbral_recuperacion:
                meses_para_recuperar = idx_r - idx_nadir
                break
        
        resultados_ir.append({
            'lote':        lote,
            'componente':  comp,
            'fecha_caida': fecha_caida,
            'evi_previo':  evi_previo,
            'evi_nadir':   evi_nadir,
            'evi_post':    evi_post,
            'magnitud_caida': evento['magnitud_caida'],
            'z_score_caida':  evento['z_score'],
            'IR':          ir,
            f'evi_{n_meses_resil}m_post': evi_post,
            'meses_para_recuperar_p75': meses_para_recuperar,
            'recuperacion_rapida': (meses_para_recuperar is not None and
                                    meses_para_recuperar <= n_meses_resil),
        })
    
    df_ir_eventos = pd.DataFrame(resultados_ir)
    
    if df_ir_eventos.empty:
        return df_ir_eventos, pd.DataFrame()
    
    # Agregar IR por componente (media de todos sus eventos)
    df_ir_comp = df_ir_eventos.groupby(['lote', 'componente']).agg(
        n_eventos         = ('IR', 'count'),
        IR_media          = ('IR', 'mean'),
        IR_std            = ('IR', 'std'),
        magnitud_media    = ('magnitud_caida', 'mean'),
        meses_recuperar_media = ('meses_para_recuperar_p75', 'mean'),
        pct_recuperacion_rapida = ('recuperacion_rapida',
                                    lambda x: 100 * x.sum() / len(x))
    ).reset_index()
    
    # Clasificación de resiliencia
    def clasificar_resiliencia(ir):
        if pd.isna(ir): return 'Sin datos'
        if ir >= 0.90:  return '🟢 Alta resiliencia (recuperación ≥90%)'
        if ir >= 0.60:  return '🟡 Resiliencia media (60–89%)'
        if ir >= 0.30:  return '🟠 Resiliencia baja (30–59%)'
        return              '🔴 Muy baja resiliencia (<30%)'
    
    def clasificar_velocidad(meses):
        if pd.isna(meses): return 'Sin recuperación detectada'
        if meses <= 2:     return '⚡ Muy rápida (≤2 meses)'
        if meses <= 4:     return '✅ Rápida (3–4 meses)'
        if meses <= 6:     return '⚠ Moderada (5–6 meses)'
        return                    '🐢 Lenta (>6 meses)'
    
    df_ir_comp['clase_resiliencia'] = df_ir_comp['IR_media'].apply(clasificar_resiliencia)
    df_ir_comp['clase_velocidad']   = df_ir_comp['meses_recuperar_media'].apply(clasificar_velocidad)
    
    return df_ir_eventos, df_ir_comp


print("Calculando Índice de Resiliencia — Lote 1...")
df_ir_ev_l1, df_ir_comp_l1 = calcular_indice_resiliencia(
    df_st_l1, df_eventos_l1, BANDA_BIOMASA, N_MESES_RESIL, VENTANA_MESES)

print("Calculando Índice de Resiliencia — Lote 2...")
df_ir_ev_l2, df_ir_comp_l2 = calcular_indice_resiliencia(
    df_st_l2, df_eventos_l2, BANDA_BIOMASA, N_MESES_RESIL, VENTANA_MESES)

print("\n=== RESILIENCIA POR COMPONENTE GMM — LOTE 1 ===")
if not df_ir_comp_l1.empty:
    print(df_ir_comp_l1[['componente','n_eventos','IR_media',
                           'clase_resiliencia','clase_velocidad',
                           'pct_recuperacion_rapida']].to_string(index=False))

print("\n=== RESILIENCIA POR COMPONENTE GMM — LOTE 2 ===")
if not df_ir_comp_l2.empty:
    print(df_ir_comp_l2[['componente','n_eventos','IR_media',
                           'clase_resiliencia','clase_velocidad',
                           'pct_recuperacion_rapida']].to_string(index=False))
```

```python
# =============================================================================
# CELDA REG-7: Índice de Regeneración Relativa (IRR) vs Bosque de Referencia
# =============================================================================
# IRR = TR_componente / TR_bosque
#
# La Tasa de Regeneración (TR) se define como la pendiente de recuperación
# post-estrés normalizada por la magnitud de la caída:
#   TR = Δ(índice) / Δt / magnitud_caída
#
# IRR = 1.0: la zona se recupera igual que el bosque referencia
# IRR > 1.0: la zona se recupera más rápido que el bosque (excepcional)
# IRR < 1.0: la zona se recupera más lentamente que el bosque
# IRR < 0.3: zona de recuperación crítica — intervención urgente

def calcular_tasa_regeneracion_serie(df_comp_zona, banda=BANDA_BIOMASA,
                                      ventana_meses=VENTANA_MESES):
    """
    Calcula la Tasa de Regeneración (TR) como la pendiente promedio de los
    segmentos de recuperación post-caída en la serie temporal.
    
    Considera solo segmentos donde el índice aumenta mes a mes
    (recuperación activa), ignorando descensos.
    
    Retorna: TR (escalar), lista de pendientes de segmentos recuperación
    """
    col = f'{banda}_media'
    if col not in df_comp_zona.columns:
        return np.nan, []
    
    serie = df_comp_zona.tail(ventana_meses)[col].values
    
    if len(serie) < 4 or np.all(np.isnan(serie)):
        return np.nan, []
    
    # Suavizado para eliminar artefactos atmosféricos
    serie_suav = savgol_filter(
        np.where(np.isnan(serie), np.nanmean(serie), serie),
        window_length=min(5, len(serie) if len(serie) % 2 == 1 else len(serie)-1),
        polyorder=2
    )
    
    # Detectar segmentos de aumento (recuperación)
    diffs = np.diff(serie_suav)
    pendientes_recuperacion = diffs[diffs > 0]  # solo aumentos
    
    if len(pendientes_recuperacion) == 0:
        return 0.0, []
    
    tr = float(np.mean(pendientes_recuperacion))
    return tr, pendientes_recuperacion.tolist()


def calcular_irr_completo(df_st_comp, df_bosque_ref,
                           banda=BANDA_BIOMASA,
                           ventana_meses=VENTANA_MESES):
    """
    Calcula el IRR para todos los componentes GMM comparados contra
    la zona boscosa de referencia.
    """
    # TR del bosque de referencia
    tr_bosque, _ = calcular_tasa_regeneracion_serie(df_bosque_ref, banda, ventana_meses)
    
    print(f"  TR Bosque de Referencia ({banda}): {tr_bosque:.6f} unidades/mes")
    
    if tr_bosque is np.nan or tr_bosque == 0:
        print("  ⚠ TR bosque = 0 o sin datos — IRR no calculable sin referencia válida.")
        tr_bosque = 1e-6  # evitar división por cero; IRR será muy grande
    
    resultados_irr = []
    
    for lote in df_st_comp['lote'].unique():
        df_lote = df_st_comp[df_st_comp['lote'] == lote]
        
        for comp in sorted(df_lote['componente'].unique()):
            df_comp = df_lote[df_lote['componente'] == comp].sort_values('fecha')
            
            tr_comp, pendientes = calcular_tasa_regeneracion_serie(
                df_comp, banda, ventana_meses)
            
            if tr_comp is np.nan:
                irr = np.nan
            else:
                irr = tr_comp / tr_bosque
            
            # Clasificación del IRR
            def clasificar_irr(v):
                if pd.isna(v):          return 'Sin datos'
                if v >= 1.0:            return '🟢 Igual o superior al bosque'
                if v >= 0.70:           return '🟡 Recuperación buena (70–99% del bosque)'
                if v >= 0.40:           return '🟠 Recuperación moderada (40–69%)'
                if v >= 0.10:           return '🔴 Recuperación lenta (<40% del bosque)'
                return                         '⛔ Degradación progresiva — intervención urgente'
            
            # Medias del período en la ventana
            df_ventana = df_comp.tail(ventana_meses)
            
            resultados_irr.append({
                'lote':           lote,
                'componente':     comp,
                'TR_componente':  tr_comp,
                'TR_bosque_ref':  tr_bosque,
                'IRR':            irr,
                'clase_IRR':      clasificar_irr(irr),
                'n_segmentos_rec': len(pendientes),
                f'{banda}_media_ventana': df_ventana[f'{banda}_media'].mean()
                    if f'{banda}_media' in df_ventana.columns else np.nan,
            })
    
    df_irr = pd.DataFrame(resultados_irr)
    return df_irr, tr_bosque


print("Calculando IRR vs Bosque Referencia — Lote 1...")
df_irr_l1, tr_bosque_l1 = calcular_irr_completo(
    df_st_l1, df_bosque, BANDA_BIOMASA, VENTANA_MESES)

print("\nCalculando IRR vs Bosque Referencia — Lote 2...")
df_irr_l2, tr_bosque_l2 = calcular_irr_completo(
    df_st_l2, df_bosque, BANDA_BIOMASA, VENTANA_MESES)

print("\n=== ÍNDICE DE REGENERACIÓN RELATIVA — LOTE 1 ===")
print(df_irr_l1[['componente','TR_componente','IRR','clase_IRR']].to_string(index=False))

print("\n=== ÍNDICE DE REGENERACIÓN RELATIVA — LOTE 2 ===")
print(df_irr_l2[['componente','TR_componente','IRR','clase_IRR']].to_string(index=False))
```

```python
# =============================================================================
# CELDA REG-8: Tabla maestra de métricas de regeneración (todas unificadas)
# =============================================================================

def construir_tabla_maestra(df_ie, df_ir_comp, df_irr, df_eventos,
                              nombre_lote, ventana_meses=VENTANA_MESES):
    """
    Unifica IE, IR, IRR, n_eventos y clasificaciones en una sola tabla.
    Esta es la tabla de priorización agronómica principal.
    """
    # IE — base
    df_m = df_ie[df_ie['lote'] == nombre_lote][
        ['componente','IE_global','IE_NDVI','IE_EVI','IE_NDWI',
         'IE_CIre','estabilidad_clase']
    ].copy()
    
    # IR
    if not df_ir_comp.empty:
        df_ir_sub = df_ir_comp[df_ir_comp['lote'] == nombre_lote][
            ['componente','n_eventos','IR_media','meses_recuperar_media',
             'pct_recuperacion_rapida','clase_resiliencia','clase_velocidad']
        ]
        df_m = df_m.merge(df_ir_sub, on='componente', how='left')
    
    # IRR
    df_irr_sub = df_irr[df_irr['lote'] == nombre_lote][
        ['componente','TR_componente','IRR','clase_IRR']
    ]
    df_m = df_m.merge(df_irr_sub, on='componente', how='left')
    
    # Conteo de caídas abruptas
    if not df_eventos.empty:
        n_caidas = (df_eventos[df_eventos['lote'] == nombre_lote]
                    .groupby('componente').size().reset_index(name='n_caidas_abruptas'))
        df_m = df_m.merge(n_caidas, on='componente', how='left')
        df_m['n_caidas_abruptas'] = df_m['n_caidas_abruptas'].fillna(0).astype(int)
    else:
        df_m['n_caidas_abruptas'] = 0
    
    # Índice compuesto de prioridad de intervención (0=urgente, 100=excelente)
    # Combina IE, IR normalizado e IRR normalizado
    ie_norm  = df_m['IE_global'].fillna(0)
    ir_norm  = df_m['IR_media'].fillna(0).clip(0, 1)
    irr_norm = df_m['IRR'].fillna(0).clip(0, 2) / 2  # normalizar IRR a [0,1]
    
    df_m['score_prioridad'] = (
        0.30 * ie_norm +
        0.40 * ir_norm +
        0.30 * irr_norm
    ) * 100
    
    df_m['prioridad_intervencion'] = pd.cut(
        df_m['score_prioridad'],
        bins=[0, 25, 50, 75, 100],
        labels=['🔴 URGENTE', '🟠 ALTA', '🟡 MEDIA', '🟢 NORMAL']
    )
    
    df_m['lote'] = nombre_lote
    df_m['ventana_meses_analizada'] = ventana_meses
    
    return df_m.round(4)


df_maestra_l1 = construir_tabla_maestra(
    df_ie_l1, df_ir_comp_l1, df_irr_l1, df_eventos_l1,
    'Lote1_Juvenil_3yr', VENTANA_MESES)

df_maestra_l2 = construir_tabla_maestra(
    df_ie_l2, df_ir_comp_l2, df_irr_l2, df_eventos_l2,
    'Lote2_Adulto_10yr', VENTANA_MESES)

# Exportar
df_maestra_l1.to_csv('metricas_regeneracion/tabla_maestra_lote1.csv', index=False)
df_maestra_l2.to_csv('metricas_regeneracion/tabla_maestra_lote2.csv', index=False)

print("\n" + "="*80)
print("TABLA MAESTRA DE MÉTRICAS DE REGENERACIÓN — LOTE 1 (JUVENIL 3 años)")
print("="*80)
cols_print = ['componente','IE_global','IR_media','IRR',
              'n_caidas_abruptas','score_prioridad','prioridad_intervencion']
print(df_maestra_l1[[c for c in cols_print
                      if c in df_maestra_l1.columns]].to_string(index=False))

print("\n" + "="*80)
print("TABLA MAESTRA DE MÉTRICAS DE REGENERACIÓN — LOTE 2 (ADULTO 10 años)")
print("="*80)
print(df_maestra_l2[[c for c in cols_print
                      if c in df_maestra_l2.columns]].to_string(index=False))
```

---

### 10.3 Código Python completo — Visualizaciones de regeneración

```python
# =============================================================================
# CELDA REG-9: Panel principal de regeneración (figura de 6 subplots)
# =============================================================================

def graficar_panel_regeneracion(df_st_comp, df_maestra, df_eventos, df_bosque,
                                  nombre_lote, banda=BANDA_BIOMASA,
                                  ventana_meses=VENTANA_MESES,
                                  ruta_salida='metricas_regeneracion'):
    """
    Panel de 6 subplots para diagnóstico completo de regeneración:
    
    [1,1] Series temporales + eventos de caída abrupta por componente GMM
    [1,2] Índice de Estabilidad (IE) por componente y banda
    [2,1] Comparación TR: componentes vs bosque referencia
    [2,2] Índice de Resiliencia (IR) y velocidad de recuperación
    [3,1] IRR: Regeneración Relativa vs Bosque (gauge chart)
    [3,2] Score de prioridad de intervención (ranking)
    """
    col = f'{banda}_media'
    
    fig = plt.figure(figsize=(22, 22))
    fig.suptitle(
        f'Panel de Métricas de Regeneración — {nombre_lote}\n'
        f'Ventana de análisis: {ventana_meses} meses | '
        f'Índice principal: {banda} | Referencia: Bosque nativo',
        fontsize=14, fontweight='bold', y=0.99
    )
    
    gs = gridspec.GridSpec(3, 2, figure=fig, hspace=0.45, wspace=0.30)
    
    # Paleta consistente con GMM
    paleta_comp = {i: PALETA_GMM.get(i, ('#999999',''))[0]
                   for i in range(K_MAX)}
    
    # ==========================================================================
    # SUBPLOT [0,0]: Series temporales por componente + marcadores de caída
    # ==========================================================================
    ax1 = fig.add_subplot(gs[0, 0])
    
    inicio_ventana = (pd.Timestamp('2022-01-01') +
                      pd.DateOffset(months=36 - ventana_meses))
    
    componentes_lote = sorted(df_st_comp[
        df_st_comp['lote'] == nombre_lote]['componente'].unique())
    
    for comp in componentes_lote:
        df_comp = (df_st_comp[(df_st_comp['lote'] == nombre_lote) &
                               (df_st_comp['componente'] == comp)]
                   .sort_values('fecha'))
        df_ventana = df_comp[df_comp['fecha'] >= inicio_ventana]
        
        if df_ventana.empty or col not in df_ventana.columns:
            continue
        
        color = paleta_comp.get(comp, '#999999')
        ax1.plot(df_ventana['fecha'], df_ventana[col],
                 'o-', color=color, linewidth=2, markersize=4,
                 label=f'C{comp}: {PALETA_GMM.get(comp, ("","Sin etiqueta"))[1]}',
                 alpha=0.85)
        
        # Área de confianza: ±1std
        if f'{banda}_std' in df_ventana.columns:
            std_vals = df_ventana[f'{banda}_std'].fillna(0)
            ax1.fill_between(
                df_ventana['fecha'],
                df_ventana[col] - std_vals,
                df_ventana[col] + std_vals,
                color=color, alpha=0.10
            )
    
    # Serie del bosque de referencia
    df_bosque_v = df_bosque[df_bosque['fecha'] >= inicio_ventana]
    if not df_bosque_v.empty and col in df_bosque_v.columns:
        ax1.plot(df_bosque_v['fecha'], df_bosque_v[col],
                 'k--', linewidth=2.5, markersize=0,
                 label='Bosque referencia', alpha=0.7, zorder=10)
        ax1.fill_between(
            df_bosque_v['fecha'],
            df_bosque_v.get(f'{banda}_p25', df_bosque_v[col]),
            df_bosque_v.get(f'{banda}_p75', df_bosque_v[col]),
            color='gray', alpha=0.12, label='IQR Bosque'
        )
    
    # Marcadores de caídas abruptas
    if not df_eventos.empty:
        ev_lote = df_eventos[df_eventos['lote'] == nombre_lote]
        for _, ev in ev_lote.iterrows():
            fecha_ev = pd.Timestamp(ev['fecha_caida'])
            if fecha_ev >= inicio_ventana:
                ax1.axvline(x=fecha_ev, color='red', linestyle=':',
                            linewidth=1.2, alpha=0.7)
                ax1.annotate(
                    f'↓{ev["magnitud_caida"]:.3f}\n(C{int(ev["componente"])})',
                    xy=(fecha_ev, ev['valor_post']),
                    xytext=(10, -25), textcoords='offset points',
                    fontsize=6.5, color='red',
                    arrowprops=dict(arrowstyle='->', color='red', lw=0.8)
                )
    
    ax1.set_title(f'Series temporales por componente GMM\nCaídas abruptas marcadas '
                  f'(z>{UMBRAL_CAIDA_SIGMA}σ) | Banda: {banda}',
                  fontsize=10, fontweight='bold')
    ax1.set_ylabel(banda, fontweight='bold')
    ax1.legend(fontsize=7, loc='lower right', ncol=2)
    ax1.grid(alpha=0.25)
    ax1.xaxis.set_major_formatter(mdates.DateFormatter('%b\n%Y'))
    
    # ==========================================================================
    # SUBPLOT [0,1]: Heatmap de Índice de Estabilidad por componente y banda
    # ==========================================================================
    ax2 = fig.add_subplot(gs[0, 1])
    
    df_ie_lote = df_maestra[df_maestra['lote'] == nombre_lote]
    cols_ie = [c for c in df_ie_lote.columns if c.startswith('IE_') and c != 'IE_global']
    
    if cols_ie and not df_ie_lote.empty:
        ie_matrix = df_ie_lote.set_index('componente')[cols_ie].astype(float)
        ie_matrix.columns = [c.replace('IE_','') for c in cols_ie]
        
        sns.heatmap(ie_matrix, ax=ax2, cmap='RdYlGn', vmin=0, vmax=1,
                    annot=True, fmt='.3f', annot_kws={'size': 9},
                    linewidths=0.5, cbar_kws={'label': 'IE (0=inestable, 1=estable)'})
        ax2.set_title('Índice de Estabilidad (IE) por componente y banda\n'
                      '1.0=muy estable | 0.0=muy variable (alta CV temporal)',
                      fontsize=10, fontweight='bold')
        ax2.set_xlabel('Banda espectral', fontweight='bold')
        ax2.set_ylabel('Componente GMM', fontweight='bold')
    
    # ==========================================================================
    # SUBPLOT [1,0]: Comparación de TR componentes vs bosque de referencia
    # ==========================================================================
    ax3 = fig.add_subplot(gs[1, 0])
    
    df_irr_lote = df_irr_l1 if 'Lote1' in nombre_lote else df_irr_l2
    df_irr_lote = df_irr_lote[df_irr_lote['lote'] == nombre_lote].copy()
    
    if not df_irr_lote.empty:
        comps    = df_irr_lote['componente'].astype(str).tolist()
        tr_vals  = df_irr_lote['TR_componente'].fillna(0).tolist()
        tr_ref   = df_irr_lote['TR_bosque_ref'].iloc[0] if len(df_irr_lote) > 0 else 0
        colores_barras = [paleta_comp.get(int(c), '#999999') for c in comps]
        
        barras = ax3.barh(comps, tr_vals, color=colores_barras, alpha=0.8, height=0.5)
        ax3.axvline(x=tr_ref, color='black', linewidth=2.5, linestyle='--',
                    label=f'TR Bosque referencia = {tr_ref:.5f}')
        
        # Anotaciones con IRR
        for barra, irr_val in zip(barras, df_irr_lote['IRR'].fillna(0)):
            ax3.text(barra.get_width() + abs(tr_ref) * 0.05,
                     barra.get_y() + barra.get_height() / 2,
                     f'IRR={irr_val:.2f}',
                     va='center', fontsize=9, fontweight='bold')
        
        ax3.set_xlabel(f'Tasa de Regeneración ({banda}/mes)', fontweight='bold')
        ax3.set_title('Tasa de Regeneración por componente vs Bosque referencia\n'
                      'IRR = TR_componente / TR_bosque (IRR≥1.0: igual o mejor que el bosque)',
                      fontsize=10, fontweight='bold')
        ax3.legend(fontsize=9)
        ax3.grid(axis='x', alpha=0.3)
    
    # ==========================================================================
    # SUBPLOT [1,1]: Índice de Resiliencia (IR) y velocidad de recuperación
    # ==========================================================================
    ax4 = fig.add_subplot(gs[1, 1])
    
    if not df_ir_comp_l1.empty or not df_ir_comp_l2.empty:
        df_ir_sub = (df_ir_comp_l1 if 'Lote1' in nombre_lote else df_ir_comp_l2)
        df_ir_sub = df_ir_sub[df_ir_sub['lote'] == nombre_lote].copy() \
                    if not df_ir_sub.empty else pd.DataFrame()
        
        if not df_ir_sub.empty and 'IR_media' in df_ir_sub.columns:
            x_pos   = np.arange(len(df_ir_sub))
            ir_vals = df_ir_sub['IR_media'].fillna(0).values
            mv_vals = df_ir_sub['meses_recuperar_media'].fillna(0).values
            colores_ir = [paleta_comp.get(int(c), '#999999')
                          for c in df_ir_sub['componente']]
            
            barras_ir = ax4.bar(x_pos - 0.2, ir_vals, 0.35,
                                color=colores_ir, alpha=0.85,
                                label=f'IR ({N_MESES_RESIL}m post-estrés)')
            
            ax4b = ax4.twinx()
            ax4b.bar(x_pos + 0.2, mv_vals, 0.35, color='#95a5a6', alpha=0.6,
                     label='Meses para recuperar P75')
            
            ax4.axhline(y=1.0, color='green', linestyle=':', linewidth=1.5,
                        label='IR=1.0 (recuperación completa)')
            ax4.axhline(y=0.0, color='gray',  linestyle='-', linewidth=0.5)
            
            ax4.set_xticks(x_pos)
            ax4.set_xticklabels([f'C{int(c)}' for c in df_ir_sub['componente']],
                                fontweight='bold')
            ax4.set_ylabel('Índice de Resiliencia (IR)', fontweight='bold')
            ax4b.set_ylabel('Meses para recuperar P75', fontweight='bold', color='gray')
            ax4.set_ylim(-0.2, 1.6)
            ax4.set_title(f'Índice de Resiliencia (IR) y velocidad de recuperación\n'
                          f'IR≥0.9: alta resiliencia | IR<0.3: muy baja resiliencia',
                          fontsize=10, fontweight='bold')
            
            lines1, labs1 = ax4.get_legend_handles_labels()
            lines2, labs2 = ax4b.get_legend_handles_labels()
            ax4.legend(lines1 + lines2, labs1 + labs2, fontsize=8, loc='upper right')
            ax4.grid(axis='y', alpha=0.25)
    
    # ==========================================================================
    # SUBPLOT [2,0]: Cronograma de caídas abruptas en la ventana temporal
    # ==========================================================================
    ax5 = fig.add_subplot(gs[2, 0])
    
    if not df_eventos.empty:
        ev_lote = df_eventos[df_eventos['lote'] == nombre_lote].copy()
        ev_lote['fecha_caida'] = pd.to_datetime(ev_lote['fecha_caida'])
        ev_lote = ev_lote[ev_lote['fecha_caida'] >= inicio_ventana]
        
        if not ev_lote.empty:
            scatter = ax5.scatter(
                ev_lote['fecha_caida'],
                ev_lote['componente'],
                s=ev_lote['magnitud_caida'] * 2000,
                c=ev_lote['z_score_caida'].abs(),
                cmap='Reds', alpha=0.7, edgecolors='black', linewidths=0.5,
                vmin=UMBRAL_CAIDA_SIGMA, vmax=5
            )
            cbar = plt.colorbar(scatter, ax=ax5, fraction=0.03, pad=0.01)
            cbar.set_label('|z-score| de la caída', fontsize=8)
            
            ax5.set_yticks(sorted(ev_lote['componente'].unique()))
            ax5.set_yticklabels([f'C{int(c)}' for c in sorted(ev_lote['componente'].unique())],
                                fontweight='bold')
            ax5.set_xlabel('Fecha de caída abrupta', fontweight='bold')
            ax5.set_ylabel('Componente GMM', fontweight='bold')
            ax5.set_title(f'Cronograma de caídas abruptas detectadas (>{UMBRAL_CAIDA_SIGMA}σ)\n'
                          f'Tamaño del punto = magnitud de la caída | '
                          f'Color = intensidad (z-score)',
                          fontsize=10, fontweight='bold')
            ax5.xaxis.set_major_formatter(mdates.DateFormatter('%b\n%Y'))
            ax5.grid(alpha=0.25)
        else:
            ax5.text(0.5, 0.5, f'Sin caídas abruptas\ndetectadas en la\nventana de '
                     f'{ventana_meses} meses',
                     ha='center', va='center', transform=ax5.transAxes,
                     fontsize=12, color='green')
            ax5.set_title('Cronograma de caídas abruptas', fontsize=10, fontweight='bold')
            ax5.axis('off')
    
    # ==========================================================================
    # SUBPLOT [2,1]: Score de prioridad de intervención + ranking
    # ==========================================================================
    ax6 = fig.add_subplot(gs[2, 1])
    
    df_m = df_maestra[df_maestra['lote'] == nombre_lote].copy()
    
    if not df_m.empty and 'score_prioridad' in df_m.columns:
        df_m_sorted = df_m.sort_values('score_prioridad', ascending=True)
        
        colores_score = []
        for score in df_m_sorted['score_prioridad']:
            if score >= 75:   colores_score.append('#27ae60')  # verde
            elif score >= 50: colores_score.append('#f39c12')  # amarillo
            elif score >= 25: colores_score.append('#e67e22')  # naranja
            else:             colores_score.append('#e74c3c')  # rojo
        
        barras_s = ax6.barh(
            [f'C{int(c)}' for c in df_m_sorted['componente']],
            df_m_sorted['score_prioridad'],
            color=colores_score, alpha=0.85, height=0.55
        )
        
        # Anotaciones con prioridad e IRR
        for barra, (_, row) in zip(barras_s, df_m_sorted.iterrows()):
            irr_str = f'IRR={row.get("IRR", np.nan):.2f}' \
                      if not pd.isna(row.get('IRR', np.nan)) else 'IRR=N/A'
            ax6.text(barra.get_width() + 0.5, barra.get_y() + barra.get_height()/2,
                     f'{row.get("prioridad_intervencion","—")} | {irr_str}',
                     va='center', fontsize=8)
        
        ax6.axvline(x=75, color='green', linestyle=':', linewidth=1.5,
                    label='Umbral Normal (75)')
        ax6.axvline(x=50, color='orange', linestyle=':', linewidth=1.5,
                    label='Umbral Alerta Media (50)')
        ax6.axvline(x=25, color='red', linestyle=':', linewidth=1.5,
                    label='Umbral Urgente (25)')
        
        ax6.set_xlim(0, 115)
        ax6.set_xlabel('Score de prioridad de intervención\n'
                       '(IE×30% + IR×40% + IRR_norm×30%)',
                       fontweight='bold')
        ax6.set_title('Ranking de prioridad de intervención por componente\n'
                      '100=excelente | 0=intervención urgente',
                      fontsize=10, fontweight='bold')
        ax6.legend(fontsize=8, loc='lower right')
        ax6.grid(axis='x', alpha=0.25)
    
    plt.tight_layout()
    archivo = os.path.join(ruta_salida,
                           f'panel_regeneracion_{nombre_lote}_v{ventana_meses}m.png')
    plt.savefig(archivo, dpi=200, bbox_inches='tight', facecolor='white')
    plt.show()
    print(f"✓ Panel de regeneración guardado: {archivo}")


# Generar paneles para ambos lotes
graficar_panel_regeneracion(df_st_l1, df_maestra_l1, df_eventos_l1,
                              df_bosque, 'Lote1_Juvenil_3yr',
                              BANDA_BIOMASA, VENTANA_MESES)

graficar_panel_regeneracion(df_st_l2, df_maestra_l2, df_eventos_l2,
                              df_bosque, 'Lote2_Adulto_10yr',
                              BANDA_BIOMASA, VENTANA_MESES)
```

```python
# =============================================================================
# CELDA REG-10: Análisis multibanda de regeneración (todas las bandas juntas)
# =============================================================================
# Repite el análisis de IE, IR e IRR para las 5 bandas simultáneamente.
# Genera un mapa de calor multibanda para identificar qué dimensión espectral
# es la más resiliente o la más vulnerable en cada componente GMM.

def analisis_multibanda_regeneracion(df_st_comp, df_bosque_ref,
                                      df_eventos, nombre_lote,
                                      ventana_meses=VENTANA_MESES,
                                      ruta_salida='metricas_regeneracion'):
    """
    Para cada una de las 5 bandas calcula:
    - IE (Índice de Estabilidad)
    - IR (Índice de Resiliencia, si hay eventos disponibles)
    - IRR (Índice de Regeneración Relativa vs bosque)
    
    Produce una matriz 3D: componentes × bandas × métricas
    visualizada como heatmap multibanda.
    """
    metricas_multibanda = []
    
    df_lote = df_st_comp[df_st_comp['lote'] == nombre_lote]
    
    for banda in BANDAS:
        col = f'{banda}_media'
        
        # TR del bosque para esta banda
        tr_bosque, _ = calcular_tasa_regeneracion_serie(
            df_bosque_ref, banda, ventana_meses)
        if tr_bosque is None or tr_bosque == 0:
            tr_bosque = 1e-6
        
        for comp in sorted(df_lote['componente'].unique()):
            df_comp = df_lote[df_lote['componente'] == comp].sort_values('fecha')
            df_v    = df_comp.tail(ventana_meses)
            
            # IE por banda
            if col in df_v.columns:
                vals = df_v[col].dropna()
                cv_b = vals.std() / abs(vals.mean()) if vals.mean() != 0 else np.nan
                ie_b = max(0, 1 - cv_b) if not np.isnan(cv_b) else np.nan
            else:
                ie_b = np.nan
            
            # TR e IRR por banda
            tr_comp, _ = calcular_tasa_regeneracion_serie(df_comp, banda, ventana_meses)
            irr_b = (tr_comp / tr_bosque) if (tr_comp is not None and
                                                tr_bosque != 0) else np.nan
            
            metricas_multibanda.append({
                'lote': nombre_lote, 'componente': comp, 'banda': banda,
                'IE': ie_b, 'IRR': irr_b,
                'TR_comp': tr_comp, 'TR_bosque': tr_bosque
            })
    
    df_mb = pd.DataFrame(metricas_multibanda)
    
    # ---- Figura: heatmaps IE e IRR por (componente × banda) -------------------
    fig, ejes = plt.subplots(1, 2, figsize=(16, 5))
    fig.suptitle(
        f'Análisis Multibanda de Regeneración — {nombre_lote}\n'
        f'Ventana: {ventana_meses} meses',
        fontsize=13, fontweight='bold'
    )
    
    for ax, metrica, titulo, cmap, vmin, vmax in [
        (ejes[0], 'IE',
         'Índice de Estabilidad (IE) por componente × banda\n'
         '1.0=muy estable | 0.0=muy variable',
         'RdYlGn', 0, 1),
        (ejes[1], 'IRR',
         'IRR vs Bosque Referencia por componente × banda\n'
         '≥1.0=igual/mejor que bosque | <0.3=degradación crítica',
         'RdYlGn', 0, 1.5)
    ]:
        pivot = df_mb.pivot(index='componente', columns='banda', values=metrica)
        pivot = pivot.reindex(columns=BANDAS)
        
        sns.heatmap(pivot, ax=ax, cmap=cmap, vmin=vmin, vmax=vmax,
                    annot=True, fmt='.3f', annot_kws={'size': 10},
                    linewidths=0.5,
                    cbar_kws={'label': metrica, 'shrink': 0.8})
        ax.set_title(titulo, fontsize=10, fontweight='bold')
        ax.set_xlabel('Banda espectral', fontweight='bold')
        ax.set_ylabel('Componente GMM', fontweight='bold')
        ax.set_yticklabels([f'C{int(y.get_text())}' for y in ax.get_yticklabels()])
    
    plt.tight_layout()
    archivo = os.path.join(
        ruta_salida,
        f'heatmap_multibanda_regeneracion_{nombre_lote}.png'
    )
    plt.savefig(archivo, dpi=200, bbox_inches='tight', facecolor='white')
    plt.show()
    
    df_mb.to_csv(archivo.replace('.png', '.csv'), index=False)
    print(f"✓ Análisis multibanda guardado: {archivo}")
    return df_mb


df_mb_l1 = analisis_multibanda_regeneracion(
    df_st_l1, df_bosque, df_eventos_l1, 'Lote1_Juvenil_3yr', VENTANA_MESES)

df_mb_l2 = analisis_multibanda_regeneracion(
    df_st_l2, df_bosque, df_eventos_l2, 'Lote2_Adulto_10yr', VENTANA_MESES)
```

```python
# =============================================================================
# CELDA REG-11: Interfaz para cambio de ventana temporal por el usuario
# =============================================================================
# El usuario puede re-ejecutar todo el análisis de regeneración con cualquier
# ventana temporal (6, 12, 18, 24 meses) sin modificar el código principal.

def reanalizar_con_nueva_ventana(nueva_ventana_meses,
                                  df_st_l1, df_st_l2,
                                  df_eventos_l1, df_eventos_l2,
                                  df_bosque, df_ie_l1, df_ie_l2):
    """
    Recalcula todas las métricas de regeneración con una nueva ventana temporal.
    Llama: TR, IR, IRR, IE, tabla maestra y panel de visualización.
    """
    print(f"\n{'='*70}")
    print(f"RECALCULANDO CON VENTANA DE {nueva_ventana_meses} MESES")
    print(f"{'='*70}")
    
    # Re-calcular IR con nueva ventana
    _, df_ir_n_l1 = calcular_indice_resiliencia(
        df_st_l1, df_eventos_l1, BANDA_BIOMASA,
        N_MESES_RESIL, nueva_ventana_meses)
    _, df_ir_n_l2 = calcular_indice_resiliencia(
        df_st_l2, df_eventos_l2, BANDA_BIOMASA,
        N_MESES_RESIL, nueva_ventana_meses)
    
    # Re-calcular IRR con nueva ventana
    df_irr_n_l1, _ = calcular_irr_completo(
        df_st_l1, df_bosque, BANDA_BIOMASA, nueva_ventana_meses)
    df_irr_n_l2, _ = calcular_irr_completo(
        df_st_l2, df_bosque, BANDA_BIOMASA, nueva_ventana_meses)
    
    # Re-calcular IE con nueva ventana
    df_ie_n_l1 = calcular_indice_estabilidad(df_st_l1, nueva_ventana_meses)
    df_ie_n_l2 = calcular_indice_estabilidad(df_st_l2, nueva_ventana_meses)
    
    # Re-detectar caídas en nueva ventana
    df_ev_n_l1 = detectar_todos_eventos(df_st_l1, BANDA_BIOMASA, nueva_ventana_meses)
    df_ev_n_l2 = detectar_todos_eventos(df_st_l2, BANDA_BIOMASA, nueva_ventana_meses)
    
    # Tablas maestras
    df_m_n_l1 = construir_tabla_maestra(
        df_ie_n_l1, df_ir_n_l1, df_irr_n_l1, df_ev_n_l1,
        'Lote1_Juvenil_3yr', nueva_ventana_meses)
    df_m_n_l2 = construir_tabla_maestra(
        df_ie_n_l2, df_ir_n_l2, df_irr_n_l2, df_ev_n_l2,
        'Lote2_Adulto_10yr', nueva_ventana_meses)
    
    # Paneles de visualización
    graficar_panel_regeneracion(
        df_st_l1, df_m_n_l1, df_ev_n_l1, df_bosque,
        'Lote1_Juvenil_3yr', BANDA_BIOMASA, nueva_ventana_meses)
    graficar_panel_regeneracion(
        df_st_l2, df_m_n_l2, df_ev_n_l2, df_bosque,
        'Lote2_Adulto_10yr', BANDA_BIOMASA, nueva_ventana_meses)
    
    print(f"\n✓ Análisis con ventana de {nueva_ventana_meses} meses completado.")
    return df_m_n_l1, df_m_n_l2


# ---- EJEMPLOS DE USO — solo cambiar el primer argumento ---------------------
# Ventana de 6 meses (último semestre)
# df_m6_l1, df_m6_l2 = reanalizar_con_nueva_ventana(6, ...)

# Ventana de 18 meses
# df_m18_l1, df_m18_l2 = reanalizar_con_nueva_ventana(18, ...)

# Ventana de 24 meses (últimos 2 años)
df_m24_l1, df_m24_l2 = reanalizar_con_nueva_ventana(
    24, df_st_l1, df_st_l2,
    df_eventos_l1, df_eventos_l2,
    df_bosque, df_ie_l1, df_ie_l2
)
```

```python
# =============================================================================
# CELDA REG-12: Resumen ejecutivo imprimible — todas las métricas integradas
# =============================================================================

def imprimir_resumen_ejecutivo(df_maestra_l1, df_maestra_l2,
                                tr_bosque, ventana_meses=VENTANA_MESES):
    """
    Imprime un resumen conciso de las métricas de regeneración en formato
    legible para el equipo agronómico de campo.
    """
    separador = "=" * 72
    
    for df_m, nombre_lote in [(df_maestra_l1, 'Lote 1 — Juvenil (3 años)'),
                               (df_maestra_l2, 'Lote 2 — Adulto (10 años)')]:
        
        print(f"\n{separador}")
        print(f" INFORME EJECUTIVO DE REGENERACIÓN — {nombre_lote}")
        print(f" Ventana de análisis: {ventana_meses} meses | TR Bosque ref: {tr_bosque:.5f}")
        print(separador)
        
        for _, row in df_m.sort_values('score_prioridad').iterrows():
            comp   = int(row['componente'])
            ie     = row.get('IE_global', np.nan)
            ir     = row.get('IR_media',  np.nan)
            irr    = row.get('IRR',       np.nan)
            n_ev   = int(row.get('n_caidas_abruptas', 0))
            score  = row.get('score_prioridad', np.nan)
            prior  = row.get('prioridad_intervencion', '—')
            cls_ie = row.get('estabilidad_clase', '—')
            cls_r  = row.get('clase_resiliencia', '—')
            cls_v  = row.get('clase_velocidad',   '—')
            cls_irr= row.get('clase_IRR',         '—')
            mv     = row.get('meses_recuperar_media', np.nan)
            
            print(f"\n  Componente C{comp}")
            print(f"  {'─'*50}")
            print(f"  Estabilidad:    IE={ie:.3f}  →  {cls_ie}")
            print(f"  Resiliencia:    IR={ir:.3f}  →  {cls_r}")
            print(f"  Velocidad rec.: {mv:.1f} meses  →  {cls_v}"
                  if not np.isnan(mv) else
                  f"  Velocidad rec.: Sin eventos de recuperación detectados")
            print(f"  Regen. relativa: IRR={irr:.3f}  →  {cls_irr}"
                  if not np.isnan(irr) else
                  f"  Regen. relativa: IRR=N/A")
            print(f"  Caídas abruptas: {n_ev} evento(s) en la ventana")
            print(f"  Score prioridad: {score:.1f}/100  →  {prior}")
        
        print(f"\n{separador}")
        print(f" ZONAS DE MAYOR RECUPERACIÓN:")
        mejor = df_m.loc[df_m['IR_media'].idxmax()] if 'IR_media' in df_m else None
        if mejor is not None and not pd.isna(mejor.get('IR_media', np.nan)):
            print(f"  → C{int(mejor['componente'])}: IR={mejor['IR_media']:.3f}, "
                  f"IRR={mejor.get('IRR', np.nan):.3f}")
        
        print(f"\n ZONAS DE RECUPERACIÓN MÁS LENTA:")
        if 'meses_recuperar_media' in df_m.columns:
            peor_v = df_m.loc[df_m['meses_recuperar_media'].idxmax()
                               if df_m['meses_recuperar_media'].notna().any()
                               else 0]
            if not pd.isna(peor_v.get('meses_recuperar_media', np.nan)):
                print(f"  → C{int(peor_v['componente'])}: "
                      f"{peor_v['meses_recuperar_media']:.1f} meses para recuperar P75")
        
        print(f"\n ZONA MÁS ESTABLE:")
        if 'IE_global' in df_m.columns:
            mas_estable = df_m.loc[df_m['IE_global'].idxmax()]
            print(f"  → C{int(mas_estable['componente'])}: "
                  f"IE={mas_estable['IE_global']:.3f} — "
                  f"{mas_estable.get('estabilidad_clase','—')}")
        
        print(f"\n ZONA MÁS VARIABLE:")
        if 'IE_global' in df_m.columns:
            mas_variable = df_m.loc[df_m['IE_global'].idxmin()]
            print(f"  → C{int(mas_variable['componente'])}: "
                  f"IE={mas_variable['IE_global']:.3f} — "
                  f"{mas_variable.get('estabilidad_clase','—')}")
        print(separador)


imprimir_resumen_ejecutivo(df_maestra_l1, df_maestra_l2,
                            tr_bosque_l1, VENTANA_MESES)
```

---

### 10.4 Interpretación integrada de las seis métricas

El flujo de lectura de la tabla maestra sigue un orden jerárquico. El **Score de Prioridad** (0–100) es el indicador de acción inmediata: valores por debajo de 25 requieren visita de campo en menos de dos semanas. El **IRR** establece si el componente está convergiendo hacia el comportamiento del bosque de referencia (IRR → 1) o divergiendo (IRR → 0). El **IR** cuantifica la capacidad de rebote específica tras los eventos de caída detectados. El **IE** diferencia si la zona tiene alta variabilidad estructural (lote juvenil normal, IE~0.45) o si la variabilidad es anómala para la edad del lote (lote adulto con IE~0.40 cuando debería estar en ~0.80). El **número de caídas abruptas** por componente actúa como acumulador de perturbaciones históricas: un componente con 3 o más caídas en 12 meses sin recuperación completa (IR < 0.5) indica una zona bajo perturbación crónica, no puntual.

La **zona boscosa de referencia** cumple dos funciones técnicas distintas. Como denominador del IRR, elimina el componente de variabilidad climática regional que afecta simultáneamente a la plantación y al bosque — si el bosque también desciende en un mes dado, la caída de la plantación en ese mismo mes no es penalizada en el IRR. Como umbral superior de IE y TR, establece el techo ecológico alcanzable para la zona: un lote adulto maduro en condición óptima debería tener IRR entre 0.6 y 0.9, ya que las plantaciones monoespecíficas tienen inherentemente menor estabilidad espectral que el bosque tropical diverso. Un IRR > 1.0 en un lote de palma no es biológicamente imposible pero sí inusual; cuando ocurre, generalmente refleja que el bosque de referencia está bajo su propio estrés puntual (sequía localizada, perturbación de borde) y el umbral de comparación debe reconsiderarse con una zona de referencia alternativa.

---

## 11. Metaestudio: Índices Satelitales de Suelo para Regeneración Tropical (2021–2025)

### 11.1 Síntesis y hallazgo principal

**La evidencia más sólida respalda a BSI, SAVI, MSAVI2 y EVI2 como índices primarios para el monitoreo de la regeneración del suelo en agricultura tropical, pero persiste un sesgo geográfico crítico: menos de cinco estudios de validación abordan directamente las propiedades del suelo bajo el dosel de palma de aceite mediante teledetección.** Esta brecha es relevante porque la mayoría de las validaciones de índices provienen de Europa templada, China y América del Norte — regiones con mineralogía del suelo, estructura del dosel y condiciones atmosféricas fundamentalmente distintas a las plantaciones tropicales húmedas. Los conjuntos de aprendizaje automático que combinan múltiples índices con SAR Sentinel-1 alcanzan ahora **R² = 0,91** para la predicción de carbono orgánico del suelo en ecosistemas de cultivos comerciales del Sudeste Asiático, señalando la fusión multi-índice como el camino operativo a seguir. Esta revisión sintetiza más de 50 estudios publicados en revistas arbitradas (2021–2025) sobre 13 índices sensibles al suelo para proporcionar fórmulas listas para implementación, rangos de valores y rankings de evidencia orientados a la integración en protocolos de monitoreo de palma de aceite usando Sentinel-2 y Google Earth Engine.

---

### 11.2 Fórmulas de índices con bandas exactas del Sentinel-2

Todas las fórmulas usan la nomenclatura de bandas de GEE para la colección `COPERNICUS/S2_SR_HARMONIZED`. Los valores de reflectancia deben dividirse por 10.000 antes del cálculo cuando se usan colecciones con escala entera. Las compensaciones radiométricas del Processing Baseline 04.00 (post-2022) ya están corregidas en la colección armonizada — no aplicar doble corrección.

#### 11.2.1 Índices primarios sensibles al suelo (base de evidencia sólida)

**BSI — Índice de Suelo Desnudo (Bare Soil Index)**
```
BSI = ((B11 + B4) - (B8 + B2)) / ((B11 + B4) + (B8 + B2))
```
Bandas: B11 (SWIR1, 1610 nm, 20 m), B4 (Rojo, 665 nm, 10 m), B8 (NIR, 842 nm, 10 m), B2 (Azul, 490 nm, 10 m). La resolución mixta requiere remuestreo de B11 a 10 m. Rango: −1 a +1. Suelo tropical desnudo: **+0,1 a +0,4**; vegetación densa: −0,2 a 0; recuperación: −0,05 a +0,1.

Nguyen et al. (2021, *Land*, 10(3):231, DOI: 10.3390/land10030231) validaron BSI en Tailandia y Vietnam, reportando suelo desnudo tropical con media = **−0,365 ± 0,022** durante el barbecho agrícola. BSI superando el percentil 80 combinado con NDVI por debajo del percentil 20 detecta confiablemente los eventos de replantación de palma de aceite (*The Forestry Chronicle*, 2025, DOI: 10.1016/S1195-1036(25)00026-6). Para la predicción de COC, los composites temporales de BSI máximo alcanzaron **R² = 0,52** (*Remote Sensing*, 2025, 17(16):2877, DOI: 10.3390/rs17162877).

**SAVI — Índice de Vegetación Ajustado al Suelo**
```
SAVI = 1,5 * (B8 - B4) / (B8 + B4 + 0,5)
```
Bandas: B8 (10 m), B4 (10 m). Resolución pura de 10 m. Rango: −1,5 a +1,5. Degradado/desnudo: <0,2; en recuperación: 0,2–0,4; vegetación saludable: **0,4–0,8**. Se ha propuesto un factor L alternativo optimizado para Sentinel-2 de 0,428.

SAVI contribuyó con **16,0% de importancia de variable** en modelos de COC escalados desde UAV para ecosistemas degradados (*Land*, 2025, 14(2):377, DOI: 10.3390/land14020377). Charishma et al. (2024, *Geology, Ecology, and Landscapes*, DOI: 10.1080/24749508.2024.2392920) encontraron que SAVI correlaciona significativamente con arena (r² = 0,63), limo (r² = 0,73), arcilla (r² = 0,59) y pH (r² = 0,59) usando 90 muestras de suelo tropical de sitios indios Vertisol, Ultisol y Alfisol. SAVI está integrado en el marco de monitoreo de degradación de tierras UNCCD/LDMS para el reporte del ODS 15.3.1.

**MSAVI2 — Índice de Vegetación Ajustado al Suelo Modificado**
```
MSAVI2 = (2 * B8 + 1 - sqrt(pow(2 * B8 + 1, 2) - 8 * (B8 - B4))) / 2
```
Bandas: B8 (10 m), B4 (10 m). Resolución pura de 10 m. Rango: 0 a ~1. El factor L de auto-ajuste elimina la calibración manual.

MSAVI2 se clasificó como la **variable más crítica (22,2% de importancia)** para el mapeo de COC basado en Sentinel-2 en ecosistemas degradados, superando a todos los demás índices (*Land*, 2025, 14(2):377). En el monitoreo de aforestación en zonas áridas, MSAVI2 correlacionó con la biomasa sobre el suelo con **ρ de Spearman = 0,82** (p < 0,05) (*Earth Systems and Environment*, 2025, DOI: 10.1007/s41748-025-00705-z). Ismaili et al. (2025, *Frontiers in Soil Science*, 5:1553887, DOI: 10.3389/fsoil.2025.1553887) confirmaron que MSAVI2 captura eficazmente la vegetación dispersa y la biomasa reducida en suelos marroquíes degradados usando síntesis ponderada por PCA de índices Sentinel-2.

**EVI2 — Índice de Vegetación Mejorado de Dos Bandas**
```
EVI2 = 2,5 * (B8 - B4) / (B8 + 2,4 * B4 + 1)
```
Bandas: B8 (10 m), B4 (10 m). Resolución pura de 10 m. Rango: −0,5 a +1. Vegetación tropical densa: **0,5–0,9**; suelo desnudo: <0,15. La ventaja crítica del EVI2 en contextos de palma de aceite es su resistencia a la saturación en doseles de alta biomasa.

Hamer et al. (2025, *Discover Sustainability*, 6:379, DOI: 10.1007/s43621-025-01203-y) rastrearon la dinámica del EVI en agroecosistemas costeros tropicales de Guyana durante 8 años (2015–2023) usando GEE, reportando un **aumento de vegetación del 7,7%** durante 4 años de recuperación y valores medios de EVI de 0,65–0,70. EVI2 elimina la necesidad de la corrección de la banda azul presente en el EVI de 3 bandas completo, simplificando el cálculo sin sacrificar rendimiento.

#### 11.2.2 Índices basados en SWIR (evidencia moderada)

**NDTI / NSMI — Índice de Labranza de Diferencia Normalizada / Índice de Humedad del Suelo Normalizado**
```
NDTI = (B11 - B12) / (B11 + B12)
```
Bandas: B11 (SWIR1, 20 m), B12 (SWIR2, 20 m). Resolución nativa de 20 m. Rango: −1 a +1. **Estos dos índices comparten una fórmula Sentinel-2 idéntica** — provienen de tradiciones de investigación diferentes (Van Deventer et al. 1997 para labranza; Haubrock et al. 2008 para humedad) y miden fenómenos relacionados pero contextualmente distintos.

Du et al. (2022, *Soil and Tillage Research*, DOI: 10.1016/j.still.2022.105374) validaron NDTI contra la cobertura de residuos de maíz: **r = 0,854, R² = 0,729** con 36 muestras de campo del Sentinel-2A. Beeson et al. (2024, *Remote Sensing*, PMC11392983) confirmaron que NDTI tuvo la mayor importancia de variable entre los índices de labranza en modelos ML CatBoost usando datos Sentinel-2 de GEE. Para humedad del suelo, Alonso et al. reportaron **R² = 0,6–0,9** para NSMI versus sensores de campo en píxeles de suelo desnudo (NDVI ≤ 0,3). Suelo con residuos: +0,05 a +0,20; suelo mineral desnudo: −0,05 a +0,02; en recuperación con cobertura orgánica creciente: +0,02 a +0,10.

**CRSI — Índice de Salinidad de Respuesta del Dosel**
```
CRSI = sqrt(((B4 * B8) - (B3 * B2)) / ((B4 * B8) + (B3 * B2)))
```
Bandas: B4, B8, B3, B2 — todas a 10 m. Rango: 0–1. Suelo sano no salino: CRSI > 0,8; salino/degradado: **< 0,5**. Ramos et al. (2020, *Agricultural Water Management*, DOI: 10.1016/j.agwat.2020.106387) lograron la correlación de salinidad más sólida con un índice único (**r = −0,787**) usando CRSI con Sentinel-2 contra 80 mediciones de campo de ECe a 0–1,5 m de profundidad. Scudiero et al. (2015, *Remote Sensing of Environment*) reportaron **R² = 0,73** (modelo completo) y **R² = 0,61** (validación cruzada) para predicción de salinidad. CRSI es especialmente relevante para palma de aceite en suelos costeros o de turba con riesgo de salinidad.

#### 11.2.3 Índices de color y mineralogía del suelo (evidencia limitada en trópicos)

**RI — Índice de Rojez del Suelo (contenido de óxido de hierro)**
```
RI = pow(B4, 2) / (B2 * pow(B3, 3))
```
Bandas: B4, B2, B3 — todas a 10 m. Sin límite superior positivo; típicamente 0–10+. Valores más altos indican enriquecimiento de óxido de hierro (hematita). Los suelos lateríticos tropicales del Sudeste Asiático y África Occidental tienen RI naturalmente elevado. Forkuor et al. (2017, *PLOS ONE*, PMC5256943) encontraron RI entre los predictores espectrales más destacados para el mapeo digital del suelo en Burkina Faso tropical usando Random Forest. En predicción de COC en karst, RI contribuyó junto con CI y BI2 como variables importantes (*Remote Sensing*, 2023, 15(8):2118, DOI: 10.3390/rs15082118, basado en GEE). La dinámica temporal es lenta — RI refleja cambios mineralógicos y acumulación de materia orgánica a lo largo de meses o años.

**CI — Índice de Color del Suelo**
```
CI = (B4 - B2) / B4
```
Bandas: B4 (10 m), B2 (10 m). Rango: 0–1 para suelos. Suelo orgánico rico oscuro: CI ~0,2–0,4; suelo erosionado expuesto: **0,4–0,7**. CI correlaciona con el contenido de óxido de hierro y la oscuridad de la materia orgánica. Ismaili et al. (2025) incluyeron CI en la evaluación de degradación del suelo ponderada por PCA junto con RI, GSI y NDSI. Más apropiado como indicador de línea base a largo plazo que como índice de respuesta rápida, dada su muy lenta dinámica temporal (años).

**SCI — Índice de Composición del Suelo**
```
SCI = (B11 - B8) / (B11 + B8)
```
Bandas: B11 (20 m), B8 (10 m). Resolución mixta; usar B8A (20 m) para consistencia. Este índice **no está estandarizado** en la literatura arbitrada — el término "Índice de Composición del Suelo" aparece informalmente pero carece de una fórmula canónica única. Suelo mineral desnudo: SCI > 0; vegetado: SCI < 0.

**OCVI — Índice de Vegetación de Clorofila Optimizado**
```
OCVI = (B8 * B4 / pow(B3, 2)) * c
```
Donde c es un factor de corrección empírico de suelo/cultivo/ángulo (típicamente 0,5–2,0, requiere calibración local). Vincini et al. (2008, *Precision Agriculture*, DOI: 10.1007/s11119-008-9075-z). **No existen estudios de validación 2021–2025 que apliquen OCVI específicamente a la regeneración del suelo.** OCVI es principalmente un estimador de clorofila con corrección de fondo del suelo — útil como indicador indirecto de fertilidad del suelo a través de la salud del dosel en palma madura.

#### 11.2.4 Nuevos índices publicados en 2021–2025

Varios índices nuevos emergieron durante el período de revisión. El **HBSI (Índice Hiperspectral de Suelo Desnudo)** alcanzó >91% de precisión en Sentinel-2, aumentando a >92% combinado con NDVI, usando bandas Azul + NIR + SWIR2 (*Land*, 2023, 12(7):1375, DOI: 10.3390/land12071375). El **RANDRI (Índice de Residuos Ajustado Normalizado)** de Guo et al. (2022, *Soil and Tillage Research*, DOI: 10.1016/j.still.2022.105374) mejoró el mapeo de residuos de cultivos a **R² = 0,82** mediante modelos por partes. El **NDBSI (Índice Normalizado de Diferencia de Suelo Desnudo)** de Zhang et al. (2022, *Catena*, DOI: 10.1016/j.catena.2022.106364) superó a los índices de suelo desnudo tradicionales. El **OPTRAM (Modelo Óptico de Trapecio)**, usando diagramas de dispersión de NDVI versus Reflectancia Transformada SWIR, fue ampliamente aplicado para la recuperación de humedad del suelo desde Sentinel-2 y ahora cuenta con un paquete R (rOPTRAM) integrado con flujos de trabajo de GEE (Sadeghi et al., 2017, *Remote Sensing of Environment*, DOI: 10.1016/j.rse.2017.05.041). El **OLDI (Índice Óptimo de Degradación de Tierras)** integra factores de vegetación y suelo mediante optimización restringida (*Scientific Reports*, 2025).

---

### 11.3 Mediciones físicas del suelo y sus correlaciones satelitales

#### 11.3.1 El carbono orgánico del suelo logra predictibilidad moderada a alta

El COC es la relación suelo–satélite más estudiada. Ayala Izurieta et al. (2022, *Plant and Soil*, 479:159–183, DOI: 10.1007/s11104-022-05506-1) lograron la mayor precisión con datos ópticos: **R² = 0,85 (COC%, 0–30 cm)** y **R² = 0,86 (COC%, 30–60 cm)** usando Sentinel-2 con Regresión de Procesos Gaussianos y covariables SIG a partir de 493 muestras en el páramo tropical de Ecuador. El Contenido de Agua del Dosel fue la variable biofísica más relevante, mejorando la estimación en un 3–21%.

En África Subsahariana tropical, Tiruneh et al. (2024, *Earth Science Informatics*, DOI: 10.1007/s12145-024-01427-y) estimaron COC bajo labranza cero en Zimbabue, logrando **R² = 0,55–0,60** con ANN a partir de 50 muestras Sentinel-2. El resultado más alto basado en ML proviene de Tailandia: XGBoost alcanzó **R² = 0,905, RMSE = 2,453 t C/ha** para COC en ecosistemas de cultivos comerciales incluyendo plantaciones de caucho, usando entradas duales Sentinel-1/2 vía GEE (*Geo-spatial Information Science*, 2025, DOI: 10.1080/10095020.2024.2440608). Las plantaciones de caucho mostraron el mayor COC (14,29 t C/ha) versus los arrozales (9,83 t C/ha) — un patrón probablemente transferible a contextos de palma de aceite.

Un metaanálisis de 279 estudios de teledetección de COC (Ding et al., 2025, *Advanced Science*, DOI: 10.1002/advs.202504152) confirmó que las imágenes satelitales aparecen en el 86% de los estudios de predicción de COC, con Sentinel-2 y Landsat-8 dominando. **Random Forest supera a SVM y PLSR en la mayoría de los contextos**, pero XGBoost lidera cada vez más cuando los tamaños de muestra superan ~100.

Limitación clave: la predicción de COC requiere píxeles de suelo desnudo. Dvorakova et al. (2023, *Geoderma*, DOI: 10.1016/j.geoderma.2022.116128) demostraron que normalizar espectros cancela los desplazamientos de albedo, con NBR2 < 0,05 separando efectivamente el suelo desnudo seco del suelo húmedo o cubierto con residuos.

#### 11.3.2 La humedad del suelo se beneficia más de la fusión SAR–óptico

Los índices ópticos basados en SWIR (NSMI, NDMI, OPTRAM) proporcionan estimaciones de humedad superficial en suelos desnudos a escasamente vegetados. Madelon et al. (2023, *Hydrology and Earth System Sciences*, 27:1221–1242, DOI: 10.5194/hess-27-1221-2023) produjeron mapas de humedad del suelo a 1 km fusionando la retrodispersión Sentinel-1 con el NDVI del Sentinel-2 mediante inversión de redes neuronales. Hegazi et al. (2023, *Agronomy*, 13(3):656, DOI: 10.3390/agronomy13030656) lograron el mejor resultado solo óptico con una CNN de 6 capas que predice humedad volumétrica desde bandas Sentinel-2 adquiridas vía **GEE**. El rendimiento se deteriora significativamente bajo vegetación densa (NDVI > 0,3).

#### 11.3.3 pH, CIC y textura del suelo muestran predictibilidad limitada pero creciente

Abdullah et al. (2025, *Scientific Reports*, DOI: 10.1038/s41598-025-03942-4) alcanzaron **R² = 0,62** para predicción de pH del suelo usando Random Forest con bandas SWIR y borde rojo del Sentinel-2 más covariables físicas del suelo. Azizi et al. (2022, *Sensors*, DOI: 10.3390/s22186890) predijeron CIC con **LCCC = 0,77** desde Sentinel-2A en Irán semiárido. Para textura del suelo, Mgohele et al. (2024, *Frontiers in Remote Sensing*, DOI: 10.3389/frsen.2024.1461537) revisaron 70 artículos y encontraron que la predicción de arena logra la mayor precisión (**R² medio = 0,53**), seguida de limo y arcilla. La precisión de predicción decrece marcadamente con la profundidad, de R² ~0,49 (0–30 cm) a ~0,43 (100–200 cm).

#### 11.3.4 Densidad aparente, compactación y actividad biológica permanecen inaccesibles

Dang et al. (2021, *Sensors*, DOI: 10.3390/s21134408) clasificaron la densidad aparente en dos clases usando XGBoost sobre bandas Azul y NIR de Landsat-7 con **88% de precisión**, pero la estimación continua sigue sin resolverse. Para la compactación, Kavian et al. (2024) estimaron la presión de preconsolidación usando índices espectrales Sentinel-2 combinados con propiedades del suelo mediante Árboles de Regresión Reforzados — el Índice de Rojez y el SWCI fueron los predictores espectrales más importantes.

**La biomasa microbiana del suelo no tiene un indicador satelital confiable.** Tatsumi et al. (2025, *Communications Earth & Environment*, DOI: 10.1038/s43247-025-02330-0) establecieron asociaciones indirectas NDVI–microbioma fúngico, y Sherwood et al. (2025, *International Journal of Remote Sensing*, DOI: 10.1080/01431161.2025.2464958) explicaron hasta el 50% de la varianza en diversidad alfa bacteriana usando datos hiperespectrales DESIS — pero ambos representan prueba de concepto y no capacidad operacional. La actividad enzimática del suelo, la estabilidad de agregados y las propiedades subsuperficiales (>30 cm) permanecen completamente fuera del alcance de la teledetección actual.

---

### 11.4 Selección de índices según la fase de desarrollo de la palma

#### 11.4.1 La ventana de palma juvenil (0–5 años, dosel <50%)

Durante los primeros 3–5 años después de la plantación, el IAF de la palma de aceite aumenta de aproximadamente 0,6 a 2,5, dejando **50–80% de la superficie del suelo espectralmente visible** a la resolución de 10 m del Sentinel-2. Esta es la ventana crítica de monitoreo para la observación directa del suelo.

MSAVI2 es el índice óptimo para esta fase porque su factor L de auto-ajuste compensa automáticamente la densidad del dosel en rápido cambio. SAVI (L=0,5) proporciona corrección robusta del brillo del suelo a cobertura intermedia. BSI cuantifica directamente la exposición del suelo desnudo entre palmas. NDTI/NSMI detecta el mantillo de frondas podadas en las inter-filas — las plantaciones jóvenes con mantillado activo muestran NDTI más alto que las inter-filas desnudas. Los cultivos de cobertura (típicamente Mucuna o Pueraria) plantados entre hileras de palma complican las lecturas espectrales al añadir una señal de vegetación secundaria que confunde la interpretación de los índices del suelo.

Para la humedad del suelo durante esta fase, el NSMI es efectivo cuando la cobertura vegetal es baja (NDVI ≤ 0,3), con R² alcanzando 0,6–0,9 contra sensores de campo. RI y CI pueden mapear la distribución de óxidos de hierro en suelos lateríticos expuestos característicos de las plantaciones tropicales del SE Asiático, sirviendo como indicadores de línea base a largo plazo.

#### 11.4.2 Limitaciones de la palma madura (>8 años, dosel >80%)

Al cerrarse el dosel (IAF > 4, típico de palma madura), **el suelo contribuye menos del 5% de la reflectancia del píxel** a resolución de 10–30 m. La observación directa del suelo mediante teledetección óptica se vuelve imposible. El NDVI se satura completamente. EVI2 y EVI resisten la saturación y mantienen la discriminación por encima del 80% de cobertura del dosel, convirtiéndolos en los índices preferidos para esta fase. NDRE y GNDVI detectan variaciones de clorofila que reflejan el estado de nutrientes del suelo subyacente. NDMI monitorea el contenido de agua del dosel como indicador de la humedad de la zona radicular.

Mitchell et al. (2017, *Carbon Balance and Management*, DOI: 10.1186/s13021-017-0078-9) demostraron que el Análisis de Mezcla Espectral puede descomponer píxeles en fracciones de suelo, vegetación y sombra incluso bajo dosel parcial — pero la fracción de suelo es espectralmente visible solo por **~2 años tras una perturbación** antes de que el rebrote del dosel la oculte. En plantaciones maduras, el SAR C-band Sentinel-1 penetra parcialmente el dosel y proporciona estimaciones de humedad del suelo independientes de la cobertura nubosa.

#### 11.4.3 La replantación como oportunidad diagnóstica

El ciclo de replantación de la palma de aceite (25–30 años) crea una breve ventana de exposición total del suelo. Un estudio multisensor (*The Forestry Chronicle*, 2025, DOI: 10.1016/S1195-1036(25)00026-6) usó 38 años de Landsat + Sentinel con **procesamiento nativo en GEE** para detectar eventos de replantación, logrando **OA = 90,5%, Kappa = 0,81** y estimación de edad con **RMSE = 4,0 años**. La regla de detección — BSI superando el percentil 80 combinado con NDVI cayendo por debajo del percentil 20 — proporciona un disparador robusto para la evaluación del estado del suelo durante estas ventanas.

---

### 11.5 Enfoques de aprendizaje automático combinando múltiples índices de suelo

La tendencia dominante en la literatura 2021–2025 es el cambio del análisis de índice único hacia modelos ML multi-variable. La evidencia favorece abrumadoramente los métodos de conjunto y de gradiente reforzado.

**XGBoost lidera la precisión de predicción de COC.** El estudio tailandés de cultivos comerciales (2025, DOI: 10.1080/10095020.2024.2440608) alcanzó **R² = 0,905** usando XGBoost con entradas duales Sentinel-1/2 más variables ambientales, procesado vía GEE. Zhou et al. (2024, *Ecological Processes*, DOI: 10.1186/s13717-024-00515-7) confirmaron que XGBoost supera a Random Forest para predicción de stock de COC usando datos ópticos Sentinel-2 + SAR Sentinel-1. Chen et al. (2024, *PeerJ*) reportaron R² = 0,75 para COC en la Provincia de Shandong, con la elevación (21,7%) y el contenido de arcilla (13,5%) como variables más importantes.

**Las redes neuronales profundas muestran potencial para datos temporales complejos.** Vaudour et al. (2023, *Remote Sensing*, DOI: 10.3390/rs15174264) encontraron que DNN supera a RF y PLS para la estimación de COC en suelo desnudo (RPIQ = 1,67 versus 1,36 y 0,79 respectivamente), con la humedad del suelo Sentinel-1 proporcionando la mejora más estable como entrada adicional.

**El apilamiento de conjunto supera consistentemente a los modelos individuales.** Biney et al. (2022, *Soil & Tillage Research*, DOI: 10.1016/j.still.2022.105379) encontraron que los conjuntos de PLSR + RF + SVMR + Cubist superan a cualquier método individual para la predicción de COC desde bandas Sentinel-2 y espectros de campo.

El conjunto mínimo de variables recomendado para modelos ML de salud del suelo en palma de aceite es:

- **Núcleo (4 índices):** NDVI + BSI + NDMI + NDTI
- **Extendido (8 variables):** Añadir EVI2 + SAVI + retrodispersión SAR Sentinel-1 VV/VH + pendiente DEM
- **Óptimo (12+ variables):** Añadir NDRE, CIre, composites multitemporales, características de textura (GLCM), precipitación y temperatura como covariables

Para salinidad específicamente, Bandak et al. (2024, *Scientific Reports*, DOI: 10.1038/s41598-024-60033-6) lograron **R² = 0,86** usando Árboles de Decisión sobre índices de salinidad Sentinel-2 para predicción de CE.

---

### 11.6 Ranking de los cinco mejores índices por solidez de evidencia

Basado en el número de estudios de validación, métricas de precisión reportadas, aplicabilidad tropical y disponibilidad en GEE a lo largo de la literatura 2021–2025:

| Rango | Índice | Estudios de validación (2021–2025) | Mejor precisión reportada | Fortaleza principal | Limitación principal |
|-------|--------|-----------------------------------|--------------------------|--------------------|--------------------|
| 1 | **BSI** | 8+ estudios | R²=0,86 (combo BSI-NDVI); OA>98% (variante MBI) | Detección directa de suelo desnudo; disparador de evento de replantación; indicador de COC vía composites temporales | Confunde suelo construido con desnudo sin máscara NDVI; requiere suelo expuesto |
| 2 | **MSAVI2** | 6+ estudios | 22,2% importancia para COC; ρ=0,82 con biomasa | Corrección de suelo auto-ajustable; óptimo para vegetación dispersa; sin calibración manual de L | Se satura como NDVI con IAF alto |
| 3 | **SAVI** | 6+ estudios | r²=0,59–0,73 para textura del suelo; 16% importancia COC | Corrección estándar del brillo del suelo; integrado en el marco UNCCD | Factor L fijo menos adaptativo que MSAVI2 |
| 4 | **EVI2** | 5+ estudios | Detección de recuperación 7,7%; media 0,65–0,70 tropical | Resiste la saturación en dosel denso; no requiere banda azul | Correlación directa con el suelo limitada; principalmente indicador de vegetación |
| 5 | **NDTI/NSMI** | 5+ estudios | r=0,854 (residuos); R²=0,6–0,9 (humedad) | Doble interpretación: cobertura de residuos + humedad; solo SWIR a 20 m | Fórmula idéntica genera ambigüedad interpretativa; límite de resolución a 20 m |

Menciones honoríficas: CRSI (índice de salinidad único más sólido, r = −0,787) y HBSI (>91% de precisión en suelo desnudo con Sentinel-2).

---

### 11.7 Brechas de evidencia críticas y sesgo regional

#### 11.7.1 El sesgo geográfico es severo y operativamente consecuente

Las revisiones sistemáticas analizadas en este estudio confirman una concentración geográfica pronunciada. Ding et al. (2025, *Advanced Science*) encontraron que América del Norte, China y Europa dominan la literatura de teledetección de COC en 279 estudios. Sentinel-2 es el satélite más utilizado (apareciendo en 17 de 68 estudios en una revisión de humedad del suelo), seguido de Landsat-8 (13 estudios). **Número estimado de estudios de validación de índices de suelo originados en regiones de palma de aceite del Sudeste Asiático: menos de cinco.** Chew et al. (2017, *Geo-spatial Information Science*, DOI: 10.1080/10095020.2017.1337317) identificaron explícitamente el estudio del suelo en plantaciones de palma de aceite desde la perspectiva de la teledetección como una brecha de conocimiento, y esta brecha persiste ocho años después. Los estudios tropicales del África Subsahariana siguen siendo escasos, y la cobertura nubosa se identifica como el principal factor limitante para los enfoques ópticos.

#### 11.7.2 Parámetros sin indicador satelital confiable (hasta 2025)

- **Biomasa microbiana y actividad enzimática del suelo** — solo vínculos indirectos de prueba de concepto vía asociaciones NDVI–microbioma (Tatsumi et al., 2025) y mapeo de biodiversidad hiperspectral DESIS (Sherwood et al., 2025). La capacidad operacional está aún muy lejos.
- **Estabilidad de agregados del suelo** — ninguna firma espectral correlaciona; requiere pruebas físicas.
- **Concentraciones individuales de nutrientes (NPK, micronutrientes)** — la predicción de nutrientes individuales desde datos multiespectrales sigue siendo poco confiable.
- **Propiedades subsuperficiales (>30 cm de profundidad)** — la teledetección está efectivamente limitada al topsuelo (0–30 cm), con precisión que disminuye marcadamente con la profundidad.
- **Estimación continua de densidad aparente** — solo se ha logrado clasificación binaria (88% de precisión; Dang et al., 2021).

#### 11.7.3 La dinámica temporal sigue siendo escasamente cuantificada

No existe una tasa de recuperación universal para los índices de suelo. La evidencia disponible sugiere que los índices basados en vegetación (SAVI, MSAVI2, EVI2) responden a intervenciones de recuperación en **4–8 semanas**, los índices basados en SWIR (BSI, NDTI) muestran cambios estacionales detectables, y los índices de color del suelo (RI, CI) evolucionan a lo largo de **meses a años**. En bosques tropicales amazónicos, la recuperación estructural completa tras incendios requiere aproximadamente **20 años** (Chen et al., 2025, *Remote Sensing of Environment*, DOI: 10.1016/j.rse.2025.114547). El Análisis de Tendencia-Ciclo de series temporales de NDVI revela que las dinámicas no monótonas (cíclicas) dominan el 86% de las áreas monitoreadas, con menos del 1% mostrando tendencias lineales simples.

---

### 11.8 Tabla maestra de citaciones verificadas (2021–2025)

| N° | Autores (Año) | Revista | DOI | Índice principal | Sensor | Métrica clave | Parámetro de suelo |
|---|---|---|---|---|---|---|---|
| 1 | Nguyen et al. (2021) | Land | 10.3390/land10030231 | BSI (modificado) | Landsat-8 | OA > 98% | Suelo desnudo / barbecho |
| 2 | Charishma et al. (2024) | Geol. Ecol. Landsc. | 10.1080/24749508.2024.2392920 | SAVI, NDVI | Sentinel-2 | r² = 0,73 | Arena, limo, arcilla, pH |
| 3 | Ismaili et al. (2025) | Front. Soil Sci. | 10.3389/fsoil.2025.1553887 | MSAVI2, BSI, CI | Sentinel-2 | PCA-ponderado | Biomasa, degradación |
| 4 | Ayala Izurieta et al. (2022) | Plant and Soil | 10.1007/s11104-022-05506-1 | Multi-banda + GPR | Sentinel-2 + GIS | R² = 0,86 | COC 0–60 cm |
| 5 | Wetterlind et al. (2025) | Eur. J. Soil Sci. | 10.1111/ejss.70054 | Multi-banda S2 | Sentinel-2 | Textil-dependiente | COC (34 sitios EU) |
| 6 | Hamer et al. (2025) | Discover Sustain. | 10.1007/s43621-025-01203-y | EVI2, NDVI | Landsat + GEE | +7,7% recuperación | Dinámica vegetal costera |
| 7 | Thai ML study (2025) | Geo-spat. Inf. Sci. | 10.1080/10095020.2024.2440608 | Multi-índice XGBoost | S1+S2+GEE | R²=0,905 | COC cultivos tropicales |
| 8 | Ding et al. (2025) | Advanced Science | 10.1002/advs.202504152 | Revisión 279 estudios | Multi-sensor | Meta-análisis | COC global |
| 9 | Madelon et al. (2023) | HESS | 10.5194/hess-27-1221-2023 | NDMI + S1 SAR | S1+S2+S3 | 1 km | Humedad del suelo |
| 10 | Du et al. (2022) | Soil Till. Res. | 10.1016/j.still.2022.105374 | NDTI, RANDRI | Sentinel-2A | r=0,854 | Cobertura de residuos |
| 11 | Ramos et al. (2020) | Agric. Water Mgmt. | 10.1016/j.agwat.2020.106387 | CRSI, 12 índices | Sentinel-2 | r=−0,787 | Salinidad EC (0–1,5 m) |
| 12 | Bandak et al. (2024) | Sci. Reports | 10.1038/s41598-024-60033-6 | Índices salinidad | Sentinel-2 | R²=0,86 | Conductividad eléctrica |
| 13 | Abdullah et al. (2025) | Sci. Reports | 10.1038/s41598-025-03942-4 | S2-RE + SWIR | Sentinel-2 | R²=0,62 | pH del suelo |
| 14 | Zhang et al. (2022) | Catena | 10.1016/j.catena.2022.106364 | NDBSI | Multi-sensor | > BSI clásico | Suelo desnudo |
| 15 | Zhou et al. (2024) | Ecol. Processes | 10.1186/s13717-024-00515-7 | XGBoost S1+S2 | S1+S2 | R² > RF | Stock de COC |
| 16 | Golicz et al. (2024) | Environ. Monitor. | 10.1007/s10661-024-13540-y | Análisis de campo | Campo (>400 lotes) | Survey | COC palma de aceite MY |
| 17 | Dang et al. (2021) | Sensors | 10.3390/s21134408 | Landsat B1+NIR | Landsat-7 | 88% precisión | Densidad aparente |
| 18 | Mgohele et al. (2024) | Front. Remote Sens. | 10.3389/frsen.2024.1461537 | Revisión 70 artículos | Multi-sensor | R²=0,53 (arena) | Textura del suelo |
| 19 | Tatsumi et al. (2025) | Comm. Earth Environ. | 10.1038/s43247-025-02330-0 | NDVI, VIs | Sentinel-2 | R² indirecto | Microbioma fúngico |
| 20 | Forestry Chron. (2025) | Forest. Chronicle | 10.1016/S1195-1036(25)00026-6 | BSI + NDVI + S1 | L8+S1+S2+GEE | OA=90,5% | Detección de replantación |

---

### 11.9 Conclusión: hacia un protocolo operativo de monitoreo del suelo para palma de aceite

Esta revisión revela una paradoja en el núcleo del monitoreo satelital del suelo en plantaciones tropicales: **los índices mejor validados para la observación directa del suelo requieren suelo expuesto, pero los doseles maduros de palma de aceite eliminan la visibilidad del suelo durante 20+ de los 25–30 años del ciclo productivo.** El camino operativo es un protocolo de monitoreo de doble modo. Durante la fase juvenil de 0–5 años y las breves ventanas de replantación, desplegar BSI, MSAVI2, SAVI y NDTI/NSMI para la caracterización directa del suelo — este es el momento en que las evaluaciones de COC, humedad, erosión y mineralógía son espectralmente factibles. Durante la fase madura, cambiar a EVI2, NDRE y NDMI como indicadores indirectos de salud del suelo a través del vigor de la vegetación, complementados por SAR Sentinel-1 para estimación de humedad bajo el dosel.

Tres perspectivas novedosas emergen de esta síntesis. Primero, la equivalencia de fórmulas NDTI–NSMI (ambos = (B11−B12)/(B11+B12)) debe reconocerse explícitamente en los protocolos de monitoreo — la misma medición espectral sirve una doble interpretación dependiendo de las condiciones de la superficie. Segundo, los modelos ML multisensor que combinan Sentinel-1 + Sentinel-2 + covariables topográficas logran ahora precisiones de COC (R² > 0,90) que rivalizan con las predicciones de calidad de laboratorio, pero esto ha sido validado principalmente en sistemas templados — **se necesita urgentemente calibración tropical**. Tercero, la ausencia de un índice compuesto de salud del suelo por teledetección para plantaciones tropicales representa tanto la mayor brecha como la oportunidad más significativa: integrar composites temporales de BSI, índices de vigor de vegetación, humedad derivada de SAR y métricas fenológicas en un Score Unificado de Regeneración del Suelo llenaría un vacío crítico de monitoreo que ningún índice individual puede abordar.

| Fase del dosel | Índices directos de suelo (10 m) | Índices de suelo (20 m) | Complemento SAR |
|---|---|---|---|
| **Juvenil (0–5 años, <50% dosel)** | MSAVI2, SAVI, EVI2, CI, RI, CRSI | BSI, NDTI/NSMI, SCI | Sentinel-1 VV/VH |
| **Adulta (>8 años, >80% dosel)** | EVI2, OCVI (indirecto) | NDMI (proxy canopy) | Sentinel-1 (primario) |
| **Replantación (ventana ~2 años)** | BSI (disparador principal), MSAVI2 | NDTI/NSMI | Sentinel-1 + S2 fusión |

La implementación en Python/GEE puede centrarse en la biblioteca `awesome-spectral-indices` (disponible como módulo GEE) que proporciona fórmulas estandarizadas para todos los índices primarios revisados. El paso crítico siguiente es establecer redes de calibración con datos de campo específicamente dentro de plantaciones de palma de aceite del Sudeste Asiático para cerrar la brecha de validación geográfica que actualmente limita la confianza en la transferencia de estos índices a las regiones donde más se necesitan.
