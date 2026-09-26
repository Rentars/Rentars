-- Enhance reports table for moderation workflow
-- Adds moderator assignment, evidence support, appeal handling, and visibility rules

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS appeal_status VARCHAR(20) DEFAULT 'none' CHECK (appeal_status IN ('none', 'pending', 'approved', 'denied')),
  ADD COLUMN IF NOT EXISTS appeal_reason TEXT,
  ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS hide_property BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS host_notified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_host BOOLEAN DEFAULT true;

-- Update type for status to include appeal states
DROP CONSTRAINT IF EXISTS reports_status_check ON reports;
ALTER TABLE reports
  ADD CONSTRAINT reports_status_check
    CHECK (status IN ('pending', 'resolved', 'dismissed', 'escalated'));

-- Trigger for visibility changes: when hide_property = true, hide property from search
-- This logic is handled in the application layer for now but index is prepared
CREATE INDEX IF NOT EXISTS idx_reports_hide_property
  ON reports(target_id, hide_property)
  WHERE hide_property = true AND target_type = 'property';

-- Index for moderator assignment
CREATE INDEX IF NOT EXISTS idx_reports_assigned_to
  ON reports(assigned_to)
  WHERE assigned_to IS NOT NULL;

-- Index for appeals
CREATE INDEX IF NOT EXISTS idx_reports_appeal_status
  ON reports(appeal_status)
  WHERE appeal_status != 'none';

-- Add severity index for triage
CREATE INDEX IF NOT EXISTS idx_reports_severity
  ON reports(severity, status)
  WHERE status = 'pending';

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_reports_updated_at ON reports;
CREATE TRIGGER trg_update_reports_updated_at
BEFORE UPDATE ON reports
FOR EACH ROW
EXECUTE FUNCTION update_reports_updated_at();
