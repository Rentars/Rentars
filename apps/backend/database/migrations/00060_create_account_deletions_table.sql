-- Migration: Create account_deletions table for privacy account deletion requests
-- Purpose: Track account deletion requests with cancellation window

CREATE TABLE IF NOT EXISTS account_deletions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'failed')) DEFAULT 'pending',
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  cancel_token TEXT NOT NULL,
  cancel_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for efficient lookups by user
CREATE INDEX idx_account_deletions_user_id ON account_deletions(user_id);

-- Index for status-based queries
CREATE INDEX idx_account_deletions_status ON account_deletions(status);

-- Index for cleanup queries (expired cancellation windows)
CREATE INDEX idx_account_deletions_cancel_expires_at ON account_deletions(cancel_expires_at);
