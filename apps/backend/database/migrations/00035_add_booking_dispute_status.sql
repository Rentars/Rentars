-- Add dispute workflow fields to bookings
-- dispute_status: none | raised | under_review | decision_recorded | settled | settlement_failed
--   none               -> no dispute has been opened
--   raised             -> dispute opened by a participant
--   under_review       -> admin/reviewer is actively reviewing
--   decision_recorded  -> a resolution decision exists but financial action not verified
--   settled            -> decision recorded AND financial action (refund/release) completed
--   settlement_failed  -> decision recorded but financial action failed

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(20) DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_bookings_dispute_status ON bookings(dispute_status);

-- ---------------------------------------------------------------------------
-- Authoritative dispute status mapping
-- ---------------------------------------------------------------------------
-- The participant-facing dispute status is derived from the decision history
-- joined with the verified payment/refund state. This function centralises the
-- mapping so the read model and any application code agree on the semantics.
--
-- Inputs:
--   p_has_dispute       -> a dispute record exists for the booking
--   p_under_review      -> the dispute is currently under review
--   p_has_decision      -> a resolution decision has been recorded
--   p_financial_state   -> 'none' | 'pending' | 'completed' | 'failed'
--                          (derived from payments / refund_requests)
CREATE OR REPLACE FUNCTION dispute_status_from_state(
  p_has_dispute BOOLEAN,
  p_under_review BOOLEAN,
  p_has_decision BOOLEAN,
  p_financial_state TEXT
) RETURNS VARCHAR(20) AS $$
BEGIN
  IF NOT COALESCE(p_has_dispute, FALSE) THEN
    RETURN 'none';
  END IF;

  IF NOT COALESCE(p_has_decision, FALSE) THEN
    IF COALESCE(p_under_review, FALSE) THEN
      RETURN 'under_review';
    END IF;
    RETURN 'raised';
  END IF;

  -- A decision has been recorded; settlement is a separate event.
  CASE COALESCE(p_financial_state, 'none')
    WHEN 'completed' THEN
      RETURN 'settled';
    WHEN 'failed' THEN
      RETURN 'settlement_failed';
    ELSE
      -- 'pending' or 'none' (action not yet initiated/verified)
      RETURN 'decision_recorded';
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Participant-safe dispute timeline read model
-- ---------------------------------------------------------------------------
-- Joins dispute decision history with verified payment/refund state so that
-- participants can distinguish a recorded decision from completed settlement.
-- Deliberately excludes internal evidence and reviewer notes.
--
-- Assumes the following tables exist (created in earlier migrations):
--   disputes(id, booking_id, status, opened_at, under_review_at, decided_at,
--            resolved_at, ...)
--   payments(id, booking_id, status, amount, created_at, updated_at, ...)
--   refund_requests(id, booking_id, status, amount, created_at, updated_at, ...)
--
-- The view is intentionally conservative: financial state is only reported as
-- 'completed' when the underlying payment/refund record is verified as such.
CREATE OR REPLACE VIEW booking_dispute_timeline AS
WITH dispute_state AS (
  SELECT
    d.booking_id,
    TRUE AS has_dispute,
    BOOL_OR(d.status = 'under_review') AS under_review,
    BOOL_OR(d.decided_at IS NOT NULL) AS has_decision,
    MIN(d.opened_at) AS opened_at,
    MIN(d.under_review_at) AS under_review_at,
    MIN(d.decided_at) AS decided_at,
    MIN(d.resolved_at) AS resolved_at
  FROM disputes d
  GROUP BY d.booking_id
),
financial_state AS (
  SELECT
    booking_id,
    -- Aggregate verified financial action across refunds and payments.
    CASE
      WHEN BOOL_OR(state = 'failed') THEN 'failed'
      WHEN BOOL_OR(state = 'pending') THEN 'pending'
      WHEN BOOL_OR(state = 'completed') THEN 'completed'
      ELSE 'none'
    END AS financial_state,
    MIN(action_at) FILTER (WHERE state = 'pending') AS financial_pending_at,
    MIN(action_at) FILTER (WHERE state = 'completed') AS financial_completed_at,
    MIN(action_at) FILTER (WHERE state = 'failed') AS financial_failed_at
  FROM (
    SELECT
      r.booking_id,
      CASE
        WHEN r.status IN ('completed', 'refunded', 'succeeded') THEN 'completed'
        WHEN r.status IN ('failed', 'rejected', 'cancelled') THEN 'failed'
        ELSE 'pending'
      END AS state,
      COALESCE(r.updated_at, r.created_at) AS action_at
    FROM refund_requests r
    UNION ALL
    SELECT
      p.booking_id,
      CASE
        WHEN p.status IN ('completed', 'succeeded', 'released', 'refunded') THEN 'completed'
        WHEN p.status IN ('failed', 'cancelled') THEN 'failed'
        ELSE 'pending'
      END AS state,
      COALESCE(p.updated_at, p.created_at) AS action_at
    FROM payments p
  ) actions
  GROUP BY booking_id
)
SELECT
  b.id AS booking_id,
  COALESCE(ds.has_dispute, FALSE) AS has_dispute,
  dispute_status_from_state(
    COALESCE(ds.has_dispute, FALSE),
    COALESCE(ds.under_review, FALSE),
    COALESCE(ds.has_decision, FALSE),
    COALESCE(fs.financial_state, 'none')
  ) AS dispute_status,
  ds.opened_at,
  ds.under_review_at,
  ds.decided_at,
  COALESCE(fs.financial_state, 'none') AS financial_state,
  fs.financial_pending_at,
  fs.financial_completed_at,
  fs.financial_failed_at,
  ds.resolved_at
FROM bookings b
LEFT JOIN dispute_state ds ON ds.booking_id = b.id
LEFT JOIN financial_state fs ON fs.booking_id = b.id;

-- ---------------------------------------------------------------------------
-- Indexes to support the participant timeline query
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_disputes_booking_id ON disputes(booking_id);
CREATE INDEX IF NOT EXISTS idx_disputes_booking_status ON disputes(booking_id, status);
CREATE INDEX IF NOT EXISTS idx_refund_requests_booking_id ON refund_requests(booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_booking_status ON refund_requests(booking_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_booking_id ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_booking_status ON payments(booking_id, status);
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>