-- 00069_escrow_reconciliation_durability.sql (#877)
--
-- Adds durable attempt metadata for escrow reconciliation so retries survive
-- process restarts and ambiguous/permanent failures can be routed to manual
-- review distinct from a confirmed on-chain failure.
--
-- Forward-only, additive (nullable columns / safe default), idempotent via
-- IF NOT EXISTS so it is safe to re-run.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reconcile_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_last_error_class TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_last_safe_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_recovered_notified_at TIMESTAMPTZ;

-- Index to efficiently select only bookings whose backoff window has elapsed.
CREATE INDEX IF NOT EXISTS idx_bookings_reconcile_next_attempt
  ON bookings (reconcile_next_attempt_at)
  WHERE status = 'pending' AND escrow_hash IS NOT NULL;

COMMENT ON COLUMN bookings.reconcile_next_attempt_at IS
  'Earliest time the next reconciliation attempt may run (exponential backoff). #877';
COMMENT ON COLUMN bookings.reconcile_last_error_class IS
  'Last error classification observed: transient | ambiguous | permanent. #877';
COMMENT ON COLUMN bookings.reconcile_provider_event_id IS
  'Last blockchain/provider event id processed for this booking, for idempotent dedup. #877';
COMMENT ON COLUMN bookings.reconcile_last_safe_state IS
  'Last known-safe booking status before entering a failure/review path, used to recover cleanly. #877';
COMMENT ON COLUMN bookings.escrow_manual_review_at IS
  'Set when a booking is routed to manual review (ambiguous or exhausted-but-unconfirmed failures). #877';
