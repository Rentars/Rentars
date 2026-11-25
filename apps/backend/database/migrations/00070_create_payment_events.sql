-- Migration: 00070_create_payment_events.sql
-- Issue 051: Persist a complete payment ledger for each booking
--
-- Creates an immutable, append-only ledger of payment events. Each row records a
-- single payment attempt or state transition, linked to the booking, quote,
-- provider, network, exact amount/currency, idempotency key and correlation ID.
-- The current payment status is derived from these events (see payment service).
--
-- Immutability is enforced at the database level:
--   * No UPDATE or DELETE policies are defined (RLS denies by default).
--   * A trigger rejects any UPDATE or DELETE on the table.
--   * A trigger rejects any TRUNCATE on the table.

BEGIN;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
    -- Surrogate primary key. Monotonic sequence used for deterministic ordering
    -- when timestamps collide (out-of-order callback reconciliation).
    id                  BIGSERIAL       PRIMARY KEY,

    -- Stable, externally referenceable identifier for the event itself.
    event_id            UUID            NOT NULL DEFAULT gen_random_uuid(),

    -- Linkage to the booking and (optional) quote this event belongs to.
    booking_id          UUID            NOT NULL,
    quote_id            UUID,

    -- Provider / network context. Provider reference is the external identifier
    -- returned by (or sent to) the payment provider for this attempt.
    provider            TEXT            NOT NULL,
    provider_reference  TEXT,
    network             TEXT,

    -- Event classification and the resulting payment status after this event.
    event_type          TEXT            NOT NULL,
    payment_status      TEXT            NOT NULL,

    -- Exact monetary amount with explicit currency precision. Amount is stored
    -- as a NUMERIC with fixed scale so no floating point rounding occurs.
    amount              NUMERIC(38, 18) NOT NULL,
    currency            CHAR(3)         NOT NULL,

    -- Idempotency key ensures duplicate callbacks do not create duplicate
    -- financial effects. Correlation ID ties every external call and log line
    -- back to this event.
    idempotency_key     TEXT            NOT NULL,
    correlation_id      UUID            NOT NULL,

    -- Free-form, credential-redacted payload for audit/support purposes.
    metadata            JSONB           NOT NULL DEFAULT '{}'::jsonb,

    -- When the event occurred at the source (provider/network) vs. when it was
    -- recorded locally. Both are needed to reconcile delayed callbacks.
    occurred_at         TIMESTAMPTZ     NOT NULL,
    recorded_at         TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- -----------------------------------------------------------------------
    -- Constraints
    -- -----------------------------------------------------------------------
    CONSTRAINT payment_events_event_id_key UNIQUE (event_id),

    CONSTRAINT payment_events_event_type_check CHECK (
        event_type IN (
            'attempt_created',
            'attempt_submitted',
            'provider_acknowledged',
            'provider_callback_received',
            'onchain_submitted',
            'onchain_confirmed',
            'onchain_failed',
            'succeeded',
            'failed',
            'cancelled',
            'refunded',
            'reconciled'
        )
    ),

    CONSTRAINT payment_events_payment_status_check CHECK (
        payment_status IN (
            'pending',
            'processing',
            'succeeded',
            'failed',
            'cancelled',
            'refunded',
            'unknown'
        )
    ),

    CONSTRAINT payment_events_amount_non_negative CHECK (amount >= 0),

    CONSTRAINT payment_events_currency_check CHECK (currency ~ '^[A-Z]{3}$'),

    CONSTRAINT payment_events_idempotency_key_not_empty CHECK (
        length(btrim(idempotency_key)) > 0
    ),

    CONSTRAINT payment_events_provider_not_empty CHECK (
        length(btrim(provider)) > 0
    )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary lookup: all events for a booking, in deterministic order.
CREATE INDEX IF NOT EXISTS payment_events_booking_id_idx
    ON payment_events (booking_id, id);

-- Idempotency lookups: dedupe duplicate callbacks per provider.
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_provider_idempotency_key_uidx
    ON payment_events (provider, idempotency_key);

-- Correlation lookups for support/debugging across external calls.
CREATE INDEX IF NOT EXISTS payment_events_correlation_id_idx
    ON payment_events (correlation_id);

-- Provider reference lookups (reconcile callbacks to attempts).
CREATE INDEX IF NOT EXISTS payment_events_provider_reference_idx
    ON payment_events (provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

-- Quote linkage lookups.
CREATE INDEX IF NOT EXISTS payment_events_quote_id_idx
    ON payment_events (quote_id)
    WHERE quote_id IS NOT NULL;

-- Reconciliation scans by source time.
CREATE INDEX IF NOT EXISTS payment_events_occurred_at_idx
    ON payment_events (occurred_at);

-- ---------------------------------------------------------------------------
-- Immutability enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payment_events_reject_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'payment_events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS payment_events_no_update ON payment_events;
CREATE TRIGGER payment_events_no_update
    BEFORE UPDATE ON payment_events
    FOR EACH ROW
    EXECUTE FUNCTION payment_events_reject_mutation();

DROP TRIGGER IF EXISTS payment_events_no_delete ON payment_events;
CREATE TRIGGER payment_events_no_delete
    BEFORE DELETE ON payment_events
    FOR EACH ROW
    EXECUTE FUNCTION payment_events_reject_mutation();

DROP TRIGGER IF EXISTS payment_events_no_truncate ON payment_events;
CREATE TRIGGER payment_events_no_truncate
    BEFORE TRUNCATE ON payment_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION payment_events_reject_mutation();

-- ---------------------------------------------------------------------------
-- Row Level Security: append-only, no update/delete policies.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

-- Allow inserts (append) for the application role.
DROP POLICY IF EXISTS payment_events_insert ON payment_events;
CREATE POLICY payment_events_insert
    ON payment_events
    FOR INSERT
    WITH CHECK (true);

-- Allow reads for the application role.
DROP POLICY IF EXISTS payment_events_select ON payment_events;
CREATE POLICY payment_events_select
    ON payment_events
    FOR SELECT
    USING (true);

-- NOTE: No UPDATE or DELETE policies are defined. With RLS enabled, any
-- UPDATE/DELETE attempt is denied by default, in addition to the triggers
-- above which provide defense in depth.

COMMIT;