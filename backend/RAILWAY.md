# Despliegue backend en Railway

Este backend queda preparado para Railway con `rootDir=backend` y rutas de datos/resultados persistentes.

## 1) Servicio API (web)

- Crea un servicio desde este repo.
- Configura **Root Directory**: `backend`.
- Railway detecta `backend/railway.json` y usa:
  - `startCommand`: `bash scripts/railway_web.sh`

Variables mínimas:

- `ENV=production`
- `SECRET_KEY=<valor-seguro>`
- `DATABASE_URL=<postgres de Railway>`
- `REDIS_URL=<redis de Railway>`

Persistencia:

- Agrega un **Volume** al servicio.
- Define `RAILWAY_VOLUME_MOUNT_PATH` con la ruta de montaje del volumen (por ejemplo `/data`).
- El backend usará: `${RAILWAY_VOLUME_MOUNT_PATH}/storage`.

## 2) Servicio worker (Celery)

Crea otro servicio (mismo repo, también con `rootDir=backend`) y usa como start command:

```bash
bash scripts/railway_worker.sh
```

Debe tener las mismas variables que el servicio web (`DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`, `RAILWAY_VOLUME_MOUNT_PATH`) y usar el mismo volumen/ruta para compartir resultados.

## 3) Verificación rápida

- API health: `GET /health`
- Crear proyecto y ejecutar flujo Soil+ / preprocess.
- Confirmar archivos en `.../storage/tenant_X/project_Y/...` (misma estructura para API y worker).
