-- Migration 00067: Transactional notification outbox
--
-- An outbox row is written in the SAME database transaction as the domain
-- event (booking created, dispute opened, etc.).  A background worker polls
-- this table, delivers the notification, and marks the row delivered.
--
-- Guarantees:
--   - A committed domain transaction → outbox row is guaranteed to exist.
--   - A rolled-back domain transaction → no outbox row (atomicity).
--   - Worker restarts do not deliver duplicates beyond provider guarantees
--     because each row carries an idempotency_key.
--   - Permanent failures move rows to dead_letter status after max_attempts.

CREATE TABLE IF NOT EXISTS notification_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipient user.
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Notification type (matches NotificationType union in notification.service.ts).
  type              VARCHAR(80) NOT NULL,

  -- Notification payload stored as JSONB — same shape as notifications.data.
  data              JSONB NOT NULL DEFAULT '{}',

  -- Delivery channels requested for this notification.
  -- Array of: 'in_app' | 'email' | 'push'
  channels          TEXT[] NOT NULL DEFAULT ARRAY['in_app'],

  -- Idempotency key — a stable identifier that prevents duplicate delivery
  -- if the worker restarts mid-batch.
  -- Convention: <event_type>:<source_entity_id>:<user_id>
  idempotency_key   TEXT NOT NULL,

  -- Row status lifecycle:
  --   pending      → awaiting first delivery attempt
  --   processing   → claimed by a worker (with acquired_at set)
  --   delivered    → all channels delivered successfully
  --   failed       → at least one channel failed, will retry
  --   dead_letter  → exhausted max_attempts; needs manual review
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',

  -- Delivery attempt tracking.
  attempt_count     SMALLINT NOT NULL DEFAULT 0,
  max_attempts      SMALLINT NOT NULL DEFAULT 5,

  -- Timestamps.
  scheduled_for     TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- earliest delivery time
  acquired_at       TIMESTAMPTZ,                          -- when worker claimed the row
  delivered_at      TIMESTAMPTZ,                          -- when fully delivered
  failed_at         TIMESTAMPTZ,                          -- when last attempt failed
  dead_lettered_at  TIMESTAMPTZ,                          -- when moved to dead_letter

  -- Last error message for debugging.
  last_error        TEXT,

  -- Whether this is a mandatory notification (dispute/security) that must
  -- be delivered through at least one channel regardless of preferences.
  mandatory         BOOLEAN NOT NULL DEFAULT FALSE,

  -- The domain event that caused this outbox entry (for traceability).
  source_event      VARCHAR(80),
  source_id         UUID,      -- booking_id, report_id, etc.

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique idempotency key prevents double-inserts from retry logic.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_notification_outbox_idempotency
  ON notification_outbox (idempotency_key);

-- Worker polling index: fetch pending/failed rows that are due and not
-- yet exhausted, ordered by priority (mandatory first) then age.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_poll
  ON notification_outbox (status, scheduled_for)
  WHERE status IN ('pending', 'failed') AND attempt_count < max_attempts;

-- Support queries: all outbox entries for a user.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_user
  ON notification_outbox (user_id, created_at DESC);

-- Dead-letter admin view.
CREATE INDEX IF NOT EXISTS idx_notification_outbox_dead_letter
  ON notification_outbox (dead_lettered_at DESC)
  WHERE status = 'dead_letter';

COMMENT ON TABLE notification_outbox IS
  'Transactional outbox for reliable notification delivery. '
  'Rows are written atomically with domain events; a background worker '
  'polls and delivers them with retry and dead-letter handling.';

COMMENT ON COLUMN notification_outbox.mandatory IS
  'When TRUE this notification must reach the user regardless of their '
  'preference settings (e.g. dispute opened, account security alert). '
  'The worker must deliver through the best available channel.';

COMMENT ON COLUMN notification_outbox.idempotency_key IS
  'Stable key preventing duplicate delivery across worker restarts. '
  'Convention: <source_event>:<source_id>:<user_id>';
