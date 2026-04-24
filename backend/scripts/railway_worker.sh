#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]]; then
  export STORAGE_PATH="${STORAGE_PATH:-${RAILWAY_VOLUME_MOUNT_PATH}/storage}"
else
  export STORAGE_PATH="${STORAGE_PATH:-/data/storage}"
fi
mkdir -p "${STORAGE_PATH}"

celery -A app.tasks.celery_app.celery_app worker --loglevel=info --concurrency=1 --max-tasks-per-child=2
