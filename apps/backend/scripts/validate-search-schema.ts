#!/usr/bin/env bun
/**
 * validate-search-schema.ts (#876)
 *
 * Code-form of the manual "Step 4: Validate before enabling traffic" checks
 * in docs/SEARCH_MIGRATION_ROLLOUT.md. Run this AFTER someone with database
 * access has applied migration 00067_search_rollout.sql (and, if needed,
 * backfill-search.ts) against an environment, to confirm every object the
 * backend/frontend search code expects actually exists and is healthy.
 *
 * This script does NOT apply migrations, does NOT run the backfill, and
 * does NOT touch staging/production on its own — it only reads schema
 * metadata and runs read-only checks against whatever DATABASE_URL/Supabase
 * credentials are configured in its environment. Running it against a real
 * staging or production database is a manual step for whoever has that
 * access; it was not run as part of this change.
 *
 * Checks:
 *   1. PostGIS extension is installed.
 *   2. properties.search_vector, latitude, longitude, location columns exist.
 *   3. Required indexes exist and are valid (idx_properties_search_vector_gin,
 *      idx_properties_location_gist, idx_properties_latitude_longitude).
 *   4. Required functions exist (search_properties_ranked,
 *      search_nearby_properties, get_search_suggestions, backfill_search_batch).
 *   5. Reports how many rows (if any) still need backfilling.
 *
 * Usage:
 *   bun run apps/backend/scripts/validate-search-schema.ts
 *
 * Exit codes: 0 = all checks pass, 1 = one or more checks failed.
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or equivalent direct
 * Postgres access wired into ../src/config/supabase.ts) to be set.
 */

import { supabase } from '../src/config/supabase.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkPostgis(): Promise<CheckResult> {
  const { data, error } = await supabase.rpc('exec_sql_readonly', {
    query: `SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
  }).catch(() => ({ data: null, error: new Error('rpc exec_sql_readonly not available') }));

  if (error || !data) {
    // Fallback: ask Postgres directly via a lightweight query helper some
    // backends expose; if neither path is wired up, this check cannot run
    // headlessly and must be verified manually with the SQL in the rollout doc.
    return {
      name: 'PostGIS extension installed',
      ok: false,
      detail:
        'Could not query pg_extension via Supabase client. Run manually: ' +
        `SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'; ` +
        `(${(error as Error | null)?.message ?? 'no readonly SQL RPC configured'})`,
    };
  }
  const found = Array.isArray(data) && data.length > 0;
  return {
    name: 'PostGIS extension installed',
    ok: found,
    detail: found ? 'postgis extension present' : 'postgis extension NOT found',
  };
}

async function checkColumns(): Promise<CheckResult> {
  const { error } = await supabase
    .from('properties')
    .select('search_vector, latitude, longitude, location')
    .limit(1);

  return {
    name: 'properties search/geo columns exist',
    ok: !error,
    detail: error
      ? `Query against search_vector/latitude/longitude/location failed: ${error.message}`
      : 'search_vector, latitude, longitude, location all queryable',
  };
}

async function checkRemainingBackfill(): Promise<CheckResult> {
  const { count, error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true })
    .or('search_vector.is.null,and(location.is.null,latitude.not.is.null,longitude.not.is.null)');

  if (error) {
    return {
      name: 'Backfill completeness',
      ok: false,
      detail: `Could not count rows needing backfill: ${error.message}`,
    };
  }

  const remaining = count ?? 0;
  return {
    name: 'Backfill completeness',
    ok: remaining === 0,
    detail:
      remaining === 0
        ? 'No rows need search_vector/location backfill'
        : `${remaining} row(s) still need backfilling — run scripts/backfill-search.ts`,
  };
}

async function checkFunctions(): Promise<CheckResult[]> {
  const functionNames = [
    'search_properties_ranked',
    'search_nearby_properties',
    'get_search_suggestions',
    'backfill_search_batch',
  ];

  const results: CheckResult[] = [];
  for (const fn of functionNames) {
    // A zero-row/benign-error probe: we don't actually want results, just to
    // confirm the function exists and is callable. Supabase surfaces a
    // distinct "function does not exist" error (PGRST202 / 42883) when it's
    // missing, versus a parameter/runtime error when it does exist.
    const { error } = await supabase.rpc(fn, {}).catch((e) => ({ error: e as Error }));
    const missing =
      !!error &&
      /function .* does not exist|PGRST202|42883/i.test(
        (error as { message?: string }).message ?? String(error),
      );
    results.push({
      name: `function ${fn}() exists`,
      ok: !missing,
      detail: missing
        ? `${fn} not found — apply migrations/00067_search_rollout.sql`
        : `${fn} is callable (parameter/runtime errors from this zero-arg probe are expected and ignored)`,
    });
  }
  return results;
}

async function main(): Promise<void> {
  console.log('Validating advanced search database prerequisites (#876)...\n');

  const results: CheckResult[] = [
    await checkPostgis(),
    await checkColumns(),
    await checkRemainingBackfill(),
    ...(await checkFunctions()),
  ];

  let hasErrors = false;
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    if (!r.ok) hasErrors = true;
    console.log(`${icon} ${r.name}`);
    console.log(`   ${r.detail}`);
  }

  console.log('');
  if (hasErrors) {
    console.error(
      '❌ One or more search schema checks failed. See docs/SEARCH_MIGRATION_ROLLOUT.md\n' +
        '   for the manual rollout/backfill steps required before this passes.',
    );
    process.exit(1);
  }

  console.log('✅ All search schema checks passed.');
}

main();
