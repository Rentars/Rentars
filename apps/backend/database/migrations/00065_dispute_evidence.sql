-- Migration: 00065_dispute_evidence.sql
-- Dispute evidence attachments scoped to bookings (disputes).

CREATE TABLE IF NOT EXISTS dispute_evidence (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  uploader_id     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evidence_type   TEXT        NOT NULL
                  CHECK (evidence_type IN ('image', 'document', 'message_export', 'payment_proof')),
  storage_path    TEXT        NOT NULL,
  mime_type       TEXT        NOT NULL,
  size_bytes      BIGINT      NOT NULL CHECK (size_bytes > 0),
  visibility      TEXT        NOT NULL DEFAULT 'participant'
                  CHECK (visibility IN ('participant', 'moderator_only')),
  scan_status     TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (scan_status IN ('pending', 'clean', 'blocked')),
  retention_until TIMESTAMPTZ NOT NULL,
  anonymized_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_booking_id ON dispute_evidence(booking_id);
CREATE INDEX IF NOT EXISTS idx_dispute_evidence_retention_until ON dispute_evidence(retention_until)
  WHERE deleted_at IS NULL AND anonymized_at IS NULL;

COMMENT ON TABLE dispute_evidence IS 'Files and exports attached to booking disputes; retention and visibility enforced in application layer.';
