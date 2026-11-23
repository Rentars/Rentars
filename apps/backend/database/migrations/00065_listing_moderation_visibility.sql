-- #753: Separate moderation visibility from soft deletion.
--
-- Hiding a listing for moderation must not look like a host deletion, so that
-- lifting a hide never resurrects a listing the host removed. Visibility is
-- therefore tracked in its own column.
--
-- Legacy note: earlier builds hid listings by setting deleted_at. Those rows keep
-- deleted_at and are not converted automatically; a moderator must review them.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS moderation_state      VARCHAR(20) NOT NULL DEFAULT 'visible'
    CHECK (moderation_state IN ('visible', 'hidden')),
  ADD COLUMN IF NOT EXISTS moderation_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_properties_moderation_state
  ON properties(moderation_state);

COMMENT ON COLUMN properties.moderation_state IS
  'Public visibility set by moderation decisions. Independent of deleted_at (host removal) and draft_status.';

-- #979: Optimistic concurrency and audit metadata for bulk moderation.
--
-- Bulk admin actions must only apply to the explicitly selected current listing
-- versions. A monotonically increasing `version` column lets update services
-- detect stale selections (the row changed since the admin loaded it) and report
-- per-item failures instead of silently overwriting a newer review.
--
-- `moderation_reason` and `moderation_updated_by` capture why a status change was
-- made and who made it, so each applied change can be audited.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS version              INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS moderation_reason    TEXT,
  ADD COLUMN IF NOT EXISTS moderation_updated_by UUID;

COMMENT ON COLUMN properties.version IS
  'Optimistic concurrency token. Incremented on moderation-relevant updates so stale bulk selections can be detected.';
COMMENT ON COLUMN properties.moderation_reason IS
  'Reason supplied by the moderator for the most recent status/visibility change.';
COMMENT ON COLUMN properties.moderation_updated_by IS
  'Admin user who applied the most recent moderation change.';

-- Filtered moderation queues commonly filter on visibility plus listing status.
CREATE INDEX IF NOT EXISTS idx_properties_moderation_state_status
  ON properties(moderation_state, status);

-- Increment `version` whenever a moderation-relevant field changes. This keeps
-- the token authoritative regardless of which code path performs the update.
CREATE OR REPLACE FUNCTION properties_bump_moderation_version()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.moderation_state      IS DISTINCT FROM OLD.moderation_state
     OR NEW.status             IS DISTINCT FROM OLD.status
     OR NEW.draft_status       IS DISTINCT FROM OLD.draft_status
     OR NEW.deleted_at         IS DISTINCT FROM OLD.deleted_at
     OR NEW.moderation_reason  IS DISTINCT FROM OLD.moderation_reason
     OR NEW.moderation_updated_by IS DISTINCT FROM OLD.moderation_updated_by
  THEN
    NEW.version := COALESCE(OLD.version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_bump_moderation_version ON properties;

CREATE TRIGGER trg_properties_bump_moderation_version
  BEFORE UPDATE ON properties
  FOR EACH ROW
  EXECUTE FUNCTION properties_bump_moderation_version();