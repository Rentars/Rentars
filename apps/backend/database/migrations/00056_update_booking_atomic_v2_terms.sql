-- Migration: 00056_update_booking_atomic_v2_terms
-- Extend create_booking_atomic_v2 to accept and store terms_version and
-- terms_accepted_at so that every new booking atomically records the accepted
-- policy snapshot. Old calls without these params use safe defaults.

CREATE OR REPLACE FUNCTION create_booking_atomic_v2(
  p_property_id        UUID,
  p_tenant_id          UUID,
  p_check_in           DATE,
  p_check_out          DATE,
  p_total_price        NUMERIC,
  p_guest_count        INTEGER,
  p_rules_acknowledged_at TIMESTAMPTZ DEFAULT NULL,
  p_terms_version      TEXT         DEFAULT NULL,
  p_terms_accepted_at  TIMESTAMPTZ  DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id UUID;
BEGIN
  -- Conflict check: reject if any non-cancelled booking overlaps these dates
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE property_id = p_property_id
      AND status <> 'Cancelled'
      AND check_in  < p_check_out
      AND check_out > p_check_in
  ) THEN
    RAISE EXCEPTION 'BOOKING_CONFLICT';
  END IF;

  -- Host-block check: reject if any availability_overrides block these dates
  IF EXISTS (
    SELECT 1 FROM availability_overrides
    WHERE property_id = p_property_id
      AND is_blocked  = TRUE
      AND start_date  < p_check_out
      AND end_date    > p_check_in
  ) THEN
    RAISE EXCEPTION 'BOOKING_BLOCKED';
  END IF;

  INSERT INTO bookings (
    property_id,
    tenant_id,
    check_in,
    check_out,
    total_price,
    guest_count,
    status,
    rules_acknowledged_at,
    terms_version,
    terms_accepted_at
  ) VALUES (
    p_property_id,
    p_tenant_id,
    p_check_in,
    p_check_out,
    p_total_price,
    p_guest_count,
    'Pending',
    p_rules_acknowledged_at,
    COALESCE(p_terms_version, 'pre-versioning'),
    COALESCE(p_terms_accepted_at, NOW())
  )
  RETURNING id INTO v_booking_id;

  RETURN v_booking_id;
END;
$$;
