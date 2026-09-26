-- Migration: 00057_add_admin_roles
-- Expands the user role system from a single 'admin' value to a set of
-- least-privilege admin sub-roles.  Existing 'admin' users are untouched.
-- New roles: moderator, support, finance.

-- Add a CHECK constraint that accepts all known roles
-- (replaces or extends any existing role constraint).
DO $$
BEGIN
  -- Remove old constraint if it exists so we can replace it
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
END $$;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('tenant', 'host', 'admin', 'moderator', 'support', 'finance'));

COMMENT ON COLUMN users.role IS
  'Platform role: tenant | host | admin | moderator | support | finance. '
  'Admin sub-roles grant access to specific admin scopes defined in adminScopes.ts.';

-- Index for fast role lookups (admin panel user listing)
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
