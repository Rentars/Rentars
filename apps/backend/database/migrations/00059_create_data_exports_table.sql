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
