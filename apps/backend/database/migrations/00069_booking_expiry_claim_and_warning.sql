-- #758: Expire abandoned pending bookings safely.
--
-- The cleanup job previously selected stale Pending bookings and then wrote
-- `status = 'Expired'` unconditionally. That left two gaps:
--
--   1. Two overlapping runs of the job (or a run racing a late payment
--      confirmation) could both act on the same row — the second write has
--      nothing to check against, so duplicate history/notifications or a
--      lost confirmation were both possible.
--   2. There was no way to warn a tenant that their hold was about to expire
--      without re-notifying them on every subsequent scheduler tick.
--
-- This migration adds the column the warning step claims, and documents the
-- indexed `expires_at` column (added in 00062_booking_expiry_and_timeout.sql)
-- that the claim-based cleanup in booking.service.ts now also keys off of.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS expiry_warning_sent_at TIMESTAMPTZ;

-- Only Pending bookings are ever warned, so keep the index small.
CREATE INDEX IF NOT EXISTS idx_bookings_expiry_warning_pending
  ON bookings (expires_at)
  WHERE status = 'Pending' AND expiry_warning_sent_at IS NULL;
