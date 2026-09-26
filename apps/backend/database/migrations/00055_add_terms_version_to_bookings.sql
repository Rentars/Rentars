-- Migration: 00055_add_terms_version_to_bookings
-- Stores the platform-policy version string and acceptance timestamp that the
-- tenant agreed to when creating a booking. A later policy update must never
-- change the terms of an existing booking.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS terms_version       TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted_at   TIMESTAMPTZ;

-- Back-fill existing rows so they are not null (they pre-date versioned terms).
UPDATE bookings
SET
  terms_version     = 'pre-versioning',
  terms_accepted_at = created_at
WHERE terms_version IS NULL;

COMMENT ON COLUMN bookings.terms_version IS
  'Platform policy version string accepted by the tenant at booking time (e.g. "2026-09-24.1"). Immutable after creation.';

COMMENT ON COLUMN bookings.terms_accepted_at IS
  'UTC timestamp when the tenant explicitly accepted the terms. Immutable after creation.';
