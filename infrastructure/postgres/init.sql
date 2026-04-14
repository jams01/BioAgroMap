CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_raster;

CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    hashed_password VARCHAR(255) NOT NULL,
    tenant_id INT NOT NULL REFERENCES tenants(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tenant_id INT NOT NULL REFERENCES tenants(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS layers (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id),
    tenant_id INT NOT NULL REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    geom_type VARCHAR(50) DEFAULT 'Geometry',
    geom geometry,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raster_layers (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id),
    tenant_id INT NOT NULL REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    cog_path TEXT,
    rast raster,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_results (
    id SERIAL PRIMARY KEY,
    project_id INT NOT NULL REFERENCES projects(id),
    tenant_id INT NOT NULL REFERENCES tenants(id),
    model_type VARCHAR(120) NOT NULL,
    status VARCHAR(50) NOT NULL,
    output_path TEXT,
    metrics JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layers_geom_gist ON layers USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_raster_layers_rast_gist ON raster_layers USING GIST (st_convexhull(rast));
