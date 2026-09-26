-- Migration 00065: Review eligibility snapshots
--
-- Captures eligibility state at the moment a booking transitions to Completed
-- so that support can explain why a review was or was not accepted, even if
-- the booking or modification records are later altered.
--
-- One row per booking, written atomically when status → Completed.
-- Immutable after creation (no UPDATE path is exposed).

CREATE TABLE IF NOT EXISTS review_eligibility_snapshots (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The booking this snapshot belongs to.
  booking_id           UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  -- Both participants at the time of completion.
  tenant_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id          UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,

  -- Was the booking ever disputed?
  had_dispute          BOOLEAN NOT NULL DEFAULT FALSE,

  -- Was a full refund issued (makes tenant-side review ineligible)?
  full_refund_issued   BOOLEAN NOT NULL DEFAULT FALSE,

  -- Was the booking modified at least once before completion?
  was_modified         BOOLEAN NOT NULL DEFAULT FALSE,

  -- The checkout date used for window calculation (may differ from original
  -- if a modification changed the dates).
  effective_check_out  DATE NOT NULL,

  -- Review window: how many days after checkout reviews are accepted.
  -- Defaults to 14; can be overridden per-property or per-platform-config.
  review_window_days   SMALLINT NOT NULL DEFAULT 14,

  -- Computed deadline (effective_check_out + review_window_days).
  review_deadline      TIMESTAMPTZ NOT NULL,

  -- Eligibility verdicts — snapshotted at completion time.
  -- TRUE = this participant may submit a review.
  tenant_eligible      BOOLEAN NOT NULL DEFAULT TRUE,
  host_eligible        BOOLEAN NOT NULL DEFAULT TRUE,

  -- Human-readable reason when a participant is ineligible.
  -- NULL when eligible.
  tenant_ineligible_reason  TEXT,
  host_ineligible_reason    TEXT,

  -- The booking status just before completion transition (for audit).
  prior_status         VARCHAR(50) NOT NULL DEFAULT 'Confirmed',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each booking gets exactly one eligibility snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_review_eligibility_booking
  ON review_eligibility_snapshots (booking_id);

-- Lookup by participant for support queries.
CREATE INDEX IF NOT EXISTS idx_review_eligibility_tenant
  ON review_eligibility_snapshots (tenant_id);

CREATE INDEX IF NOT EXISTS idx_review_eligibility_host
  ON review_eligibility_snapshots (host_id);

COMMENT ON TABLE review_eligibility_snapshots IS
  'Immutable snapshot of review eligibility captured when a booking completes. '
  'Used by the review service to validate submissions and by support to explain '
  'eligibility decisions.';
