-- Migration 00059: Verify and solidify search infrastructure
-- Ensures PostGIS extension, all required columns, functions, and indexes exist
-- Safe for deployment: idempotent with IF NOT EXISTS checks

-- 1. Ensure PostGIS extension is available
CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Ensure all required search columns exist
ALTER TABLE properties ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS location geography(POINT, 4326);

-- 3. Ensure geocoding metadata columns exist
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_provider VARCHAR(50);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_confidence DECIMAL(3, 2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_source_address TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoding_processed_at TIMESTAMPTZ;

-- 4. Ensure analytics table exists
CREATE TABLE IF NOT EXISTS search_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  filters JSONB DEFAULT NULL,
  result_count INTEGER DEFAULT 0,
  query_duration_ms INTEGER DEFAULT 0,
  cache_hit BOOLEAN DEFAULT FALSE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Recreate location update trigger
CREATE OR REPLACE FUNCTION properties_location_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location = ST_GeomFromText('POINT(' || NEW.longitude || ' ' || NEW.latitude || ')', 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_location_update ON properties;
CREATE TRIGGER trg_properties_location_update
BEFORE INSERT OR UPDATE OF latitude, longitude
ON properties
FOR EACH ROW
EXECUTE FUNCTION properties_location_update();

-- 6. Recreate weighted search vector trigger
CREATE OR REPLACE FUNCTION properties_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector =
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.city, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.amenities, ' '), '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_search_vector_update ON properties;
CREATE TRIGGER trg_properties_search_vector_update
BEFORE INSERT OR UPDATE OF title, description, city, amenities
ON properties
FOR EACH ROW
EXECUTE FUNCTION properties_search_vector_update();

-- 7. Ensure nearby search function exists
CREATE OR REPLACE FUNCTION search_nearby_properties(
  lat DECIMAL,
  lng DECIMAL,
  radius_km INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  price_per_night DECIMAL,
  city TEXT,
  country TEXT,
  bedrooms INTEGER,
  amenities TEXT[],
  distance_km DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.title,
    p.price_per_night,
    p.city,
    p.country,
    p.bedrooms,
    p.amenities,
    ROUND(ST_DistanceSphere(
      ST_Point(lng, lat)::geography,
      p.location
    ) / 1000)::DECIMAL AS distance_km
  FROM properties p
  WHERE p.status = 'available'
    AND p.location IS NOT NULL
    AND ST_DWithin(p.location, ST_Point(lng, lat)::geography, radius_km * 1000)
  ORDER BY distance_km ASC;
END;
$$ LANGUAGE plpgsql;

-- 8. Ensure ranked search function exists
CREATE OR REPLACE FUNCTION search_properties_ranked(
  search_query text,
  result_limit integer DEFAULT 20,
  result_offset integer DEFAULT 0
)
RETURNS SETOF jsonb AS $$
BEGIN
  RETURN QUERY
  SELECT to_jsonb(p.*) || jsonb_build_object('rank', ts_rank_cd(p.search_vector, plainto_tsquery('english', search_query)))
  FROM properties p
  WHERE p.search_vector @@ plainto_tsquery('english', search_query)
    AND p.deleted_at IS NULL
  ORDER BY ts_rank_cd(p.search_vector, plainto_tsquery('english', search_query)) DESC
  LIMIT result_limit
  OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;

-- 9. Ensure get_search_suggestions function exists
CREATE OR REPLACE FUNCTION get_search_suggestions(
  search_prefix TEXT,
  limit_count INTEGER DEFAULT 10
)
RETURNS TABLE (
  query TEXT,
  frequency BIGINT,
  result_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sa.query,
    COUNT(*)::BIGINT AS frequency,
    AVG(sa.result_count)::INTEGER AS result_count
  FROM search_analytics sa
  WHERE sa.query ILIKE search_prefix || '%'
  GROUP BY sa.query
  ORDER BY frequency DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- 10. Create all necessary indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_properties_search_vector_gin
ON properties USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS idx_properties_location_gist
ON properties USING GIST (location);

CREATE INDEX IF NOT EXISTS idx_properties_latitude_longitude
ON properties (latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_status
ON properties (status) WHERE status = 'available';

CREATE INDEX IF NOT EXISTS idx_properties_deleted_at
ON properties (deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_search_analytics_query
ON search_analytics (query ASC, created_at DESC) WHERE query IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_search_analytics_user_id
ON search_analytics (user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_search_analytics_created_at
ON search_analytics (created_at DESC);

-- 11. Verify PostGIS version is available
-- This is informational only and will not fail the migration
-- SELECT PostGIS_full_version();
