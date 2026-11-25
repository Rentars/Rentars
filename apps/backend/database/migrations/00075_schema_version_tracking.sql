-- Migration 00075: Schema version tracking and migration history
-- Creates infrastructure to track applied migrations and validate ordering

CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  migration_name VARCHAR(255) NOT NULL UNIQUE,
  migration_prefix INT NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(100) DEFAULT CURRENT_USER
);

CREATE INDEX idx_schema_migrations_prefix ON schema_migrations(migration_prefix);
CREATE INDEX idx_schema_migrations_applied_at ON schema_migrations(applied_at);

COMMENT ON TABLE schema_migrations IS 'Tracks applied database migrations with checksums for drift detection';
COMMENT ON COLUMN schema_migrations.migration_name IS 'Full migration filename without extension';
COMMENT ON COLUMN schema_migrations.migration_prefix IS 'Numeric prefix for ordering validation';
COMMENT ON COLUMN schema_migrations.checksum IS 'SHA-256 checksum of migration file content';
