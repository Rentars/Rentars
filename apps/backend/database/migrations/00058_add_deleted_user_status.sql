-- Migration: 00058_add_deleted_user_status
-- Adds 'deleted' as a valid user status for GDPR/privacy account deletion flow.
-- Also adds a soft-delete index used by the privacy data-export and auth flows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_status_check;
  END IF;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'suspended', 'deleted'));

-- Partial index: exclude deleted accounts from normal auth lookups
CREATE INDEX IF NOT EXISTS idx_users_email_active
  ON users(email)
  WHERE status <> 'deleted';

COMMENT ON COLUMN users.status IS
  'active | suspended | deleted. Deleted accounts have PII anonymised but record is retained for financial compliance.';
