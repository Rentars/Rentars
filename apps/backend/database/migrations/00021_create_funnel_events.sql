-- Migration: 00021_create_funnel_events.sql
--
-- Creates the funnel_events table for structured analytics event tracking
-- as specified in docs/ANALYTICS_TAXONOMY.md.
--
-- Privacy rules enforced here:
--   * user_id is nullable — events from opted-out or unauthenticated users
--     store NULL rather than a real user identifier.
--   * No columns that store wallet private keys, message content, or raw PII.
--   * A retention trigger automatically purges rows older than the configured
--     retention window (default: 24 months for funnel events).
--   * A deduplication trigger drops duplicate booking/payment events within
--     a 60-second window to prevent double-counting on retries.

-- ─── User analytics opt-out preferences ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_analytics_preferences (
  user_id       UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  opted_out     BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_analytics_preferences IS
  'Stores each user''s analytics opt-out state. When opted_out=true, '
  'new funnel_events rows are recorded without user_id.';

-- ─── Funnel events ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS funnel_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event name from the taxonomy in docs/ANALYTICS_TAXONOMY.md
  -- e.g. 'search.executed', 'booking.confirmed', 'payment.escrow_released'
  event         TEXT        NOT NULL CHECK (length(event) BETWEEN 3 AND 128),

  -- Pseudonymous session identifier — never a real user identity on its own.
  -- Generated client-side (e.g. crypto.randomUUID()) and stored in sessionStorage.
  session_id    TEXT        NOT NULL CHECK (length(session_id) BETWEEN 8 AND 128),

  -- Nullable: NULL when user is unauthenticated or has opted out.
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Event-specific payload validated by the application before insert.
  -- Must not contain wallet keys, message bodies, or full PII.
  properties    JSONB       NOT NULL DEFAULT '{}',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE funnel_events IS
  'Structured analytics events following the taxonomy in docs/ANALYTICS_TAXONOMY.md. '
  'Server-side confirmation events only — no client-only funnel events.';

COMMENT ON COLUMN funnel_events.user_id IS
  'NULL when user is unauthenticated or has opted out of analytics. '
  'Never join this to users in external dashboards — use aggregate views only.';

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Primary query pattern: recent events of a specific type
CREATE INDEX IF NOT EXISTS idx_funnel_events_event_created
  ON funnel_events (event, created_at DESC);

-- Session-level funnel queries
CREATE INDEX IF NOT EXISTS idx_funnel_events_session_created
  ON funnel_events (session_id, created_at DESC);

-- User-level queries (ops/support — never BI dashboards)
CREATE INDEX IF NOT EXISTS idx_funnel_events_user_id_created
  ON funnel_events (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Booking-specific event lookup
CREATE INDEX IF NOT EXISTS idx_funnel_events_booking_id
  ON funnel_events ((properties->>'booking_id'))
  WHERE properties ? 'booking_id';

-- ─── Retention enforcement ───────────────────────────────────────────────────

-- A scheduled job (e.g. pg_cron, application scheduler) should call
-- purge_stale_funnel_events() nightly.  The retention windows match
-- docs/ANALYTICS_TAXONOMY.md Section "Retention policy".

CREATE OR REPLACE FUNCTION purge_stale_funnel_events()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Booking and payment events: 24-month retention
  DELETE FROM funnel_events
  WHERE event LIKE 'booking.%' OR event LIKE 'payment.%' OR event LIKE 'cancellation.%'
    AND created_at < NOW() - INTERVAL '24 months';

  -- Search events: 12-month retention
  DELETE FROM funnel_events
  WHERE event LIKE 'search.%'
    AND created_at < NOW() - INTERVAL '12 months';

  -- Listing/view events: 6-month retention
  DELETE FROM funnel_events
  WHERE event LIKE 'listing.%'
    AND created_at < NOW() - INTERVAL '6 months';
END;
$$;

COMMENT ON FUNCTION purge_stale_funnel_events IS
  'Deletes funnel_events rows that exceed their retention window. '
  'Call nightly via pg_cron or the application cleanup scheduler.';

-- ─── Deduplication for booking/payment events ─────────────────────────────────
-- Drops duplicate insert attempts within a 60-second window for the same
-- (event, booking_id) pair.  Prevents double-counting on client retries.

CREATE OR REPLACE FUNCTION funnel_events_dedup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  booking_id TEXT;
BEGIN
  -- Only deduplicate events that carry a booking_id
  booking_id := NEW.properties->>'booking_id';
  IF booking_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM funnel_events
    WHERE event = NEW.event
      AND properties->>'booking_id' = booking_id
      AND created_at > NOW() - INTERVAL '60 seconds'
  ) THEN
    RETURN NULL;  -- Silently discard duplicate
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_funnel_events_dedup ON funnel_events;
CREATE TRIGGER trg_funnel_events_dedup
  BEFORE INSERT ON funnel_events
  FOR EACH ROW
  EXECUTE FUNCTION funnel_events_dedup();

-- ─── Pre-aggregated view (for BI dashboards — no raw user_id) ────────────────

CREATE OR REPLACE VIEW analytics_funnel_daily AS
SELECT
  date_trunc('day', created_at)::DATE  AS event_date,
  event,
  COUNT(*)                              AS event_count,
  COUNT(DISTINCT session_id)            AS unique_sessions
FROM funnel_events
GROUP BY 1, 2;

COMMENT ON VIEW analytics_funnel_daily IS
  'Pre-aggregated daily funnel event counts. Safe for BI dashboards — '
  'no user_id or session_id exposed.';

-- Search analytics also gets a purge hook aligned with its 12-month window.
-- (search_analytics table was created in 00014_search_analytics_and_geolocation.sql)
CREATE OR REPLACE FUNCTION purge_stale_search_analytics()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM search_analytics
  WHERE created_at < NOW() - INTERVAL '12 months';
END;
$$;

COMMENT ON FUNCTION purge_stale_search_analytics IS
  'Deletes search_analytics rows older than 12 months. Call nightly.';
