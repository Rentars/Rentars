-- Migration: Account export and deletion lifecycle (#744)
-- Purpose:
--   * data_exports: store the generated export payload so the user can fetch it
--     asynchronously. Payloads are cleared on expiry and on account deletion.
--   * account_deletions: record when the deletion was confirmed and when the
--     personal data was actually scrubbed, so completion is auditable without
--     retaining the personal data itself.
--
-- Retention windows (#984 Issue 089):
--   The retention windows below are the documented policy for each eligible
--   record class. They are recorded here so the policy lives next to the
--   schema it governs. Cleanup jobs read these windows from configuration and
--   must never delete protected records (active bookings, legal holds, records
--   required by audit or payment obligations).
--
--   * data_exports.export_payload      : cleared 7 days after generation
--                                        (expires_at), or immediately on
--                                        account deletion.
--   * data_exports (row)               : retained 30 days after expiry for
--                                        audit, then eligible for cleanup.
--   * account_deletions (pending)      : cancelled/expired after the
--                                        cancellation window
--                                        (cancel_expires_at).
--   * account_deletions (completed)    : retained 90 days after anonymised_at
--                                        for audit, then eligible for cleanup.
--   * expired auth tokens              : retained 30 days after expiry, then
--                                        eligible for cleanup.
--   * stale drafts                     : retained 90 days after last update,
--                                        then eligible for cleanup.
--   * orphaned images                  : retained 30 days after becoming
--                                        unreferenced, then eligible for
--                                        cleanup.
--   * soft-deleted listings            : retained 30 days after deleted_at,
--                                        then eligible for cleanup. Listings
--                                        with active bookings, legal holds, or
--                                        payment obligations are excluded.
--
--   Append-only audit tables are intentionally NOT modified by this migration.

ALTER TABLE data_exports
  ADD COLUMN IF NOT EXISTS export_payload JSONB;

ALTER TABLE account_deletions
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_blocked_reason TEXT;

-- Only one open deletion request per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletions_one_pending_per_user
  ON account_deletions(user_id)
  WHERE status = 'pending';

-- Worker lookup: pending requests whose cancellation window has elapsed.
CREATE INDEX IF NOT EXISTS idx_account_deletions_pending_due
  ON account_deletions(cancel_expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Retention cleanup checkpointing (#984 Issue 089)
-- ---------------------------------------------------------------------------
-- One row per cleanup job (record class). Tracks the last successfully
-- processed checkpoint so bounded batches are idempotent and resumable, and
-- records the outcome counts of the most recent run for observability.
CREATE TABLE IF NOT EXISTS retention_cleanup_checkpoints (
  job_name TEXT PRIMARY KEY,
  -- Opaque cursor (e.g. last processed id or timestamp) for resumable batches.
  last_checkpoint TEXT,
  -- Counts from the most recent run, for metrics/observability.
  last_run_at TIMESTAMP WITH TIME ZONE,
  last_deleted_count BIGINT NOT NULL DEFAULT 0,
  last_retained_count BIGINT NOT NULL DEFAULT 0,
  last_failed_count BIGINT NOT NULL DEFAULT 0,
  -- When true, the job only reports counts and performs no destructive work.
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes supporting bounded, ordered batch scans for eligible records.
-- ---------------------------------------------------------------------------

-- data_exports: eligible rows ordered by expiry for batched cleanup.
CREATE INDEX IF NOT EXISTS idx_data_exports_retention_eligible
  ON data_exports(expires_at)
  WHERE expires_at IS NOT NULL;

-- account_deletions: completed rows ordered by anonymisation time.
CREATE INDEX IF NOT EXISTS idx_account_deletions_retention_eligible
  ON account_deletions(anonymised_at)
  WHERE status = 'completed' AND anonymised_at IS NOT NULL;

-- expired auth tokens: ordered by expiry for batched cleanup.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_retention_eligible
  ON auth_tokens(expires_at)
  WHERE expires_at IS NOT NULL;

-- stale drafts: ordered by last update for batched cleanup.
CREATE INDEX IF NOT EXISTS idx_drafts_retention_eligible
  ON drafts(updated_at)
  WHERE status = 'draft';

-- orphaned images: ordered by creation for batched cleanup.
CREATE INDEX IF NOT EXISTS idx_images_retention_eligible
  ON images(created_at)
  WHERE listing_id IS NULL;

-- soft-deleted listings: ordered by deletion time for batched cleanup.
CREATE INDEX IF NOT EXISTS idx_listings_retention_eligible
  ON listings(deleted_at)
  WHERE deleted_at IS NOT NULL;