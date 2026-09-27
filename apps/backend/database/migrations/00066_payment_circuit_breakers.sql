-- #618 (Issue 050): Payment attempt tracking for circuit breakers and rate limits.
--
-- Tracks payment attempts by user, booking, and idempotency key so repeated
-- failures stop generating external provider calls while in-flight payments
-- continue to reconcile.

CREATE TABLE IF NOT EXISTS payment_attempt_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(128),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, booking_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempt_counters_user
  ON payment_attempt_counters(user_id, window_started_at);

CREATE TABLE IF NOT EXISTS payment_circuit_state (
  provider VARCHAR(64) PRIMARY KEY,
  state VARCHAR(20) NOT NULL DEFAULT 'closed'
    CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  reset_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed known payment providers in closed state.
INSERT INTO payment_circuit_state (provider, state)
VALUES
  ('stellar_horizon', 'closed'),
  ('trustless_work', 'closed'),
  ('soroban_rpc', 'closed')
ON CONFLICT (provider) DO NOTHING;

COMMENT ON TABLE payment_attempt_counters IS
  '#618 per-user / per-booking payment attempt windows';
COMMENT ON TABLE payment_circuit_state IS
  '#618 provider circuit breaker state; operators may reset via admin API';
