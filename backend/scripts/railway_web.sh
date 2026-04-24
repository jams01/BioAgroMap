#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Railway expone PORT; default local 8000.
PORT="${PORT:-8000}"

# STORAGE_PATH explícito para mantener datos/resultados bajo el volumen persistente.
if [[ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]]; then
  export STORAGE_PATH="${STORAGE_PATH:-${RAILWAY_VOLUME_MOUNT_PATH}/storage}"
else
  export STORAGE_PATH="${STORAGE_PATH:-/data/storage}"
fi
mkdir -p "${STORAGE_PATH}"

alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
