-- Create property_images table for multi-image support with ordering and primary image
CREATE TABLE IF NOT EXISTS property_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  display_order INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_property_images_property_id ON property_images(property_id);

-- Ensure only one primary image per property
CREATE UNIQUE INDEX IF NOT EXISTS idx_property_images_primary ON property_images(property_id) WHERE is_primary = true;

-- RLS: owners manage their images; anyone can read
ALTER TABLE property_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can manage property images" ON property_images
  USING (
    EXISTS (SELECT 1 FROM properties WHERE properties.id = property_id AND properties.owner_id = auth.uid())
  );

CREATE POLICY "Anyone can read property images" ON property_images
  FOR SELECT USING (true);
