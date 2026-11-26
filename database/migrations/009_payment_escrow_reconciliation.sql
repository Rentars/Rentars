-- Payment integrity, atomic earnings entries, and recoverable escrow
-- reconciliation support for issues #767, #768, and #770.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_stroops NUMERIC(20, 0),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USDC',
  ADD COLUMN IF NOT EXISTS quote_hash TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_event_hash TEXT,
  ADD COLUMN IF NOT EXISTS escrow_id TEXT,
  -- Authority: escrow state is owned by the on-chain contract. Off-chain
  -- columns below are caches/records only and must never be the sole basis
  -- for a terminal paid/refunded transition.
  ADD COLUMN IF NOT EXISTS escrow_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_source TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_event_id TEXT,
  ADD COLUMN IF NOT EXISTS verified_event_hash TEXT,
  ADD COLUMN IF NOT EXISTS verified_event_ledger BIGINT,
  ADD COLUMN IF NOT EXISTS verified_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS state_disagreement JSONB;

UPDATE payments
SET amount_stroops = ROUND(amount_usdc * 10000000)
WHERE amount_stroops IS NULL;

ALTER TABLE payments
  ALTER COLUMN amount_stroops SET NOT NULL,
  ALTER COLUMN amount_usdc DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS payments_status_check,
  ADD CONSTRAINT payments_status_check
    CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'timed_out', 'refunded', 'under_review')),
  ADD CONSTRAINT payments_currency_check CHECK (currency = 'USDC'),
  ADD CONSTRAINT payments_amount_stroops_positive CHECK (amount_stroops > 0),
  ADD CONSTRAINT payments_escrow_state_check CHECK (
    escrow_state IS NULL OR escrow_state IN (
      'unfunded', 'funded', 'pending_release', 'released',
      'pending_refund', 'refunded', 'disputed', 'unknown'
    )
  ),
  ADD CONSTRAINT payments_escrow_state_source_check CHECK (
    escrow_state_source IS NULL OR escrow_state_source IN (
      'on_chain', 'provider', 'off_chain', 'reconciler'
    )
  );

-- Terminal payment states may only be reached with verified on-chain evidence.
-- A forged callback, wrong booking, wrong amount, or replayed event cannot
-- satisfy these constraints because the evidence columns are populated only by
-- the verified-event ingestion path.
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_terminal_requires_verified_evidence;
ALTER TABLE payments
  ADD CONSTRAINT payments_terminal_requires_verified_evidence CHECK (
    status NOT IN ('confirmed', 'refunded')
    OR (
      verified_event_id IS NOT NULL
      AND verified_event_hash IS NOT NULL
      AND verified_event_ledger IS NOT NULL
      AND verified_event_at IS NOT NULL
      AND escrow_state_source = 'on_chain'
      AND escrow_state IN ('released', 'refunded')
    )
  );

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconcile_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_error TEXT,
  ADD COLUMN IF NOT EXISTS escrow_failure_notified_at TIMESTAMPTZ,
  -- Authority: booking status is owned by the booking contract. The escrow
  -- fields below mirror on-chain state and are written only by the verified
  -- reconciliation path; disagreement is surfaced rather than auto-resolved.
  ADD COLUMN IF NOT EXISTS escrow_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_source TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS state_disagreement JSONB,
  ADD COLUMN IF NOT EXISTS state_disagreement_at TIMESTAMPTZ;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_escrow_state_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_escrow_state_check CHECK (
    escrow_state IS NULL OR escrow_state IN (
      'unfunded', 'funded', 'pending_release', 'released',
      'pending_refund', 'refunded', 'disputed', 'unknown'
    )
  );

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_escrow_state_source_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_escrow_state_source_check CHECK (
    escrow_state_source IS NULL OR escrow_state_source IN (
      'on_chain', 'provider', 'off_chain', 'reconciler'
    )
  );

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check,
  ADD CONSTRAINT bookings_status_check CHECK (
    status IN (
      'Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed',
      'pending', 'confirmed', 'cancelled', 'completed', 'disputed',
      'escrow_reconcile_failed'
    )
  );

