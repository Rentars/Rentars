-- Migration: exec_explain helper for query-plan benchmark tests
--
-- Creates a SECURITY DEFINER function that wraps EXPLAIN (ANALYZE false,
-- FORMAT JSON) so the search benchmark tests can inspect query plans via the
-- Supabase JS RPC interface without direct database access.
--
-- Access: restricted to the service_role only via row-level policy on the
-- supabase_functions schema.  The function is a no-op in production traffic;
-- it is called only by the test suite.
--
-- To skip plan assertions entirely (e.g. in CI without a real DB), simply do
-- not apply this migration — the benchmark tests detect the missing function
-- and skip those assertions with a clear log message.

CREATE OR REPLACE FUNCTION exec_explain(
  query  text,
  params jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Only allow EXPLAIN statements; reject anything that modifies data.
  IF lower(trim(query)) NOT LIKE 'select%'
    AND lower(trim(query)) NOT LIKE 'with%'
  THEN
    RAISE EXCEPTION 'exec_explain: only SELECT / CTE queries are permitted';
  END IF;

  EXECUTE format('EXPLAIN (ANALYZE false, FORMAT JSON) %s', query)
    INTO result;

  RETURN result;
END;
$$;

-- Revoke public execute; grant only to service_role (used by test runner).
REVOKE EXECUTE ON FUNCTION exec_explain(text, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION exec_explain(text, jsonb) TO service_role;

COMMENT ON FUNCTION exec_explain IS
  'Returns EXPLAIN (ANALYZE false) JSON for a SELECT query. '
  'Used by the search benchmark test suite to assert index usage. '
  'Never called in production request paths.';
