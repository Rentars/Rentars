-- Enhance saved_searches table with pause/resume and digest frequency
-- Adds:
-- - is_paused: pause notifications without deleting
-- - digest_frequency: 'immediate', 'daily', 'weekly'
-- - updated_at: track last modification
-- - version: for validation consistency

ALTER TABLE saved_searches
  ADD COLUMN IF NOT EXISTS is_paused BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(20) DEFAULT 'immediate',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- Update RLS policy to allow UPDATE
DROP POLICY IF EXISTS saved_searches_update_own ON saved_searches;
CREATE POLICY saved_searches_update_own ON saved_searches
  FOR UPDATE USING (auth.uid() = user_id);

-- Add trigger for updated_at
DROP TRIGGER IF EXISTS trg_saved_searches_updated_at ON saved_searches;
CREATE OR REPLACE FUNCTION update_saved_searches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  NEW.version = NEW.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_saved_searches_updated_at
BEFORE UPDATE ON saved_searches
FOR EACH ROW
EXECUTE FUNCTION update_saved_searches_updated_at();

-- Add digest_frequency to notification_preferences
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS saved_search_digest_frequency VARCHAR(20) DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS quiet_hours_start TIME,
  ADD COLUMN IF NOT EXISTS quiet_hours_end TIME;

CREATE INDEX IF NOT EXISTS idx_saved_searches_is_paused ON saved_searches(is_paused, user_id);
CREATE INDEX IF NOT EXISTS idx_saved_searches_digest_frequency ON saved_searches(digest_frequency);
