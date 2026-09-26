-- Enhance audit_logs table with correlation IDs, success tracking, and bulk operation support.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS success BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS target_ids UUID[] DEFAULT '{}';

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_action ON audit_logs(actor_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_desc ON audit_logs(created_at DESC);
