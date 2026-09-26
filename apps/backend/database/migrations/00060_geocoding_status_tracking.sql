-- Migration 00060: Geocoding status tracking and validation
-- Tracks geocoding status, provider information, confidence scores, and correction workflows

-- Ensure all geocoding-related columns exist
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_provider VARCHAR(50);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_confidence DECIMAL(3, 2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_source_address TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_processed_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_original_address TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS requires_geocoding_review BOOLEAN DEFAULT FALSE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_notes TEXT;

-- Create geocoding audit log table for tracking correction workflows
CREATE TABLE IF NOT EXISTS geocoding_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  original_latitude DECIMAL(10, 8),
  original_longitude DECIMAL(11, 8),
  corrected_latitude DECIMAL(10, 8),
  corrected_longitude DECIMAL(11, 8),
  correction_reason VARCHAR(255),
  corrected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for finding properties needing geocoding review
CREATE INDEX IF NOT EXISTS idx_properties_requires_geocoding_review
ON properties (requires_geocoding_review) WHERE requires_geocoding_review = TRUE;

-- Index for geocoding status
CREATE INDEX IF NOT EXISTS idx_properties_geocoding_status
ON properties (geocoding_status);

-- Index for finding corrections by property
CREATE INDEX IF NOT EXISTS idx_geocoding_corrections_property_id
ON geocoding_corrections (property_id, created_at DESC);

-- Create function to update geocoding status after changes
CREATE OR REPLACE FUNCTION update_geocoding_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    IF NEW.geocoding_status IS NULL OR NEW.geocoding_status = 'pending' THEN
      NEW.geocoding_status = 'completed';
    END IF;
  ELSIF NEW.geocoding_status IS NULL THEN
    NEW.geocoding_status = 'pending';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_geocoding_status ON properties;
CREATE TRIGGER trg_update_geocoding_status
BEFORE INSERT OR UPDATE OF latitude, longitude, geocoding_status
ON properties
FOR EACH ROW
EXECUTE FUNCTION update_geocoding_status();