CREATE TABLE IF NOT EXISTS payment_callback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_callback_events_created
  ON payment_callback_events (created_at);

-- Verified on-chain escrow events. Only rows inserted through the verified
-- ingestion path (authenticated provider signature + contract event match)
-- may be referenced as terminal-state evidence. The unique constraints make
-- replay and cross-booking reuse of the same event impossible.
CREATE TABLE IF NOT EXISTS verified_escrow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_hash TEXT NOT NULL UNIQUE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  escrow_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  ledger BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'escrow_funded', 'escrow_released', 'escrow_refunded', 'escrow_disputed'
  )),
  resulting_state TEXT NOT NULL CHECK (resulting_state IN (
    'unfunded', 'funded', 'pending_release', 'released',
    'pending_refund', 'refunded', 'disputed', 'unknown'
  )),
  amount_stroops NUMERIC(20, 0) NOT NULL CHECK (amount_stroops > 0),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_source TEXT NOT NULL CHECK (verification_source IN ('on_chain', 'provider')),
  raw_event JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT verified_escrow_events_ledger_unique UNIQUE (contract_id, ledger, event_id)
);

CREATE INDEX IF NOT EXISTS idx_verified_escrow_events_booking
  ON verified_escrow_events (booking_id, ledger);

CREATE INDEX IF NOT EXISTS idx_verified_escrow_events_payment
  ON verified_escrow_events (payment_id, ledger);

