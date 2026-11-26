-- Migration: 00058_add_deleted_user_status
-- Adds 'deleted' as a valid user status for GDPR/privacy account deletion flow.
-- Also adds a soft-delete index used by the privacy data-export and auth flows.
-- Adds moderation reversibility columns (suspension/restoration audit trail).

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

-- Moderation reversibility: capture who suspended/restored a user, when, and why.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
  ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restored_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restoration_reason TEXT;

COMMENT ON COLUMN users.suspension_reason IS
  'Operator-provided reason recorded when the account was suspended.';
COMMENT ON COLUMN users.suspended_by IS
  'Operator (admin user) who applied the suspension.';
COMMENT ON COLUMN users.suspended_at IS
  'Timestamp when the suspension was applied.';
COMMENT ON COLUMN users.restored_by IS
  'Operator (admin user) who restored the account.';
COMMENT ON COLUMN users.restored_at IS
  'Timestamp when the account was restored.';
COMMENT ON COLUMN users.restoration_reason IS
  'Operator-provided reason recorded when the account was restored.';

-- Index for active/suspended lookups used by moderation and auth flows.
CREATE INDEX IF NOT EXISTS idx_users_status_active_suspended
  ON users(status)
  WHERE status IN ('active', 'suspended');