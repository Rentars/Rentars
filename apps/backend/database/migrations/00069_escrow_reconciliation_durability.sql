-- 00069_escrow_reconciliation_durability.sql (#877)
--
-- Adds durable attempt metadata for escrow reconciliation so retries survive
-- process restarts and ambiguous/permanent failures can be routed to manual
-- review distinct from a confirmed on-chain failure.
--
-- Forward-only, additive (nullable columns / safe default), idempotent via
-- IF NOT EXISTS so it is safe to re-run.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reconcile_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_last_error_class TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_last_safe_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_recovered_notified_at TIMESTAMPTZ;

-- Index to efficiently select only bookings whose backoff window has elapsed.
CREATE INDEX IF NOT EXISTS idx_bookings_reconcile_next_attempt
  ON bookings (reconcile_next_attempt_at)
  WHERE status = 'pending' AND escrow_hash IS NOT NULL;

COMMENT ON COLUMN bookings.reconcile_next_attempt_at IS
  'Earliest time the next reconciliation attempt may run (exponential backoff). #877';
COMMENT ON COLUMN bookings.reconcile_last_error_class IS
  'Last error classification observed: transient | ambiguous | permanent. #877';
COMMENT ON COLUMN bookings.reconcile_provider_event_id IS
  'Last blockchain/provider event id processed for this booking, for idempotent dedup. #877';
COMMENT ON COLUMN bookings.reconcile_last_safe_state IS
  'Last known-safe booking status before entering a failure/review path, used to recover cleanly. #877';
COMMENT ON COLUMN bookings.escrow_manual_review_at IS
  'Set when a booking is routed to manual review (ambiguous or exhausted-but-unconfirmed failures). #877';

-- ---------------------------------------------------------------------------
-- #1009 / Issue 116: Escrow state ownership & verified on-chain evidence
-- ---------------------------------------------------------------------------
--
-- Authority model (documented here so it is testable and reviewable):
--   * Terminal escrow states (released / refunded) are CONTRACT-AUTHORIZED only.
--     They may only be entered from a verified, authenticated on-chain event
--     whose evidence is recorded in escrow_verified_events below.
--   * Off-chain actors (provider callbacks, sync service, payment UI) may only
--     RECORD evidence; they cannot move a booking to a terminal state directly.
--   * Pending states (pending / funded / in_progress) are non-terminal and may
--     be advanced by verified evidence or reconciliation, never by raw requests.
--   * On-chain vs provider disagreement is stored explicitly and surfaced for
--     manual review; it is never silently resolved.
--
-- Forward-only, additive, idempotent.

-- Verified on-chain evidence ledger. One row per authenticated chain event.
-- The replay_key is a unique dedup key (chain + contract + event id + tx hash)
-- so a replayed or forged callback cannot be applied twice.
CREATE TABLE IF NOT EXISTS escrow_verified_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Chain identity of the event source (network + escrow contract address).
  chain_network TEXT NOT NULL,
  escrow_contract_address TEXT NOT NULL,
  -- Provider/chain event id and transaction hash used to build the replay key.
  provider_event_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  -- Amount asserted by the event, in the escrow asset's smallest unit.
  amount NUMERIC(38, 0) NOT NULL,
  asset_code TEXT,
  -- Verified event kind: funded | released | refunded | disputed | resolved.
  event_kind TEXT NOT NULL,
  -- Whether this event is terminal (released/refunded) or pending.
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  -- Deterministic replay/dedup key; uniqueness prevents replay application.
  replay_key TEXT NOT NULL,
  -- Signature/verification evidence captured at ingest time.
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  raw_event JSONB,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT escrow_verified_events_replay_key_uniq UNIQUE (replay_key),
  CONSTRAINT escrow_verified_events_event_kind_chk
    CHECK (event_kind IN ('funded', 'released', 'refunded', 'disputed', 'resolved')),
  CONSTRAINT escrow_verified_events_terminal_kind_chk
    CHECK ((event_kind IN ('released', 'refunded')) = is_terminal),
  CONSTRAINT escrow_verified_events_amount_nonneg_chk CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_escrow_verified_events_booking
  ON escrow_verified_events (booking_id, verified_at DESC);

COMMENT ON TABLE escrow_verified_events IS
  'Authenticated, verified on-chain escrow events. Terminal booking transitions require a matching row here. #1009';
COMMENT ON COLUMN escrow_verified_events.replay_key IS
  'Deterministic dedup key (chain + contract + event id + tx hash); UNIQUE prevents replay application. #1009';
COMMENT ON COLUMN escrow_verified_events.is_terminal IS
  'True only for released/refunded events; terminal booking states require such evidence. #1009';

-- Explicit escrow state ownership + disagreement tracking on bookings.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS escrow_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_authority TEXT,
  ADD COLUMN IF NOT EXISTS escrow_onchain_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_provider_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_state_disagreement BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS escrow_state_disagreement_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_terminal_evidence_id UUID
    REFERENCES escrow_verified_events(id) ON DELETE SET NULL;

COMMENT ON COLUMN bookings.escrow_state IS
  'Authoritative escrow state: pending | funded | in_progress | released | refunded | disputed. #1009';
COMMENT ON COLUMN bookings.escrow_state_authority IS
  'Who last set escrow_state: contract (verified on-chain) | reconciliation | manual_review. Terminal states must be contract. #1009';
COMMENT ON COLUMN bookings.escrow_onchain_state IS
  'Last observed on-chain escrow state, recorded for comparison only (not authoritative on its own). #1009';
COMMENT ON COLUMN bookings.escrow_provider_state IS
  'Last reported provider (Trustless Work) escrow state, recorded for comparison only. #1009';
COMMENT ON COLUMN bookings.escrow_state_disagreement IS
  'True when on-chain and provider states disagree; surfaced for manual review, never silently resolved. #1009';
COMMENT ON COLUMN bookings.escrow_terminal_evidence_id IS
  'Verified on-chain event that authorized the terminal escrow state (released/refunded). #1009';

-- Guard: a booking may only hold a terminal escrow state when it references
-- verified terminal evidence. Enforced at the DB boundary so no off-chain
-- path can mark funds released/refunded without verifiable settlement.
CREATE OR REPLACE FUNCTION bookings_escrow_terminal_requires_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.escrow_state IN ('released', 'refunded') THEN
    IF NEW.escrow_terminal_evidence_id IS NULL THEN
      RAISE EXCEPTION
        'terminal escrow_state % requires verified terminal evidence (#1009)',
        NEW.escrow_state;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM escrow_verified_events e
      WHERE e.id = NEW.escrow_terminal_evidence_id
        AND e.booking_id = NEW.id
        AND e.is_terminal = TRUE
    ) THEN
      RAISE EXCEPTION
        'terminal escrow_state % requires matching verified terminal evidence for this booking (#1009)',
        NEW.escrow_state;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_escrow_terminal_requires_evidence ON bookings;
CREATE TRIGGER trg_bookings_escrow_terminal_requires_evidence
  BEFORE INSERT OR UPDATE OF escrow_state, escrow_terminal_evidence_id ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION bookings_escrow_terminal_requires_evidence();