-- Records every observed disagreement between on-chain, provider, and
-- off-chain state. Disagreements are never auto-resolved; they require an
-- operator decision recorded in resolved_by/resolution.
CREATE TABLE IF NOT EXISTS escrow_state_disagreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  on_chain_state TEXT,
  provider_state TEXT,
  off_chain_state TEXT,
  on_chain_amount_stroops NUMERIC(20, 0),
  provider_amount_stroops NUMERIC(20, 0),
  off_chain_amount_stroops NUMERIC(20, 0),
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by UUID,
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_escrow_state_disagreements_open
  ON escrow_state_disagreements (booking_id, created_at)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS escrow_reconciliation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider_event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'manual_review')),
  error_category TEXT CHECK (error_category IN ('transient', 'permanent')),
  error_message TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT escrow_reconciliation_attempt_unique UNIQUE (booking_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_escrow_reconciliation_due
  ON escrow_reconciliation_attempts (next_retry_at)
  WHERE status = 'pending';

ALTER TABLE blockchain_logs
  ADD COLUMN IF NOT EXISTS error_category TEXT CHECK (error_category IN ('transient', 'permanent')),
  ADD COLUMN IF NOT EXISTS attempt INTEGER;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_idempotency
  ON notifications (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL,
  notification_type TEXT NOT NULL,
  data JSONB NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_outbox_recipient_dedupe_unique UNIQUE (recipient_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox (created_at)
  WHERE status = 'pending';

ALTER TABLE earnings_ledger_entries
  ALTER COLUMN amount TYPE NUMERIC(20, 7);

CREATE OR REPLACE FUNCTION record_booking_settlement(
  p_host_id UUID,
  p_booking_id UUID,
  p_gross_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_host UUID;
  v_fee NUMERIC(20, 7);
BEGIN
  SELECT p.owner_id
  INTO v_booking_host
  FROM bookings b
  JOIN properties p ON p.id = b.property_id
  WHERE b.id = p_booking_id;

  IF v_booking_host IS NULL OR v_booking_host <> p_host_id THEN
    RAISE EXCEPTION 'Booking host does not match settlement host';
  END IF;

  IF p_gross_amount < 0 THEN
    RAISE EXCEPTION 'Settlement amount must be non-negative';
  END IF;

  v_fee := ROUND(p_gross_amount * 0.05, 7);

  INSERT INTO earnings_ledger_entries
    (host_id, booking_id, entry_type, direction, amount, currency, source_ref)
  VALUES
    (p_host_id, p_booking_id, 'booking_payment', 'credit', p_gross_amount, 'USDC',
      'booking_payment:' || p_booking_id::TEXT),
    (p_host_id, p_booking_id, 'platform_fee', 'debit', v_fee, 'USDC',
      'platform_fee:' || p_booking_id::TEXT)
  ON CONFLICT (host_id, source_ref) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION guard_confirmed_payment_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_expected_stroops NUMERIC(20, 0);
  v_event RECORD;
BEGIN
  IF NEW.status IN ('confirmed', 'refunded') AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT ROUND(b.total_price * 10000000)
    INTO v_expected_stroops
    FROM bookings b
    WHERE b.id = NEW.booking_id;

    -- Require verified on-chain evidence bound to this booking, this payment,
    -- the expected amount, and the terminal state being claimed.
    SELECT e.*
    INTO v_event
    FROM verified_escrow_events e
    WHERE e.event_id = NEW.verified_event_id
      AND e.event_hash = NEW.verified_event_hash
      AND e.ledger = NEW.verified_event_ledger
      AND e.booking_id = NEW.booking_id
      AND (e.payment_id IS NULL OR e.payment_id = NEW.id)
      AND e.amount_stroops = NEW.amount_stroops
      AND e.resulting_state = CASE
        WHEN NEW.status = 'confirmed' THEN 'released'
        WHEN NEW.status = 'refunded' THEN 'refunded'
      END
    LIMIT 1;

    IF v_event.id IS NULL THEN
      -- No verified evidence: quarantine instead of reaching a terminal state.
      NEW.status := 'under_review';
      NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || JSONB_BUILD_OBJECT(
        'quarantine_reason', 'missing_or_invalid_verified_evidence',
        'requested_status', NEW.status,
        'verified_event_id', NEW.verified_event_id
      );
      NEW.state_disagreement := COALESCE(NEW.state_disagreement, '{}'::JSONB) || JSONB_BUILD_OBJECT(
        'reason', 'missing_or_invalid_verified_evidence',
        'requested_status', NEW.status,
        'verified_event_id', NEW.verified_event_id
      );
      RETURN NEW;
    END IF;

    IF v_expected_stroops IS NULL OR NEW.amount_stroops <> v_expected_stroops THEN
      NEW.status := 'under_review';
      NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || JSONB_BUILD_OBJECT(
        'quarantine_reason', 'payment_amount_mismatch',
        'expected_stroops', v_expected_stroops,
        'actual_stroops', NEW.amount_stroops
      );
      NEW.state_disagreement := COALESCE(NEW.state_disagreement, '{}'::JSONB) || JSONB_BUILD_OBJECT(
        'reason', 'payment_amount_mismatch',
        'expected_stroops', v_expected_stroops,
        'actual_stroops', NEW.amount_stroops
      );
      RETURN NEW;
    END IF;

    -- Evidence is valid: record the authoritative on-chain state.
    NEW.escrow_state := v_event.resulting_state;
    NEW.escrow_state_source := 'on_chain';
    NEW.escrow_state_updated_at := NOW();
    NEW.verified_event_at := COALESCE(NEW.verified_event_at, v_event.verified_at);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_confirmed_payment_amount ON payments;
CREATE TRIGGER trg_guard_confirmed_payment_amount
  BEFORE UPDATE OF status ON payments
  FOR EACH ROW
  EXECUTE FUNCTION guard_confirmed_payment_amount();

-- Record any disagreement between on-chain escrow state and the off-chain
-- booking/payment state for operator review. This never resolves the
-- disagreement; it only makes it visible.
CREATE OR REPLACE FUNCTION record_escrow_state_disagreement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_state TEXT;
  v_payment_state TEXT;
  v_on_chain_state TEXT;
BEGIN
  SELECT b.escrow_state, p.escrow_state
  INTO v_booking_state, v_payment_state
  FROM bookings b
  LEFT JOIN payments p ON p.booking_id = b.id
  WHERE b.id = NEW.booking_id
  LIMIT 1;

  v_on_chain_state := NEW.resulting_state;

  IF v_booking_state IS DISTINCT FROM v_on_chain_state
    OR (v_payment_state IS NOT NULL AND v_payment_state IS DISTINCT FROM v_on_chain_state) THEN
    INSERT INTO escrow_state_disagreements
      (booking_id, payment_id, on_chain_state, provider_state, off_chain_state,
       on_chain_amount_stroops, reason, details)
    VALUES
      (NEW.booking_id, NEW.payment_id, v_on_chain_state, NULL,
        COALESCE(v_payment_state, v_booking_state),
        NEW.amount_stroops, 'on_chain_off_chain_mismatch',
        JSONB_BUILD_OBJECT(
          'event_id', NEW.event_id,
          'event_hash', NEW.event_hash,
          'ledger', NEW.ledger,
          'booking_state', v_booking_state,
          'payment_state', v_payment_state
        ));

    UPDATE bookings
    SET state_disagreement := JSONB_BUILD_OBJECT(
          'reason', 'on_chain_off_chain_mismatch',
          'on_chain_state', v_on_chain_state,
          'off_chain_state', COALESCE(v_payment_state, v_booking_state),
          'event_id', NEW.event_id
        ),
        state_disagreement_at = NOW()
    WHERE id = NEW.booking_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_escrow_state_disagreement ON verified_escrow_events;
CREATE TRIGGER trg_record_escrow_state_disagreement
  AFTER INSERT ON verified_escrow_events
  FOR EACH ROW
  EXECUTE FUNCTION record_escrow_state_disagreement();

CREATE OR REPLACE FUNCTION record_confirmed_refund_debit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.refund_amount > 0
    AND EXISTS (
      SELECT 1
      FROM earnings_ledger_entries e
      WHERE e.host_id = NEW.host_id
        AND e.booking_id = NEW.booking_id
        AND e.entry_type = 'booking_payment'
        AND e.direction = 'credit'
    ) THEN
    INSERT INTO earnings_ledger_entries
      (host_id, booking_id, entry_type, direction, amount, currency, source_ref)
    VALUES
      (NEW.host_id, NEW.booking_id, 'refund_debit', 'debit', NEW.refund_amount,
        NEW.currency, 'refund_debit:' || NEW.id::TEXT)
    ON CONFLICT (host_id, source_ref) DO NOTHING;

    INSERT INTO notification_outbox
      (recipient_id, notification_type, data, dedupe_key)
    VALUES
      (NEW.tenant_id, 'booking_cancelled',
        JSONB_BUILD_OBJECT(
          'booking_id', NEW.booking_id,
          'refund_amount', NEW.refund_amount,
          'refund_tier', NEW.refund_tier,
          'refund_status', 'confirmed'
        ),
        'refund-confirmed:' || NEW.id::TEXT || ':tenant'),
      (NEW.host_id, 'booking_cancelled',
        JSONB_BUILD_OBJECT(
          'booking_id', NEW.booking_id,
          'refund_amount', NEW.refund_amount,
          'refund_tier', NEW.refund_tier,
          'refund_status', 'confirmed'
        ),
        'refund-confirmed:' || NEW.id::TEXT || ':host')
    ON CONFLICT (recipient_id, dedupe_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_confirmed_refund_debit ON refund_requests;
CREATE TRIGGER trg_record_confirmed_refund_debit
  AFTER UPDATE OF status ON refund_requests
  FOR EACH ROW
  EXECUTE FUNCTION record_confirmed_refund_debit();

-- Backfill confirmed payments so balances include settlements predating this
-- migration. Stable source references make repeated migration runs harmless.
-- Only settlements with verified on-chain evidence are backfilled; anything
-- else is left for reconciliation rather than silently credited.
SELECT record_booking_settlement(p.owner_id, b.id, pay.amount_stroops / 10000000)
FROM payments pay
JOIN bookings b ON b.id = pay.booking_id
JOIN properties p ON p.id = b.property_id
WHERE pay.status = 'confirmed'
  AND pay.verified_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM verified_escrow_events e
    WHERE e.event_id = pay.verified_event_id
      AND e.booking_id = b.id
      AND e.resulting_state = 'released'
      AND e.amount_stroops = pay.amount_stroops
  );
