-- Migration: 00066_stellar_payment_confirmation.sql
-- Stellar network + confirmation polling state for payments (#622).

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS stellar_network TEXT,
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_confirmation_status_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_confirmation_status_check
  CHECK (
    confirmation_status IS NULL
    OR confirmation_status IN (
      'not_found',
      'pending',
      'failed',
      'confirmed',
      'awaiting_reconciliation'
    )
  );

CREATE INDEX IF NOT EXISTS idx_payments_confirmation_status
  ON payments (confirmation_status)
  WHERE confirmation_status IS NOT NULL;

COMMENT ON COLUMN payments.stellar_network IS 'Stellar network (testnet|mainnet) used when the tx was submitted.';
COMMENT ON COLUMN payments.confirmation_status IS 'Last Horizon confirmation poll outcome (#622).';
