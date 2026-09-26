-- Migration 00066: Trust & risk signal cases
--
-- Stores risk evaluation results for users who exceed signal thresholds.
-- Each case captures the signals that triggered it, the automated action
-- taken (if any), and the full moderator override trail.
--
-- The design intentionally avoids opaque irreversible automation:
--   - Every automated action is stored with its trigger signals.
--   - Every action is reversible by a moderator (override_action).
--   - All decisions are audited.

-- Enum-style domains — stored as VARCHAR for Supabase compatibility.

CREATE TABLE IF NOT EXISTS trust_risk_cases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The user whose behaviour triggered the case.
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Overall risk level computed from signal scores.
  -- low | medium | high | critical
  risk_level        VARCHAR(20) NOT NULL DEFAULT 'low',

  -- JSONB array of signal objects: [{ signal, score, detail, occurred_at }, ...]
  -- Stored verbatim so moderators can inspect every contributing factor.
  signals           JSONB NOT NULL DEFAULT '[]',

  -- Aggregate risk score (sum of all signal scores at case creation).
  total_score       INTEGER NOT NULL DEFAULT 0,

  -- Automated action taken when the case was created.
  -- none | step_up_verification | temporary_hold | account_review
  automated_action  VARCHAR(50) NOT NULL DEFAULT 'none',

  -- Whether the automated action is currently in effect.
  action_active     BOOLEAN NOT NULL DEFAULT FALSE,

  -- Case lifecycle status.
  -- open | under_review | resolved | overridden | closed
  status            VARCHAR(30) NOT NULL DEFAULT 'open',

  -- Moderator who was assigned the case (nullable until assigned).
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Moderator resolution fields.
  resolved_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,

  -- Override: moderator can reverse an automated action.
  -- none | lifted | escalated | suspended | cleared
  override_action   VARCHAR(30),
  override_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  override_at       TIMESTAMPTZ,
  override_reason   TEXT,

  -- False-positive flag: set when moderator clears a case as benign.
  false_positive    BOOLEAN NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup all open cases for a user.
CREATE INDEX IF NOT EXISTS idx_trust_risk_cases_user
  ON trust_risk_cases (user_id, status);

-- Triage queue: moderators see critical first, then high, then by age.
CREATE INDEX IF NOT EXISTS idx_trust_risk_cases_triage
  ON trust_risk_cases (risk_level, created_at)
  WHERE status = 'open';

-- GIN index on signals for pattern queries (e.g. all cases with a chargeback signal).
CREATE INDEX IF NOT EXISTS idx_trust_risk_cases_signals_gin
  ON trust_risk_cases USING GIN (signals);

-- Updated_at trigger.
CREATE OR REPLACE FUNCTION set_trust_risk_cases_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trust_risk_cases_updated_at ON trust_risk_cases;
CREATE TRIGGER trg_trust_risk_cases_updated_at
  BEFORE UPDATE ON trust_risk_cases
  FOR EACH ROW EXECUTE FUNCTION set_trust_risk_cases_updated_at();

-- ── Signal event log ──────────────────────────────────────────────────────────
-- Individual signal firings, linked to the case they contributed to.
-- Kept separate from the JSONB array so they can be queried/filtered individually.

CREATE TABLE IF NOT EXISTS trust_signal_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES trust_risk_cases(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Signal type identifier.
  signal        VARCHAR(80) NOT NULL,

  -- Numeric weight contributed by this signal.
  score         INTEGER NOT NULL DEFAULT 0,

  -- Free-form detail explaining why this signal fired.
  detail        TEXT,

  -- Reference to the source entity (booking id, report id, etc.) — nullable.
  source_type   VARCHAR(50),
  source_id     UUID,

  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_signal_events_case
  ON trust_signal_events (case_id);

CREATE INDEX IF NOT EXISTS idx_trust_signal_events_user
  ON trust_signal_events (user_id, signal);

COMMENT ON TABLE trust_risk_cases IS
  'Risk evaluation cases for users who exceed signal thresholds. '
  'Every automated action is reversible and every override is audited.';

COMMENT ON TABLE trust_signal_events IS
  'Individual signal firings that contribute to a trust risk case score.';
