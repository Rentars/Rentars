-- Migration 007: Ledger event inbox and sync cursors for replay-safe workers
-- Issue #783: Make blockchain synchronization replay-safe

-- Event inbox: persists every received event before projection so worker
-- restarts cannot skip events.  The event_key is the globally unique identity
-- of an on-chain event (e.g. "booking:created:42").
CREATE TABLE IF NOT EXISTS ledger_event_inbox (
    event_key       TEXT        PRIMARY KEY,
    worker_id       TEXT        NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    projected_at    TIMESTAMPTZ,
    attempts        INT         NOT NULL DEFAULT 0,
    last_error      TEXT,
    status          TEXT        NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'projected', 'dead_letter'))
);

-- Index for efficient dead-letter inspection per worker
CREATE INDEX IF NOT EXISTS idx_ledger_event_inbox_worker_status
    ON ledger_event_inbox (worker_id, status);

-- Index for querying by status alone (e.g. SELECT all dead_letter rows)
CREATE INDEX IF NOT EXISTS idx_ledger_event_inbox_status
    ON ledger_event_inbox (status);

-- Cursor table: each worker records the last sequence number it processed.
-- Workers load this on startup to resume from a known point.
CREATE TABLE IF NOT EXISTS ledger_sync_cursors (
    cursor_key  TEXT        PRIMARY KEY,
    last_value  TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Allow row-level security policies to be added per environment
ALTER TABLE ledger_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_sync_cursors ENABLE ROW LEVEL SECURITY;
