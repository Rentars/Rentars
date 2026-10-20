-- Migration 00068: Booking refund policy snapshot and quote binding
-- Issue 044: Enforce payment amount and currency integrity
-- Issue 045: Execute refunds from the booking-time policy snapshot

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Booking-time refund policy snapshot (immutable once captured)
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS refund_policy_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS refund_policy_snapshot_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. Quote binding fields (canonical integer minor units + currency)
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS quote_version INTEGER,
    ADD COLUMN IF NOT EXISTS quote_amount_minor BIGINT,
    ADD COLUMN IF NOT EXISTS quote_currency TEXT;

-- ---------------------------------------------------------------------------
-- 3. Settlement / reconciliation fields
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS settled_amount_minor BIGINT,
    ADD COLUMN IF NOT EXISTS settlement_verified BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reconciliation_state TEXT;

-- Constrain reconciliation_state to the canonical set of states.
ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS bookings_reconciliation_state_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_reconciliation_state_check
    CHECK (
        reconciliation_state IS NULL
        OR reconciliation_state IN ('ok', 'pending', 'mismatch', 'manual_review')
    );

-- Amounts must be non-negative integer minor units.
ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS bookings_quote_amount_minor_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_quote_amount_minor_check
    CHECK (quote_amount_minor IS NULL OR quote_amount_minor >= 0);

ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS bookings_settled_amount_minor_check;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_settled_amount_minor_check
    CHECK (settled_amount_minor IS NULL OR settled_amount_minor >= 0);

-- ---------------------------------------------------------------------------
-- 4. Immutability trigger for refund_policy_snapshot and quote_* fields
--    Mirrors the existing listing_terms_snapshot trigger: once a value is
--    set it can never be changed. NULL -> value transitions are allowed so
--    the snapshot can be captured at booking creation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bookings_prevent_snapshot_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.refund_policy_snapshot IS NOT NULL
       AND NEW.refund_policy_snapshot IS DISTINCT FROM OLD.refund_policy_snapshot THEN
        RAISE EXCEPTION
            'bookings.refund_policy_snapshot is immutable once set (booking id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.refund_policy_snapshot_at IS NOT NULL
       AND NEW.refund_policy_snapshot_at IS DISTINCT FROM OLD.refund_policy_snapshot_at THEN
        RAISE EXCEPTION
            'bookings.refund_policy_snapshot_at is immutable once set (booking id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.quote_version IS NOT NULL
       AND NEW.quote_version IS DISTINCT FROM OLD.quote_version THEN
        RAISE EXCEPTION
            'bookings.quote_version is immutable once set (booking id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.quote_amount_minor IS NOT NULL
       AND NEW.quote_amount_minor IS DISTINCT FROM OLD.quote_amount_minor THEN
        RAISE EXCEPTION
            'bookings.quote_amount_minor is immutable once set (booking id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.quote_currency IS NOT NULL
       AND NEW.quote_currency IS DISTINCT FROM OLD.quote_currency THEN
        RAISE EXCEPTION
            'bookings.quote_currency is immutable once set (booking id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_prevent_snapshot_mutation_trg ON bookings;

CREATE TRIGGER bookings_prevent_snapshot_mutation_trg
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION bookings_prevent_snapshot_mutation();

-- ---------------------------------------------------------------------------
-- 5. Indexes for reconciliation queries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_bookings_reconciliation_state
    ON bookings (reconciliation_state)
    WHERE reconciliation_state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_settlement_verified
    ON bookings (settlement_verified)
    WHERE settlement_verified IS NOT NULL;

COMMIT;