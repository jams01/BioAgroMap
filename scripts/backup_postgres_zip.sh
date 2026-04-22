#!/usr/bin/env bash
# Volcado SQL de la base BioAgroMap (Postgres/PostGIS) y empaquetado en .zip.
# Por defecto usa el servicio ``postgres`` de Docker Compose en la raíz del repo
# (levanta el contenedor si está parado). Si Docker no está disponible, intenta
# ``pg_dump`` contra localhost:5433 (puerto del compose en el host).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

POSTGRES_DB="${POSTGRES_DB:-bioagromap}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5433}"

if [[ -f .env ]]; then
  set +u
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  set -u
fi

NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    -h|--help)
      echo "Uso: $0 [--no-start]"
      echo "  Genera backups/bioagromap_backup_YYYYMMDD_HHMMSS.zip (pg_dump -F p)."
      echo "  Variables: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, BACKUP_OUT_DIR, POSTGRES_HOST, POSTGRES_PORT"
      echo "  --no-start  No ejecuta «docker compose up -d postgres» si el servicio está parado."
      exit 0
      ;;
  esac
done

OUT_DIR="${BACKUP_OUT_DIR:-$ROOT/backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_NAME="bioagromap_${STAMP}.sql"
ZIP_NAME="bioagromap_backup_${STAMP}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

wait_docker_ready() {
  local i
  for i in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ensure_docker_postgres() {
  if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$NO_START" -eq 1 ]]; then
    echo "Error: postgres en Docker no está en marcha. Arranca con: docker compose up -d postgres" >&2
    exit 1
  fi
  echo "Levantando servicio postgres (Docker)..." >&2
  docker compose up -d postgres
  if ! wait_docker_ready; then
    echo "Error: PostgreSQL en Docker no respondió a tiempo." >&2
    exit 1
  fi
}

dump_via_docker() {
  docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-acl -F p >"$TMP/$DUMP_NAME"
}

dump_via_host() {
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "Error: no hay «pg_dump» en PATH y Docker no se pudo usar." >&2
    exit 1
  fi
  echo "Volcando vía pg_dump ${POSTGRES_HOST}:${POSTGRES_PORT}..." >&2
  export PGPASSWORD="$POSTGRES_PASSWORD"
  pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-acl -F p -f "$TMP/$DUMP_NAME"
}

use_docker=0
if docker info >/dev/null 2>&1 && [[ -f docker-compose.yml ]]; then
  if docker compose config --services 2>/dev/null | grep -qx postgres; then
    use_docker=1
  fi
fi

if [[ "$use_docker" -eq 1 ]]; then
  ensure_docker_postgres
  dump_via_docker
else
  dump_via_host
fi

if [[ ! -s "$TMP/$DUMP_NAME" ]]; then
  echo "Error: el archivo SQL generado está vacío." >&2
  exit 1
fi

( cd "$TMP" && zip -q "$ZIP_PATH" "$DUMP_NAME" )
echo "Copia generada: $ZIP_PATH"
