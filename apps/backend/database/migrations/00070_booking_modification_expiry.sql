-- #759: Implement booking modifications with repricing — proposal expiry.
--
-- booking_modifications (00062_booking_modifications_snapshot.sql) already
-- carries the proposal, its immutable before/after snapshot, and repricing
-- columns. What's missing is a lifecycle for proposals nobody acts on: an
-- open date-change request should not sit "pending" forever, implicitly
-- holding the tenant's expectation of the new dates with no host decision.
--
-- Adds an expiry timestamp set at request time and extends the status enum
-- with 'expired' so the cleanup sweep in booking.service.ts can close out
-- abandoned proposals without ever touching the underlying booking's dates
-- or financial history — only the proposal row changes.

ALTER TABLE booking_modifications
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE booking_modifications
  DROP CONSTRAINT IF EXISTS booking_modifications_status_check;

ALTER TABLE booking_modifications
  ADD CONSTRAINT booking_modifications_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired'));

-- Only pending proposals are ever swept, so keep the index small.
CREATE INDEX IF NOT EXISTS idx_booking_modifications_pending_expiry
  ON booking_modifications (expires_at)
  WHERE status = 'pending';
