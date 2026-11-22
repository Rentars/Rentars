-- Migration: 007_create_reconciliation_cases.sql
-- Created for issue #772: Build a restricted reconciliation operations view
--
-- This table stores mismatch records surfaced by the blockchain sync process
-- (sync.service.ts). Support staff and finance operators interact with it
-- via /api/v1/admin/reconciliation instead of directly editing bookings or
-- payment records.
--
-- Row-Level Security: all access must go through the backend service role.
-- Operators never connect directly to the database.

CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References — intentionally NOT foreign-key constrained so rows survive
  -- booking/payment deletion during incident investigation.
  booking_id          UUID        NOT NULL,
  payment_id          UUID,
  tenant_id           UUID        NOT NULL,
  property_id         UUID        NOT NULL,

  -- Current reconciliation status:
  --   pending    — queued for next reconciliation attempt
  --   mismatch   — on-chain state does not match DB (manual review needed)
  --   failed     — reconciliation exhausted retries
  --   escalated  — handed to a named team/person
  --   resolved   — manually or automatically closed
  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'mismatch', 'failed', 'escalated', 'resolved')),

  -- On-chain references (safe to expose to operators)
  escrow_hash         TEXT,
  on_chain_id         BIGINT,

  -- Escrow state-authority tracking (issue #116).
  -- The on-chain contract is the authoritative source for terminal escrow
  -- states (released / refunded). Provider (Trustless Work) references and
  -- off-chain booking state are advisory and must be reconciled against
  -- verified chain events. A disagreement between these sources is recorded
  -- here and surfaced to operators instead of being silently resolved.
  --
  --   on_chain_state   — last verified on-chain escrow state
  --   provider_state   — last state reported by the provider reference
  --   booking_state    — booking contract escrow state at detection time
  --   disagreement_kind — classification of the mismatch
  on_chain_state      TEXT
                      CHECK (on_chain_state IS NULL OR on_chain_state IN
                        ('pending', 'funded', 'released', 'refunded', 'unknown')),
  provider_state      TEXT
                      CHECK (provider_state IS NULL OR provider_state IN
                        ('pending', 'funded', 'released', 'refunded', 'unknown')),
  booking_state       TEXT
                      CHECK (booking_state IS NULL OR booking_state IN
                        ('pending', 'funded', 'released', 'refunded', 'unknown')),
  disagreement_kind   TEXT
                      CHECK (disagreement_kind IS NULL OR disagreement_kind IN
                        ('state_mismatch', 'forged_callback', 'wrong_booking',
                         'wrong_amount', 'replay', 'unverified_event')),

  -- Evidence references for the transition that triggered this case.
  -- Only authenticated, verified event evidence may move a booking to a
  -- terminal state; unverified requests land here for review.
  evidence_event_id   TEXT,
  evidence_tx_hash    TEXT,
  evidence_verified   BOOLEAN     NOT NULL DEFAULT FALSE,
  evidence_source     TEXT
                      CHECK (evidence_source IS NULL OR evidence_source IN
                        ('on_chain', 'provider', 'off_chain')),

  -- Terminal-state guard: when TRUE the booking must NOT be treated as
  -- paid/refunded until an operator resolves this case. Prevents unverified
  -- external requests from silently finalizing a booking.
  blocks_terminal     BOOLEAN     NOT NULL DEFAULT TRUE,
  resolved_by         TEXT,
  resolution_note     TEXT,
  resolved_at         TIMESTAMPTZ,
=======

  -- Retry tracking
  reconcile_attempts  INTEGER     NOT NULL DEFAULT 0,
  last_reconcile_at   TIMESTAMPTZ,
  last_reconcile_error TEXT,

  -- Escalation fields
  escalated_reason    TEXT,
  escalated_to        TEXT,
  escalated_at        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common operator queries
CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_status
  ON reconciliation_cases (status);

CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_booking_id
  ON reconciliation_cases (booking_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_created_at
  ON reconciliation_cases (created_at DESC);

-- Index for surfacing unresolved terminal-state guards to operators
CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_blocks_terminal
  ON reconciliation_cases (blocks_terminal)
  WHERE blocks_terminal = TRUE AND status <> 'resolved';

-- Index for locating cases by disagreement classification
CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_disagreement_kind
  ON reconciliation_cases (disagreement_kind)
  WHERE disagreement_kind IS NOT NULL;

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION set_reconciliation_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconciliation_updated_at ON reconciliation_cases;
CREATE TRIGGER trg_reconciliation_updated_at
  BEFORE UPDATE ON reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION set_reconciliation_updated_at();

-- Row-Level Security: deny direct table access; backend uses service role.
ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;

-- Service role bypass (backend service has full access)
CREATE POLICY "service_role_full_access" ON reconciliation_cases
  USING (auth.role() = 'service_role');

COMMENT ON TABLE reconciliation_cases IS
  'Mismatch records for payment/escrow reconciliation. Operators interact via '
  '/api/v1/admin/reconciliation — never by direct table edit. '
  'Created for issue #772. Extended for issue #116 to capture escrow '
  'state-authority disagreements (on-chain vs provider vs booking), evidence '
  'references, and terminal-state guards so unverified transitions are '
  'surfaced rather than silently resolved.';

COMMENT ON COLUMN reconciliation_cases.on_chain_state IS
  'Authoritative escrow state from verified on-chain events (issue #116).';
COMMENT ON COLUMN reconciliation_cases.provider_state IS
  'Advisory state reported by the Trustless Work provider reference; must be '
  'reconciled against on_chain_state.';
COMMENT ON COLUMN reconciliation_cases.booking_state IS
  'Booking contract escrow state captured at detection time.';
COMMENT ON COLUMN reconciliation_cases.disagreement_kind IS
  'Classification of the state-authority disagreement that opened this case.';
COMMENT ON COLUMN reconciliation_cases.evidence_verified IS
  'TRUE only when the transition was backed by authenticated, verified event '
  'evidence. Unverified requests must never move a booking to a terminal state.';
COMMENT ON COLUMN reconciliation_cases.blocks_terminal IS
  'When TRUE, the booking must not be treated as paid/refunded until an '
  'operator resolves this case.';
