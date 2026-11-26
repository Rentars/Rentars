-- Add indexes and aggregation functions for search analytics dashboard

-- Index to support date-range aggregation queries
CREATE INDEX IF NOT EXISTS idx_search_analytics_created_at
ON search_analytics (created_at DESC);

-- Partial index for zero-result query lookups
CREATE INDEX IF NOT EXISTS idx_search_analytics_zero_result
ON search_analytics (created_at DESC)
WHERE result_count = 0;

-- Table to track suggestion events (offered / accepted)
CREATE TABLE IF NOT EXISTS search_suggestion_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN ('offered', 'accepted')),
  suggestion_type TEXT NOT NULL,
  original_query TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suggestion_events_created_at
ON search_suggestion_events (created_at DESC);

-- Aggregation function: top queries by frequency in a date range
-- Cohort suppression and date-range bounds are enforced server-side so they
-- cannot be bypassed by direct RPC calls.
CREATE OR REPLACE FUNCTION get_top_queries(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 20,
  p_min_cohort INTEGER DEFAULT 10
)
RETURNS TABLE (query TEXT, frequency BIGINT, avg_results INTEGER) AS $$
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'start and end dates are required';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'end date must be after start date';
  END IF;
  IF p_end_date - p_start_date > INTERVAL '366 days' THEN
    RAISE EXCEPTION 'date range exceeds maximum allowed window';
  END IF;
  IF p_min_cohort IS NULL OR p_min_cohort < 1 THEN
    RAISE EXCEPTION 'minimum cohort size must be at least 1';
  END IF;

  RETURN QUERY
  SELECT
    sa.query,
    COUNT(*)::BIGINT AS frequency,
    AVG(sa.result_count)::INTEGER AS avg_results
  FROM search_analytics sa
  WHERE sa.created_at >= p_start_date
    AND sa.created_at < p_end_date
  GROUP BY sa.query
  HAVING COUNT(*) >= p_min_cohort
  ORDER BY frequency DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Aggregation function: zero-result queries by frequency in a date range
CREATE OR REPLACE FUNCTION get_zero_result_queries(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 20,
  p_min_cohort INTEGER DEFAULT 10
)
RETURNS TABLE (query TEXT, frequency BIGINT) AS $$
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'start and end dates are required';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'end date must be after start date';
  END IF;
  IF p_end_date - p_start_date > INTERVAL '366 days' THEN
    RAISE EXCEPTION 'date range exceeds maximum allowed window';
  END IF;
  IF p_min_cohort IS NULL OR p_min_cohort < 1 THEN
    RAISE EXCEPTION 'minimum cohort size must be at least 1';
  END IF;

  RETURN QUERY
  SELECT
    sa.query,
    COUNT(*)::BIGINT AS frequency
  FROM search_analytics sa
  WHERE sa.created_at >= p_start_date
    AND sa.created_at < p_end_date
    AND sa.result_count = 0
  GROUP BY sa.query
  HAVING COUNT(*) >= p_min_cohort
  ORDER BY frequency DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- Aggregation function: daily search volume over a date range
CREATE OR REPLACE FUNCTION get_daily_search_volume(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ,
  p_min_cohort INTEGER DEFAULT 10
)
RETURNS TABLE (date DATE, count BIGINT) AS $$
BEGIN
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'start and end dates are required';
  END IF;
  IF p_end_date <= p_start_date THEN
    RAISE EXCEPTION 'end date must be after start date';
  END IF;
  IF p_end_date - p_start_date > INTERVAL '366 days' THEN
    RAISE EXCEPTION 'date range exceeds maximum allowed window';
  END IF;
  IF p_min_cohort IS NULL OR p_min_cohort < 1 THEN
    RAISE EXCEPTION 'minimum cohort size must be at least 1';
  END IF;

  RETURN QUERY
  SELECT
    DATE(sa.created_at AT TIME ZONE 'UTC') AS date,
    COUNT(*)::BIGINT AS count
  FROM search_analytics sa
  WHERE sa.created_at >= p_start_date
    AND sa.created_at < p_end_date
  GROUP BY DATE(sa.created_at AT TIME ZONE 'UTC')
  HAVING COUNT(*) >= p_min_cohort
  ORDER BY date ASC;
END;
$$ LANGUAGE plpgsql;
