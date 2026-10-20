-- 00067_create_sync_event_inbox.sql
-- Sync event inbox and cursor tables to make blockchain synchronization replay-safe.
-- Duplicate, delayed, or reordered ledger events must not duplicate side effects.

BEGIN;

-- Inbox: one row per unique ledger event (transaction/operation key).
-- A row is recorded BEFORE the projection is applied, so a crash mid-projection
-- leaves a durable receipt that can be retried from a known cursor.
CREATE TABLE IF NOT EXISTS sync_event_inbox (
    id                  BIGSERIAL PRIMARY KEY,

    -- Unique event identity. The transaction/operation key is the natural
    -- idempotency key for a ledger event; the event hash guards against
    -- conflicting payloads for the same key.
    event_key           TEXT        NOT NULL,
    event_hash          TEXT        NOT NULL,
    event_type          TEXT        NOT NULL,
    source              TEXT        NOT NULL DEFAULT 'stellar',
    ledger_sequence     BIGINT,
    operation_index     INTEGER,
    transaction_hash    TEXT,

    -- Raw event payload as received, retained for replay and repair.
    payload             JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Processing lifecycle:
    --   received    -> durable receipt written, projection not yet started
    --   processing  -> projection in progress (may be retried after restart)
    --   processed   -> projection committed successfully
    --   failed      -> projection failed, eligible for retry
    --   dead_letter -> quarantined after exhausting retries; needs repair
    status              TEXT        NOT NULL DEFAULT 'received',

    -- Retry bookkeeping.
    retry_count         INTEGER     NOT NULL DEFAULT 0,
    max_retries         INTEGER     NOT NULL DEFAULT 10,
    last_error          TEXT,

    -- Dead-letter / quarantine flag for fast inspection and repair.
    is_dead_letter      BOOLEAN     NOT NULL DEFAULT FALSE,
    quarantined_at      TIMESTAMPTZ,

    -- Receipt and processing timestamps.
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processing_started_at TIMESTAMPTZ,
    processed_at        TIMESTAMPTZ,
    next_retry_at       TIMESTAMPTZ,

    -- Worker that last touched the row, for restart diagnostics.
    last_worker_id      TEXT,

    CONSTRAINT sync_event_inbox_status_check CHECK (
        status IN ('received', 'processing', 'processed', 'failed', 'dead_letter')
    ),
    CONSTRAINT sync_event_inbox_event_key_unique UNIQUE (event_key)
);

-- Fast lookup of pending work ordered by ledger position.
CREATE INDEX IF NOT EXISTS idx_sync_event_inbox_pending
    ON sync_event_inbox (status, ledger_sequence, operation_index)
    WHERE status IN ('received', 'processing', 'failed');

-- Retry scheduling.
CREATE INDEX IF NOT EXISTS idx_sync_event_inbox_next_retry
    ON sync_event_inbox (next_retry_at)
    WHERE status = 'failed';

-- Dead-letter inspection.
CREATE INDEX IF NOT EXISTS idx_sync_event_inbox_dead_letter
    ON sync_event_inbox (quarantined_at)
    WHERE is_dead_letter = TRUE;

-- Deduplicate by transaction hash + operation index when available.
CREATE INDEX IF NOT EXISTS idx_sync_event_inbox_tx_op
    ON sync_event_inbox (transaction_hash, operation_index)
    WHERE transaction_hash IS NOT NULL;

-- Cursor: persisted resume position per stream/consumer so a restarted worker
-- continues from a known point instead of replaying from the beginning.
CREATE TABLE IF NOT EXISTS sync_event_cursor (
    id                  BIGSERIAL PRIMARY KEY,

    -- Logical stream/consumer identity (e.g. 'payments', 'bookings', 'reviews').
    stream              TEXT        NOT NULL,
    consumer            TEXT        NOT NULL DEFAULT 'default',

    -- Last fully processed position.
    last_ledger_sequence BIGINT     NOT NULL DEFAULT 0,
    last_operation_index INTEGER    NOT NULL DEFAULT -1,
    last_event_key      TEXT,

    -- Lag measurement: latest observed ledger vs. last processed.
    latest_observed_ledger BIGINT   NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sync_event_cursor_stream_consumer_unique UNIQUE (stream, consumer)
);

CREATE INDEX IF NOT EXISTS idx_sync_event_cursor_stream
    ON sync_event_cursor (stream, consumer);

COMMIT;