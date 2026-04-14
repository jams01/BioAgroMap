#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${POSTGRES_DB:-bioagromap}"
DB_USER="${POSTGRES_USER:-postgres}"
DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"

echo "[1/4] Installing PostgreSQL and PostGIS..."
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib postgis

echo "[2/4] Creating database user/password..."
sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';" || true

echo "[3/4] Creating database and enabling extensions..."
sudo -u postgres createdb "${DB_NAME}" -O "${DB_USER}" || true
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS postgis_raster;"

echo "[4/4] Applying base schema..."
sudo -u postgres psql -d "${DB_NAME}" -f infrastructure/postgres/init.sql

echo "PostGIS local setup completed."
