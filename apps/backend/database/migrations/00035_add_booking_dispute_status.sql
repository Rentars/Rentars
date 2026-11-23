-- Add dispute workflow fields to bookings
-- dispute_status: none | raised | resolved

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS dispute_status VARCHAR(20) DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_bookings_dispute_status ON bookings(dispute_status);

-- Auditable dispute decision records.
-- A decision captures the reviewer, reasoning, evidence references and the
-- intended payment consequence. Financial settlement is tracked separately via
-- settlement_status so that a decision does not imply settlement until verified.
CREATE TABLE IF NOT EXISTS dispute_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL,
  decision VARCHAR(30) NOT NULL,
  reasoning TEXT,
  evidence_refs JSONB DEFAULT '[]'::jsonb,
  payment_consequence VARCHAR(30) DEFAULT 'none',
  settlement_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_decisions_booking_id ON dispute_decisions(booking_id);
CREATE INDEX IF NOT EXISTS idx_dispute_decisions_reviewer_id ON dispute_decisions(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_dispute_decisions_settlement_status ON dispute_decisions(settlement_status);
CREATE INDEX IF NOT EXISTS idx_dispute_decisions_created_at ON dispute_decisions(created_at);

-- Dispute status transition timeline.
-- Records every status change with the acting user and the reason so the
-- full lifecycle (raised, resolved, reopened, etc.) is traceable.
CREATE TABLE IF NOT EXISTS dispute_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  actor_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_status_history_booking_id ON dispute_status_history(booking_id);
CREATE INDEX IF NOT EXISTS idx_dispute_status_history_actor_id ON dispute_status_history(actor_id);
CREATE INDEX IF NOT EXISTS idx_dispute_status_history_created_at ON dispute_status_history(created_at);