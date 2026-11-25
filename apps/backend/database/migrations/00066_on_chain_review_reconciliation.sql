-- On-chain review reconciliation: immutable chain references and repair queue
--
-- The reviews table already has an `on_chain_id` BIGINT column (migration 00009)
-- that stores the Soroban review contract's auto-incremented ID.  This
-- migration adds the remaining immutable chain metadata and a
-- reconciliation status so the sync service can detect mismatches between
-- on-chain records and off-chain database rows.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS on_chain_tx_hash    TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_ledger     BIGINT,
  ADD COLUMN IF NOT EXISTS on_chain_timestamp  BIGINT,   -- Unix seconds from ledger
  ADD COLUMN IF NOT EXISTS reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (reconciliation_status IN (
      'none',       -- review not yet submitted on-chain
      'pending',    -- on-chain submission detected, awaiting reconciliation
      'matched',    -- on-chain and off-chain records agree
      'mismatched', -- on-chain and off-chain records diverge (rating/comment mismatch)
      'missing',    -- off-chain review exists but no on-chain record found
      'orphaned'    -- on-chain record exists but no off-chain review found
    )),
  ADD COLUMN IF NOT EXISTS reconciled_at       TIMESTAMPTZ;

-- ─── Chain submission state (privacy-safe commitment) ────────────────────────
--
-- `on_chain_status` tracks the lifecycle of the chain submission itself and is
-- deliberately kept separate from `reconciliation_status` above:
--   * on_chain_status      -> did the transaction succeed on-chain?
--   * reconciliation_status -> do the on-chain and off-chain records agree?
-- A review is only ever labelled "on-chain verified" when on_chain_status is
-- 'confirmed' AND on_chain_id is set.  A failed or pending transaction never
-- affects the off-chain moderation state.
--
-- `on_chain_commitment` is a privacy-safe hash of the review content, booking,
-- property and a per-review nonce.  Only this commitment (never the review
-- text) is published on-chain, so personal content is not leaked.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS on_chain_network      TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_status       VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (on_chain_status IN (
      'none',       -- not submitted on-chain
      'pending',    -- submission in flight / awaiting confirmation
      'submitted',  -- transaction accepted by the network, not yet confirmed
      'confirmed',  -- transaction confirmed on-chain
      'failed'      -- transaction failed or was rejected
    )),
  ADD COLUMN IF NOT EXISTS on_chain_commitment   TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_nonce        TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS on_chain_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS on_chain_error        TEXT,
  ADD COLUMN IF NOT EXISTS on_chain_retry_count  INT NOT NULL DEFAULT 0;

-- Prevent the same review commitment from being submitted twice on the same
-- network.  Partial index so rows without a commitment are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_on_chain_commitment
  ON reviews (on_chain_network, on_chain_commitment)
  WHERE on_chain_commitment IS NOT NULL AND on_chain_network IS NOT NULL;

-- Index for the reconciliation sweep that scans reviews needing attention.
CREATE INDEX IF NOT EXISTS idx_reviews_reconciliation_status
  ON reviews (reconciliation_status)
  WHERE reconciliation_status NOT IN ('none', 'matched');

-- Index for the submission/confirmation sweep over in-flight transactions.
CREATE INDEX IF NOT EXISTS idx_reviews_on_chain_status
  ON reviews (on_chain_status)
  WHERE on_chain_status IN ('pending', 'submitted', 'failed');

-- ─── Repair queue ─────────────────────────────────────────────────────────────
--
-- Stores repair tasks for reviews with reconciliation problems
-- (mismatched, missing, orphaned, or duplicate events).
-- Each task is processed by an admin and retains the original diagnostic
-- for auditability.

CREATE TABLE IF NOT EXISTS review_repair_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID REFERENCES reviews(id) ON DELETE CASCADE,
  on_chain_id     BIGINT,                      -- may be null for "missing" issues
  issue_type      VARCHAR(20) NOT NULL CHECK (issue_type IN (
    'mismatched',   -- on-chain rating/comment diverges from DB
    'missing',       -- DB review has no on-chain counterpart
    'orphaned',      -- on-chain review has no DB counterpart
    'duplicate'      -- duplicate on-chain event detected
  )),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'in_progress', 'resolved', 'wont_fix'
  )),
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_repair_queue_status
  ON review_repair_queue (status, created_at)
  WHERE status IN ('open', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_review_repair_queue_review
  ON review_repair_queue (review_id);

CREATE INDEX IF NOT EXISTS idx_review_repair_queue_on_chain_id
  ON review_repair_queue (on_chain_id)
  WHERE on_chain_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_review_repair_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_review_repair_queue_updated_at ON review_repair_queue;
CREATE TRIGGER trg_update_review_repair_queue_updated_at
BEFORE UPDATE ON review_repair_queue
FOR EACH ROW
EXECUTE FUNCTION update_review_repair_queue_updated_at();
