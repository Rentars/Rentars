-- #942: every accepted booking status transition writes one durable history row.
--
-- The service validates allowed transitions, then calls this RPC so the booking
-- update and its history entry commit in the same transaction. A stale status
-- claim returns NULL (no row changed, no history written).

CREATE OR REPLACE FUNCTION transition_booking_status_atomic(
  p_booking_id   UUID,
  p_from_status  TEXT,
  p_to_status    TEXT,
  p_changed_by   UUID,
  p_reason       TEXT DEFAULT NULL,
  p_extra        JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated   BOOKINGS%ROWTYPE;
  v_cancelled TIMESTAMPTZ;
  v_refund    NUMERIC;
  v_dispute_reason TEXT;
  v_dispute_status TEXT;
BEGIN
  -- Only whitelisted lifecycle metadata may be set alongside the status.
  v_cancelled      := NULLIF(p_extra ->> 'cancelled_at', '')::timestamptz;
  v_refund         := NULLIF(p_extra ->> 'refund_amount', '')::numeric;
  v_dispute_reason := NULLIF(p_extra ->> 'dispute_reason', '');
  v_dispute_status := NULLIF(p_extra ->> 'dispute_status', '');

  UPDATE bookings
     SET status           = p_to_status,
         cancelled_at     = COALESCE(v_cancelled, cancelled_at),
         refund_amount    = COALESCE(v_refund, refund_amount),
         dispute_reason   = COALESCE(v_dispute_reason, dispute_reason),
         dispute_status   = COALESCE(v_dispute_status, dispute_status),
         updated_at       = NOW()
   WHERE id = p_booking_id
     AND status = p_from_status
  RETURNING * INTO v_updated;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO booking_status_history (booking_id, from_status, status, changed_by, reason, notes)
  VALUES (p_booking_id, p_from_status, p_to_status, p_changed_by, p_reason, p_reason);

  RETURN to_jsonb(v_updated);
END;
$$;

COMMENT ON FUNCTION transition_booking_status_atomic(UUID, TEXT, TEXT, UUID, TEXT, JSONB) IS
  'Atomically claims a booking status transition and records exactly one history entry.';
