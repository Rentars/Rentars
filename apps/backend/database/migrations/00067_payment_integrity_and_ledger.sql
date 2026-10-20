-- Migration 00067: Payment integrity, escrow reconciliation, refunds, and earnings ledger
-- Implements Issues 043, 044, 045, and 046.

BEGIN;

-- ============================================================================
-- Issue 043: Escrow reconciliation attempts
-- ============================================================================
CREATE TABLE IF NOT EXISTS escrow_reconciliation_attempts (
    attempt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    provider_event_id   TEXT NOT NULL,
    error_category      TEXT NOT NULL CHECK (error_category IN ('transient', 'permanent')),
    attempt_number      INTEGER NOT NULL CHECK (attempt_number >= 1),
    next_retry_at       TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'retrying', 'manual_review', 'resolved')),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT escrow_reconciliation_attempts_unique_event
        UNIQUE (booking_id, provider_event_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_escrow_recon_attempts_booking
    ON escrow_reconciliation_attempts (booking_id);
CREATE INDEX IF NOT EXISTS idx_escrow_recon_attempts_status_retry
    ON escrow_reconciliation_attempts (status, next_retry_at)
    WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS idx_escrow_recon_attempts_provider_event
    ON escrow_reconciliation_attempts (provider_event_id);

-- ============================================================================
-- Issue 043: Idempotent notification outbox
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_outbox (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            TEXT NOT NULL,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_type   TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notification_outbox_unique_event_user
        UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_next
    ON notification_outbox (status, next_attempt_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_notification_outbox_user
    ON notification_outbox (user_id, created_at DESC);

-- ============================================================================
-- Issue 045: Refund requests
-- ============================================================================
CREATE TABLE IF NOT EXISTS refund_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    idempotency_key     TEXT NOT NULL,
    amount_minor        BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency            TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'requested'
                        CHECK (state IN ('requested', 'submitted', 'confirmed', 'failed', 'manual_review')),
    destination_ref     TEXT,
    provider_ref        TEXT,
    error_category      TEXT CHECK (error_category IN ('transient', 'permanent')),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT refund_requests_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_booking
    ON refund_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_refund_requests_state
    ON refund_requests (state, created_at);
CREATE INDEX IF NOT EXISTS idx_refund_requests_provider_ref
    ON refund_requests (provider_ref)
    WHERE provider_ref IS NOT NULL;

-- ============================================================================
-- Issue 046: Append-only earnings ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS earnings_ledger (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,
    entry_type          TEXT NOT NULL CHECK (entry_type IN ('credit', 'debit', 'adjustment')),
    amount_minor        BIGINT NOT NULL,
    currency            TEXT NOT NULL,
    source_ref          TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT earnings_ledger_source_ref_unique UNIQUE (source_ref)
);

CREATE INDEX IF NOT EXISTS idx_earnings_ledger_host_created
    ON earnings_ledger (host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_host_currency
    ON earnings_ledger (host_id, currency);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_booking
    ON earnings_ledger (booking_id)
    WHERE booking_id IS NOT NULL;

-- Prevent mutation of historical ledger entries (append-only).
CREATE OR REPLACE FUNCTION earnings_ledger_prevent_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'earnings_ledger is append-only; create an adjustment entry instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_earnings_ledger_no_update ON earnings_ledger;
CREATE TRIGGER trg_earnings_ledger_no_update
    BEFORE UPDATE ON earnings_ledger
    FOR EACH ROW EXECUTE FUNCTION earnings_ledger_prevent_mutation();

DROP TRIGGER IF EXISTS trg_earnings_ledger_no_delete ON earnings_ledger;
CREATE TRIGGER trg_earnings_ledger_no_delete
    BEFORE DELETE ON earnings_ledger
    FOR EACH ROW EXECUTE FUNCTION earnings_ledger_prevent_mutation();

-- ============================================================================
-- updated_at triggers
-- ============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_escrow_recon_attempts_updated_at ON escrow_reconciliation_attempts;
CREATE TRIGGER trg_escrow_recon_attempts_updated_at
    BEFORE UPDATE ON escrow_reconciliation_attempts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_notification_outbox_updated_at ON notification_outbox;
CREATE TRIGGER trg_notification_outbox_updated_at
    BEFORE UPDATE ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_refund_requests_updated_at ON refund_requests;
CREATE TRIGGER trg_refund_requests_updated_at
    BEFORE UPDATE ON refund_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================

-- escrow_reconciliation_attempts: service role full access; tenant/host read own.
ALTER TABLE escrow_reconciliation_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS escrow_recon_attempts_service_role ON escrow_reconciliation_attempts;
CREATE POLICY escrow_recon_attempts_service_role ON escrow_reconciliation_attempts
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS escrow_recon_attempts_participant_read ON escrow_reconciliation_attempts;
CREATE POLICY escrow_recon_attempts_participant_read ON escrow_reconciliation_attempts
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.id = escrow_reconciliation_attempts.booking_id
              AND (b.tenant_id = auth.uid() OR b.host_id = auth.uid())
        )
    );

-- notification_outbox: service role full access; users read own notifications.
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_outbox_service_role ON notification_outbox;
CREATE POLICY notification_outbox_service_role ON notification_outbox
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS notification_outbox_user_read ON notification_outbox;
CREATE POLICY notification_outbox_user_read ON notification_outbox
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- refund_requests: service role full access; tenant/host read own.
ALTER TABLE refund_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refund_requests_service_role ON refund_requests;
CREATE POLICY refund_requests_service_role ON refund_requests
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS refund_requests_participant_read ON refund_requests;
CREATE POLICY refund_requests_participant_read ON refund_requests
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM bookings b
            WHERE b.id = refund_requests.booking_id
              AND (b.tenant_id = auth.uid() OR b.host_id = auth.uid())
        )
    );

-- earnings_ledger: service role full access; hosts read own entries.
ALTER TABLE earnings_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS earnings_ledger_service_role ON earnings_ledger;
CREATE POLICY earnings_ledger_service_role ON earnings_ledger
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS earnings_ledger_host_read ON earnings_ledger;
CREATE POLICY earnings_ledger_host_read ON earnings_ledger
    FOR SELECT
    TO authenticated
    USING (host_id = auth.uid());

COMMIT;