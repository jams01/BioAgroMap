# BioAgroMap SaaS MVP

MVP funcional para portal geoespacial agrícola con arquitectura SaaS multi-tenant:

- Backend `FastAPI` + `Celery` + `Redis`
- IA en microservicio Python (`PyTorch`, `OpenCV`, `rasterio`)
- Base espacial `PostgreSQL + PostGIS + postgis_raster`
- Frontend `React + Vite + Mapbox GL`
- Observabilidad con `Prometheus + Grafana`

## Estructura

```text
/backend
/ai_service
/frontend
/infrastructure
/scripts
/data
```

## Requisitos

- Docker + Docker Compose
- (Opcional local) Ubuntu/Debian para script de PostgreSQL local

## Opcion 1: levantar con Docker (recomendado)

1. Copiar variables:
   - `cp .env.example .env`
2. Levantar stack:
   - `docker compose up -d`
3. Generar raster de ejemplo:
   - `docker compose exec backend python -c "import numpy as np,rasterio; from rasterio.transform import from_origin; import pathlib; p=pathlib.Path('/data/sample/agri_sample.tif'); p.parent.mkdir(parents=True,exist_ok=True); d=(np.random.rand(256,256)*255).astype('uint8'); t=from_origin(-74.2,4.8,0.0005,0.0005); with rasterio.open(p,'w',driver='GTiff',height=256,width=256,count=1,dtype=d.dtype,crs='EPSG:4326',transform=t) as dst: dst.write(d,1); print(p)"`
4. Servicios:
   - Backend: `http://localhost:8000/docs`
   - IA: `http://localhost:8001/docs`
   - Frontend: `http://localhost:5173`
   - Prometheus: `http://localhost:9090`
   - Grafana: `http://localhost:3000`
5. PostgreSQL expuesto en host:
   - `localhost:5433`

En el contenedor `backend`, `rasterio` y el resto de dependencias ya vienen instalados desde `backend/requirements.txt`.

### Backend con venv local (sin Docker)

Si corres la API en la máquina host, no uses el `python3` del sistema a pelo: instala el entorno del proyecto:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -c "import rasterio; print('rasterio', rasterio.__version__)"
```

`rasterio` está fijado en `requirements.txt`. Si el comando anterior falla, revisa que estés en el venv activado o, con Docker, usa el mismo intérprete que el servicio: `docker compose exec backend python -c "import rasterio"`.

## Opcion 2: PostgreSQL/PostGIS local Linux

```bash
chmod +x scripts/setup_postgis_local.sh
./scripts/setup_postgis_local.sh
```

Este script instala PostgreSQL, habilita extensiones `postgis` y `postgis_raster`, crea base y aplica esquema.

## Despliegue: Vercel (frontend) y Render (API + Celery)

### Render (backend)

1. En [Render](https://render.com): **New → Blueprint**, conecta este repositorio y deja que use `render.yaml` en la raíz.
2. El blueprint crea Postgres, Redis (Key Value) y un servicio web `bioagromap-api` que ejecuta migraciones, **Celery y FastAPI en el mismo dyno** (así comparten el mismo filesystem local; en Render no se puede compartir un disco entre un web y un worker separados sin almacenamiento externo).
3. Cuando el deploy termine, copia la URL pública del servicio (p. ej. `https://bioagromap-api.onrender.com`).
4. Variables que puedes ajustar en el dashboard: `CORS_ORIGINS` (añade tu dominio de producción si no es `*.vercel.app`), `MAX_UPLOAD_MB`, `COPERNICUS_*` si usas descargas Sentinel, etc. `CORS_ORIGIN_REGEX` por defecto permite orígenes `https://…vercel.app` (incluye previews).

### Vercel (frontend)

1. **New Project** en [Vercel](https://vercel.com), mismo repositorio.
2. **Root Directory**: `frontend` (importante: el `package.json` del cliente está ahí).
3. **Environment variables** (Production y Preview): `VITE_API_URL` = la URL del API en Render **sin barra final** (p. ej. `https://bioagromap-api.onrender.com`). El cliente añade `/api/v1` automáticamente.
4. `frontend/vercel.json` define la regla SPA para React Router (todas las rutas van a `index.html`).

El microservicio de IA (`ai_service`) y Mapbox no forman parte de este blueprint; en local siguen en Docker Compose.

## Endpoints clave (`/api/v1`)

- `POST /auth/register`
- `POST /auth/login`
- `POST /projects`
- `GET /projects`
- `POST /upload-shapefile`
- `POST /upload-raster`
- `GET /raster/{project_id}`
- `POST /ai/predict`
- `GET /ai/results/{project_id}`

## Flujo end-to-end

1. Registrar usuario (crea tenant)
2. Login
3. Crear proyecto
4. Subir raster/shapefile
   - Vector de ejemplo: `data/sample/fields.geojson`
   - Raster de ejemplo: `/data/sample/agri_sample.tif` (paso de generacion)
5. Procesamiento async (Celery)
6. Ejecutar prediccion IA
7. Visualizar resultados en frontend

## Multi-tenancy

- Cada entidad funcional usa `tenant_id`
- El middleware de autenticacion extrae tenant desde JWT
- Consultas filtran por tenant para aislamiento lógico

## Raster y geoprocesamiento

- Soporta subida de `GeoTIFF`, `JP2`, `PNG`, `JPG`
- Worker crea variante tipo COG (GTiff comprimido + tiled)
- Metadatos raster/vector se guardan en PostGIS

## Testing

Backend:

```bash
cd backend
pip install -r requirements.txt
pytest -q
```

## CI/CD

`/.github/workflows/ci.yml` ejecuta tests de backend en cada push/PR.

## Produccion (base)

- Manifest K8s inicial en `infrastructure/k8s/backend-deployment.yaml`
- Escalado horizontal del backend mediante replicas
- Recomendada separacion en imagenes versionadas por servicio
