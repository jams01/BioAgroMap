#!/usr/bin/env bash
# Arranque en Render: migraciones, worker Celery en segundo plano, API en primer plano.
set -euo pipefail
cd "$(dirname "$0")/.."
alembic upgrade head
celery -A app.tasks.celery_app.celery_app worker --loglevel=info --concurrency=1 --max-tasks-per-child=2 &
CELERY_PID=$!
cleanup() { kill "$CELERY_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
