-- #941: Booking modification as a transactional workflow.
--
-- acceptModification() already calls accept_booking_modification_atomic(), but
-- no migration ever defined it. Without the RPC the whole date/price change
-- fails (or, if callers fall back to plain updates, dates and totals drift
-- apart). This migration defines the single authoritative acceptance path:
--
--   * participant approval: the proposal must belong to the booking tenant
--     (the host accepting is authenticated by the service layer);
--   * state machine: only Pending/Confirmed bookings with a pending, unexpired
--     proposal can be accepted; no other status may be modified;
--   * availability: re-checked under a per-property advisory lock, so a new
--     reservation is secured before the old dates are released (they are the
--     same row, updated in one statement under the exclusion constraint);
--   * money: the recomputed total, delta and adjustment state are written in
--     the same transaction as the dates;
--   * audit: the pre-change snapshot stays on the proposal and the final
--     booking snapshot + history row are written atomically with it.
--
-- Rejection/expiry never touch the booking: the service declines/expire only
-- the proposal row.

ALTER TABLE booking_modifications
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_booking_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS payment_adjustment_status VARCHAR(20) NOT NULL DEFAULT 'none';

ALTER TABLE booking_modifications
  DROP CONSTRAINT IF EXISTS booking_modifications_payment_adjustment_status_check;

ALTER TABLE booking_modifications
  ADD CONSTRAINT booking_modifications_payment_adjustment_status_check
    CHECK (payment_adjustment_status IN ('none', 'pending', 'captured', 'refunded', 'failed'));

COMMENT ON COLUMN booking_modifications.booking_snapshot IS
  'Immutable snapshot of the booking before the proposed change.';
COMMENT ON COLUMN booking_modifications.final_booking_snapshot IS
  'Auditable snapshot of the booking after an accepted change; written atomically with the change.';

CREATE OR REPLACE FUNCTION accept_booking_modification_atomic(
  p_booking_id                 UUID,
  p_modification_id            UUID,
  p_check_in                   DATE,
  p_check_out                  DATE,
  p_total_price                NUMERIC,
  p_guest_count                INTEGER DEFAULT NULL,
  p_new_total_price            NUMERIC DEFAULT NULL,
  p_price_delta                NUMERIC DEFAULT NULL,
  p_requires_additional_payment BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking        bookings%ROWTYPE;
  v_modification   booking_modifications%ROWTYPE;
  v_updated        bookings%ROWTYPE;
BEGIN
  -- Lock the booking first to learn its property, then serialise all writes
  -- for that property (same lock used by create_booking_atomic_v2).
  SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(
    ('x' || substr(md5(v_booking.property_id::text), 1, 16))::bit(64)::bigint
  );

  SELECT * INTO v_modification
    FROM booking_modifications
   WHERE id = p_modification_id AND booking_id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODIFICATION_NOT_FOUND';
  END IF;

  if v_modification.status <> 'pending'
     OR (v_modification.expires_at IS NOT NULL AND v_modification.expires_at <= NOW()) THEN
    RAISE EXCEPTION 'MODIFICATION_NOT_PENDING';
  END IF;

  -- Only the booking tenant may propose; only modifiable bookings may change.
  IF v_modification.requested_by IS DISTINCT FROM v_booking.tenant_id THEN
    RAISE EXCEPTION 'MODIFICATION_NOT_A_PARTICIPANT';
  END IF;
  IF v_booking.status NOT IN ('Pending', 'Confirmed') THEN
    RAISE EXCEPTION 'BOOKING_STATUS_NOT_MODIFIABLE';
  END IF;
  IF p_check_in IS NULL OR p_check_out IS NULL OR p_check_in >= p_check_out THEN
    RAISE EXCEPTION 'MODIFICATION_INVALID_DATES';
  END IF;

  -- The proposal's dates must not have been tampered with after validation.
  IF v_modification.requested_start IS DISTINCT FROM p_check_in
     OR v_modification.requested_end IS DISTINCT FROM p_check_out THEN
    RAISE EXCEPTION 'MODIFICATION_DATES_CHANGED';
  END IF;

  -- Authoritative availability check under the lock. The exclusion constraint
  -- is still the final guard; this gives a stable, tenant-safe error first.
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE property_id = v_booking.property_id
      AND id <> p_booking_id
      AND status IN ('Pending', 'Confirmed', 'Completed', 'Disputed')
      AND check_in < p_check_out AND check_out > p_check_in
  ) OR EXISTS (
    SELECT 1 FROM availability_ranges
    WHERE property_id = v_booking.property_id
      AND is_available = FALSE
      AND start_date < p_check_out AND end_date > p_check_in
  ) THEN
    RAISE EXCEPTION 'BOOKING_CONFLICT: requested dates are no longer available';
  END IF;

  BEGIN
    UPDATE bookings
       SET check_in = p_check_in,
           check_out = p_check_out,
           total_price = COALESCE(p_new_total_price, p_total_price),
           guest_count = COALESCE(p_guest_count, guest_count),
           updated_at = NOW()
     WHERE id = p_booking_id
     RETURNING * INTO v_updated;
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'BOOKING_CONFLICT: requested dates are no longer available';
  END;

  UPDATE booking_modifications
     SET status = 'accepted',
         new_total_price = COALESCE(p_new_total_price, p_total_price),
         price_delta = p_price_delta,
         requires_additional_payment = COALESCE(p_requires_additional_payment, FALSE),
         payment_adjustment_status = CASE
           WHEN COALESCE(p_price_delta, 0) > 0 THEN 'pending'
           WHEN COALESCE(p_price_delta, 0) < 0 THEN 'refunded'
           ELSE 'none'
         END,
         resolved_at = NOW(),
         final_booking_snapshot = to_jsonb(v_updated),
         updated_at = NOW()
   WHERE id = p_modification_id;

  INSERT INTO booking_status_history (booking_id, status, from_status, changed_by, reason, notes)
  VALUES (
    p_booking_id,
    v_booking.status,
    v_booking.status,
    v_modification.requested_by,
    'booking_modification_accepted',
    format('Modification %s: %s -> %s, total %s -> %s (delta %s)',
           p_modification_id, v_booking.check_in, p_check_in,
           v_booking.total_price, v_updated.total_price, p_price_delta)
  );

  RETURN to_jsonb(v_updated);
END;
$$;

REVOKE ALL ON FUNCTION accept_booking_modification_atomic(
  UUID, UUID, DATE, DATE, NUMERIC, INTEGER, NUMERIC, NUMERIC, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_booking_modification_atomic(
  UUID, UUID, DATE, DATE, NUMERIC, INTEGER, NUMERIC, NUMERIC, BOOLEAN
) TO service_role;
