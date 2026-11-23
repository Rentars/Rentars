-- Migration: Create data_exports table for privacy data export requests
-- Purpose: Track asynchronous data export requests with expiration

CREATE TABLE IF NOT EXISTS data_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')) DEFAULT 'pending',
  export_url TEXT,
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups by user
CREATE INDEX idx_data_exports_user_id ON data_exports(user_id);

-- Index for status-based queries
CREATE INDEX idx_data_exports_status ON data_exports(status);

-- Index for cleanup queries (expired exports)
CREATE INDEX idx_data_exports_expires_at ON data_exports(expires_at);

-- Extend data_exports to support report/analytics exports with short-lived,
-- ownership-checked downloads and audit metadata.
ALTER TABLE data_exports
  ADD COLUMN IF NOT EXISTS dataset TEXT,
  ADD COLUMN IF NOT EXISTS role TEXT,
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS token_hash TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Backfill ownership from the requesting user for existing rows
UPDATE data_exports
SET owner_id = user_id
WHERE owner_id IS NULL;

-- Index for validating short-lived download tokens
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_exports_token_hash
  ON data_exports(token_hash)
  WHERE token_hash IS NOT NULL;

-- Index for expiry-based lookups and cleanup of report exports
CREATE INDEX IF NOT EXISTS idx_data_exports_owner_expires_at
  ON data_exports(owner_id, expires_at);

-- Index for auditing sensitive exports by dataset
CREATE INDEX IF NOT EXISTS idx_data_exports_dataset
  ON data_exports(dataset)
  WHERE dataset IS NOT NULL;