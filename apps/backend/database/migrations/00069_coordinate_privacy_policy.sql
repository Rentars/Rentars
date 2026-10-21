-- Migration 00069: Coordinate privacy policy
--
-- Adds:
--   property_timezone   — IANA timezone for the property (used in ICS exports)
--   coordinate_access_log — audit trail when exact coordinates are accessed
--
-- The coordinate_access_log table enforces the policy that exact coordinates
-- are only accessed in two legitimate circumstances:
--   1. The property owner/host views their own listing.
--   2. A tenant with a Pending or Confirmed booking navigates to the property.
--
-- This table is append-only and feeds the access-review dashboards.
-- It is NOT used to gate access (the application layer does that via
-- viewerHasExactLocationAccess); it exists for audit and anomaly detection.

-- ── Property timezone ─────────────────────────────────────────────────────────
-- Stores the IANA timezone for each property so calendar exports (ICS) can
-- emit local dates that survive DST changes without relying on the viewer's
-- system clock.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC'
    CHECK (timezone IS NULL OR length(timezone) > 0);

-- Backfill existing rows with UTC as a safe default.
UPDATE properties SET timezone = 'UTC' WHERE timezone IS NULL;

-- NOT NULL after backfill.
ALTER TABLE properties ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE properties ALTER COLUMN timezone SET DEFAULT 'UTC';

-- ── Coordinate access log ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coordinate_access_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  viewer_id   UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  -- Precision tier granted: 'host' or 'booking'
  -- ('public' tier is never logged — no exact coordinates are revealed)
  tier        TEXT        NOT NULL
                CHECK (tier IN ('host', 'booking')),
  -- Booking that justified the 'booking' tier (null for 'host' tier)
  booking_id  UUID        REFERENCES bookings(id) ON DELETE SET NULL,
  -- Source endpoint / context that triggered the access
  context     VARCHAR(120),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the audit dashboard queries.
CREATE INDEX IF NOT EXISTS idx_cal_property_id   ON coordinate_access_log (property_id);
CREATE INDEX IF NOT EXISTS idx_cal_viewer_id     ON coordinate_access_log (viewer_id);
CREATE INDEX IF NOT EXISTS idx_cal_accessed_at   ON coordinate_access_log (accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_tier          ON coordinate_access_log (tier);

-- ── calendar_feed_tokens ───────────────────────────────────────────────────────
-- Persistent, rotatable tokens for calendar subscription URLs.
-- Replaces the stateless HMAC approach so tokens can be individually revoked.

CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(64) NOT NULL UNIQUE,
  -- Absolute revocation: once revoked, the token can no longer be used.
  revoked     BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Optional expiry; NULL means no expiry (perpetual until manually revoked).
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cft_user_id   ON calendar_feed_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_cft_token     ON calendar_feed_tokens (token);
CREATE INDEX IF NOT EXISTS idx_cft_expires_at ON calendar_feed_tokens (expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE calendar_feed_tokens IS
  'Persistent calendar feed tokens. Rotatable and revocable per user.';
