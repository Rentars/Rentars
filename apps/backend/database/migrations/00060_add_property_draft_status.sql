-- Add draft status for property listing workflow
-- Allows hosts to save incomplete listings and resume later

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS draft_status VARCHAR(50) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS publish_at TIMESTAMP;

-- Create enum type for draft status if not exists
DO $$ BEGIN
  CREATE TYPE property_draft_status AS ENUM ('draft', 'active', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Create partial index for draft listings
CREATE INDEX IF NOT EXISTS idx_properties_draft_owner
  ON properties(owner_id, draft_status)
  WHERE draft_status = 'draft';

-- Create partial index for scheduled publishes
CREATE INDEX IF NOT EXISTS idx_properties_publish_at
  ON properties(publish_at)
  WHERE draft_status = 'active' AND publish_at IS NOT NULL;

-- Add constraint for required fields in active listings
ALTER TABLE properties
  ADD CONSTRAINT chk_active_properties_required
  CHECK (draft_status = 'draft' OR (title IS NOT NULL AND price_per_night IS NOT NULL));
