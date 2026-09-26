-- Migration 00061: Search performance tracking and observability
-- Adds columns for tracking query duration, cache hits/misses, and performance metrics

-- Add performance tracking columns to search_analytics table
ALTER TABLE search_analytics ADD COLUMN IF NOT EXISTS query_duration_ms INTEGER;
ALTER TABLE search_analytics ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN DEFAULT FALSE;
ALTER TABLE search_analytics ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255);

-- Create indexes for efficient performance metric queries
CREATE INDEX IF NOT EXISTS idx_search_analytics_duration
ON search_analytics (query_duration_ms DESC) WHERE query_duration_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_search_analytics_cache_hit
ON search_analytics (cache_hit, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_analytics_endpoint
ON search_analytics (endpoint, created_at DESC) WHERE endpoint IS NOT NULL;

-- Create a table for storing performance alerts and thresholds
CREATE TABLE IF NOT EXISTS search_performance_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type VARCHAR(50) NOT NULL,
  threshold_value NUMERIC,
  actual_value NUMERIC,
  triggered_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  details JSONB
);

-- Index for finding active alerts
CREATE INDEX IF NOT EXISTS idx_search_performance_alerts_active
ON search_performance_alerts (triggered_at DESC) WHERE resolved_at IS NULL;

-- Create function for calculating percentile latency (useful for dashboard queries)
CREATE OR REPLACE FUNCTION get_latency_percentiles(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ,
  p_percentile INTEGER DEFAULT 95
)
RETURNS TABLE (
  percentile_value INTEGER,
  latency_ms INTEGER
) AS $$
WITH sorted_latencies AS (
  SELECT query_duration_ms,
         ROW_NUMBER() OVER (ORDER BY query_duration_ms) as rn,
         COUNT(*) OVER () as total
  FROM search_analytics
  WHERE created_at >= p_start_date
    AND created_at <= p_end_date
    AND query_duration_ms IS NOT NULL
)
SELECT p_percentile::INTEGER,
       (array_agg(query_duration_ms ORDER BY query_duration_ms))[
         CEIL(total * p_percentile / 100.0)::INT
       ]::INTEGER as latency_ms
FROM sorted_latencies
LIMIT 1;
$$ LANGUAGE SQL;

-- Create function for cache hit rate calculation
CREATE OR REPLACE FUNCTION get_cache_hit_rate(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ
)
RETURNS TABLE (
  total_requests BIGINT,
  cache_hits BIGINT,
  cache_misses BIGINT,
  hit_rate NUMERIC
) AS $$
SELECT
  COUNT(*)::BIGINT as total_requests,
  SUM(CASE WHEN cache_hit = TRUE THEN 1 ELSE 0 END)::BIGINT as cache_hits,
  SUM(CASE WHEN cache_hit = FALSE THEN 1 ELSE 0 END)::BIGINT as cache_misses,
  ROUND(
    SUM(CASE WHEN cache_hit = TRUE THEN 1 ELSE 0 END)::NUMERIC / COUNT(*)::NUMERIC,
    4
  ) as hit_rate
FROM search_analytics
WHERE created_at >= p_start_date
  AND created_at <= p_end_date;
$$ LANGUAGE SQL;

-- Create function for error rate calculation
CREATE OR REPLACE FUNCTION get_search_error_rate(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ
)
RETURNS TABLE (
  total_requests BIGINT,
  error_count BIGINT,
  error_rate NUMERIC,
  endpoints_with_errors TEXT[]
) AS $$
SELECT
  COUNT(*)::BIGINT as total_requests,
  COUNT(CASE WHEN result_count IS NULL THEN 1 END)::BIGINT as error_count,
  ROUND(
    COUNT(CASE WHEN result_count IS NULL THEN 1 END)::NUMERIC / COUNT(*)::NUMERIC,
    4
  ) as error_rate,
  array_agg(DISTINCT endpoint ORDER BY endpoint) as endpoints_with_errors
FROM search_analytics
WHERE created_at >= p_start_date
  AND created_at <= p_end_date;
$$ LANGUAGE SQL;

-- Create materialized view for hourly aggregated metrics (for dashboard performance)
CREATE MATERIALIZED VIEW IF NOT EXISTS search_metrics_hourly AS
SELECT
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as query_count,
  ROUND(AVG(query_duration_ms)::NUMERIC, 2) as avg_latency_ms,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY query_duration_ms) as p50_latency_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY query_duration_ms) as p95_latency_ms,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY query_duration_ms) as p99_latency_ms,
  ROUND(
    SUM(CASE WHEN cache_hit = TRUE THEN 1 ELSE 0 END)::NUMERIC / COUNT(*)::NUMERIC,
    4
  ) as cache_hit_rate,
  SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) as successful_queries
FROM search_analytics
WHERE query_duration_ms IS NOT NULL
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;

-- Create index on materialized view for faster queries
CREATE INDEX IF NOT EXISTS idx_search_metrics_hourly_hour
ON search_metrics_hourly (hour DESC);

-- Grant permissions to monitoring users (if they exist)
-- Uncomment and modify as needed:
-- GRANT SELECT ON search_analytics TO monitoring_user;
-- GRANT SELECT ON search_performance_alerts TO monitoring_user;
-- GRANT SELECT ON search_metrics_hourly TO monitoring_user;
