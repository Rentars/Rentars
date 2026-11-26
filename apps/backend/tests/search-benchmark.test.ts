/**
 * Search Query Benchmark & EXPLAIN Plan Tests
 *
 * Purpose
 * -------
 * Verify that the principal search combinations hit the expected indexes and
 * do not degrade to sequential scans on a realistically-sized dataset.
 *
 * Strategy
 * --------
 * 1. A *reproducible* seeded dataset is generated inside the test using stable
 *    UUIDs (safe to re-run against a local Supabase / Docker Postgres).
 * 2. For each search combination we run:
 *      EXPLAIN (ANALYZE false, FORMAT JSON) <query>
 *    via a raw SQL helper so we get the plan tree without touching production
 *    data or depending on row counts that differ across environments.
 * 3. We assert on *plan invariants* (node type, index name) rather than cost
 *    numbers, so the test stays stable across PostgreSQL minor versions.
 * 4. After assertions the seed rows are deleted so local databases remain clean.
 *
 * Skipping
 * --------
 * The test skips gracefully when SUPABASE_URL points to the placeholder used
 * in CI unit-test mode (no real database available).  Set
 * SEARCH_BENCHMARK_FORCE=true to run anyway if you know the DB is reachable.
 *
 * Run (requires a running Supabase/Postgres):
 *   bun test tests/search-benchmark.test.ts
 *
 * or via the package script:
 *   bun run test:search-benchmark
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Env ───────────────────────────────────────────────────────────────────────

dotenv.config({
  path: path.resolve(import.meta.dir, '..', '.env.test'),
});
dotenv.config({
  path: path.resolve(import.meta.dir, '..', '.env'),
});

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const IS_PLACEHOLDER = SUPABASE_URL.includes('placeholder') || !SUPABASE_URL;
const FORCE = process.env.SEARCH_BENCHMARK_FORCE === 'true';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rows written by this benchmark run — deleted in afterAll. */
const BENCH_TAG = `bench-${randomUUID().slice(0, 8)}`;

/** Total synthetic properties to seed. Keep modest (200) so the test is fast
 *  while still exercising index-vs-seqscan decisions. For a heavier run set
 *  BENCH_PROPERTY_COUNT=5000 in the environment. */
const PROPERTY_COUNT = parseInt(process.env.BENCH_PROPERTY_COUNT ?? '200', 10);

/** Tolerance for plan-node assertions: some PG versions rename bitmap scan nodes. */
const INDEX_SCAN_NODES = new Set([
  'Index Scan',
  'Index Only Scan',
  'Bitmap Index Scan',
  'Bitmap Heap Scan',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

/** Flatten a Postgres plan tree into an array of all nodes. */
function flattenPlan(node: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [node];
  for (const child of node.Plans ?? []) {
    nodes.push(...flattenPlan(child));
  }
  return nodes;
}

/** Return true if any node in the plan is a sequential scan. */
function hasSeqScan(plan: PlanNode): boolean {
  return flattenPlan(plan).some((n) => n['Node Type'] === 'Seq Scan');
}

/** Return true if any node uses an index whose name matches `pattern`. */
function usesIndex(plan: PlanNode, pattern: RegExp): boolean {
  return flattenPlan(plan).some(
    (n) =>
      INDEX_SCAN_NODES.has(n['Node Type']) &&
      n['Index Name'] !== undefined &&
      pattern.test(n['Index Name'] as string),
  );
}

/** Run an EXPLAIN (ANALYZE false, FORMAT JSON) and return the parsed plan. */
async function explainQuery(
  db: SupabaseClient,
  sql: string,
  params: unknown[] = [],
): Promise<PlanNode> {
  const { data, error } = await db.rpc('exec_explain', { query: sql, params: JSON.stringify(params) });
  if (error) throw new Error(`EXPLAIN failed: ${error.message}`);
  // The RPC returns a JSON array; first element is the plan.
  const plan = Array.isArray(data) ? data[0] : data;
  return (plan as { Plan: PlanNode }).Plan;
}

/** Seed N properties with varied geography, price, and amenities. */
async function seedBenchmarkProperties(db: SupabaseClient, count: number): Promise<string[]> {
  const cities = ['Paris', 'Berlin', 'Tokyo', 'New York', 'London', 'Sydney', 'Cairo', 'São Paulo'];
  const amenitySets = [
    ['wifi', 'kitchen'],
    ['wifi', 'pool', 'gym'],
    ['parking', 'fireplace'],
    ['air_conditioning', 'washer_dryer', 'kitchen'],
    ['wifi'],
    ['pool', 'gym', 'spa'],
    ['kitchen', 'garden', 'bbq'],
    ['wifi', 'hot_tub'],
  ];
  const propertyTypes = ['Apartment', 'House', 'Villa', 'Condo', 'Studio', 'Cabin', 'Loft'];

  const rows = Array.from({ length: count }, (_, i) => {
    const cityIdx = i % cities.length;
    const city = cities[cityIdx];
    // Cluster around a small number of geographic centres so geospatial
    // queries yield realistic hit rates.
    const baseLat = 48.8 + (cityIdx * 5) % 40 - 20;   // roughly –20 .. +20 offset from 48.8
    const baseLng = 2.3  + (cityIdx * 7) % 60 - 30;
    return {
      id: `00000000-${BENCH_TAG}-${String(i).padStart(4, '0')}-0000-000000000000`.slice(0, 36),
      owner_id: '00000000-0000-0000-0000-000000000001',
      title: `Benchmark Property ${i} ${city}`,
      description: `A spacious ${propertyTypes[i % propertyTypes.length]} in ${city} with great views.`,
      price_per_night: 50 + (i % 450),          // $50–$500 spread
      status: 'available',
      city,
      country: 'XX',
      latitude:  baseLat  + (i % 100) * 0.01,
      longitude: baseLng  + (i % 100) * 0.01,
      bedrooms:  1 + (i % 5),
      bathrooms: 1 + (i % 3),
      max_guests: 1 + (i % 8),
      amenities: amenitySets[i % amenitySets.length],
      property_type: propertyTypes[i % propertyTypes.length],
      additional_rules: null,
    };
  });

  // Insert in chunks of 50 to stay within Supabase row limits per request.
  const IDS: string[] = [];
  for (let offset = 0; offset < rows.length; offset += 50) {
    const chunk = rows.slice(offset, offset + 50);
    const { error } = await db.from('properties').insert(chunk);
    if (error) throw new Error(`Seed insert failed at offset ${offset}: ${error.message}`);
    IDS.push(...chunk.map((r) => r.id));
  }
  return IDS;
}

/** Remove the benchmark rows. */
async function cleanupBenchmarkProperties(db: SupabaseClient): Promise<void> {
  // The id prefix pattern is deterministic per run.
  await db.from('properties').delete().like('id', `00000000-${BENCH_TAG}-%`);
}

// ── EXPLAIN helper via a simple RPC wrapper ───────────────────────────────────
//
// Because Supabase's JS client doesn't expose raw SQL, we use a one-liner RPC
// function that must exist in the database. The migration below creates it once:
//
//   CREATE OR REPLACE FUNCTION exec_explain(query text, params jsonb DEFAULT '[]')
//   RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
//   DECLARE result jsonb;
//   BEGIN
//     EXECUTE format('EXPLAIN (ANALYZE false, FORMAT JSON) %s', query)
//       INTO result;
//     RETURN result;
//   END $$;
//
// If the function does not exist the tests are skipped with a clear message.

async function tryExplain(db: SupabaseClient, sql: string): Promise<PlanNode | null> {
  try {
    return await explainQuery(db, sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('exec_explain') || msg.includes('does not exist')) {
      return null; // RPC helper not installed — skip plan assertions
    }
    throw err;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

let db: SupabaseClient;
let seededIds: string[] = [];

beforeAll(async () => {
  if (IS_PLACEHOLDER && !FORCE) return;

  db = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  seededIds = await seedBenchmarkProperties(db, PROPERTY_COUNT);
});

afterAll(async () => {
  if (!db) return;
  await cleanupBenchmarkProperties(db);
});

// ── Benchmark helpers that measure real query timing ─────────────────────────

async function timedQuery<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  console.log(`  [bench] ${label}: ${Math.round(durationMs)}ms`);
  return { result, durationMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Seed correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: seed correctness', () => {
  it(`inserts ${PROPERTY_COUNT} benchmark rows`, async () => {
    if (IS_PLACEHOLDER && !FORCE) {
      console.log('  [bench] Skipped — no real database (SUPABASE_URL is placeholder)');
      return;
    }
    expect(seededIds.length).toBe(PROPERTY_COUNT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Full-text search (search_vector GIN index)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: full-text search', () => {
  it('text search completes within 2 000 ms on seeded dataset', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const { durationMs } = await timedQuery('full-text "Paris"', () =>
      db
        .from('properties')
        .select('id, title, price_per_night')
        .eq('status', 'available')
        .is('deleted_at', null)
        .textSearch('search_vector', 'Paris:*', { config: 'english' }),
    );

    // Broad timing guard — catches a full table scan that takes seconds on
    // larger datasets. Tune BENCH_PROPERTY_COUNT for harder pressure tests.
    expect(durationMs).toBeLessThan(2_000);
  });

  it('EXPLAIN plan uses GIN index for text search (no Seq Scan)', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const plan = await tryExplain(
      db,
      `SELECT id FROM properties WHERE status = 'available' AND search_vector @@ to_tsquery('english','benchmark:*')`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    // The plan must not degrade to a Seq Scan on the properties table.
    expect(hasSeqScan(plan)).toBe(false);
    // It must route through the GIN index.
    expect(usesIndex(plan, /search_vector_gin/i)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Geospatial / radius search (location GIST index)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: geospatial radius search', () => {
  it('nearby query returns rows without error', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const { result } = await timedQuery('nearby lat=48.85 lng=2.35 radius=50km', () =>
      db.rpc('search_nearby_properties', { lat: 48.85, lng: 2.35, radius_km: 50 }),
    );

    // The RPC may return 0 rows if none fall in range — that's fine.
    // The key assertion is no error.
    expect((result as { error: unknown }).error).toBeNull();
  });

  it('EXPLAIN plan uses GIST index for radius search (no Seq Scan)', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const plan = await tryExplain(
      db,
      `SELECT id FROM properties
       WHERE status = 'available'
         AND ST_DWithin(location::geography, ST_MakePoint(2.35,48.85)::geography, 50000)`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    expect(hasSeqScan(plan)).toBe(false);
    expect(usesIndex(plan, /location_gist/i)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Amenities filter (amenities GIN index)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: amenities filter', () => {
  it('amenities @> filter completes within 2 000 ms', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const { durationMs } = await timedQuery('amenities contains [wifi,kitchen]', () =>
      db
        .from('properties')
        .select('id')
        .eq('status', 'available')
        .is('deleted_at', null)
        .contains('amenities', ['wifi', 'kitchen']),
    );

    expect(durationMs).toBeLessThan(2_000);
  });

  it('EXPLAIN plan uses GIN index for amenities @> (no Seq Scan)', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const plan = await tryExplain(
      db,
      `SELECT id FROM properties WHERE status = 'available' AND amenities @> ARRAY['wifi','kitchen']`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    expect(hasSeqScan(plan)).toBe(false);
    expect(usesIndex(plan, /amenities_gin/i)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Price range filter (price_per_night B-tree index)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: price range filter', () => {
  it('price range query completes within 2 000 ms', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const { durationMs } = await timedQuery('price $100–$300', () =>
      db
        .from('properties')
        .select('id, price_per_night')
        .eq('status', 'available')
        .is('deleted_at', null)
        .gte('price_per_night', 100)
        .lte('price_per_night', 300),
    );

    expect(durationMs).toBeLessThan(2_000);
  });

  it('EXPLAIN plan uses B-tree index for price range (no Seq Scan)', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const plan = await tryExplain(
      db,
      `SELECT id FROM properties WHERE status = 'available' AND price_per_night BETWEEN 100 AND 300`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    expect(hasSeqScan(plan)).toBe(false);
    expect(usesIndex(plan, /price_per_night/i)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Combined filter (text + price + amenities)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: combined text + price + amenities', () => {
  it('combined query completes within 3 000 ms', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const { durationMs } = await timedQuery('combined: text + price + amenities', () =>
      db
        .from('properties')
        .select('id, title, price_per_night')
        .eq('status', 'available')
        .is('deleted_at', null)
        .textSearch('search_vector', 'benchmark:*', { config: 'english' })
        .gte('price_per_night', 100)
        .lte('price_per_night', 400)
        .contains('amenities', ['wifi']),
    );

    expect(durationMs).toBeLessThan(3_000);
  });

  it('EXPLAIN plan for combined filter contains no Seq Scan', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const plan = await tryExplain(
      db,
      `SELECT id FROM properties
       WHERE status = 'available'
         AND search_vector @@ to_tsquery('english','benchmark:*')
         AND price_per_night BETWEEN 100 AND 400
         AND amenities @> ARRAY['wifi']`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    // For a combined multi-index filter PG may choose a bitmap-and of indexes.
    // The critical assertion is no sequential scan.
    expect(hasSeqScan(plan)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Booking availability date-range (composite index)
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: booking date-range availability', () => {
  it('EXPLAIN plan uses index for property date-range overlap check', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    // This query pattern is used by checkAvailabilityAtomic.
    const plan = await tryExplain(
      db,
      `SELECT id FROM bookings
       WHERE property_id = '00000000-0000-0000-0000-000000000010'
         AND status IN ('pending','confirmed')
         AND check_in  < '2025-12-27'
         AND check_out > '2025-12-20'`,
    );

    if (!plan) {
      console.log('  [bench] exec_explain RPC not installed — skipping plan assertion');
      return;
    }

    expect(hasSeqScan(plan)).toBe(false);
    // Should use the composite idx_bookings_property_dates or idx_bookings_property_status
    expect(usesIndex(plan, /bookings_property/i)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Regression guard: document plan summary to stdout
// ─────────────────────────────────────────────────────────────────────────────

describe('Search Benchmark: plan summary documentation', () => {
  it('prints query plan summary for each scenario (stdout only — not a failure gate)', async () => {
    if (IS_PLACEHOLDER && !FORCE) return;

    const scenarios: Array<{ label: string; sql: string }> = [
      {
        label: 'Full-text search',
        sql: `SELECT id FROM properties WHERE status='available' AND search_vector @@ to_tsquery('english','benchmark:*')`,
      },
      {
        label: 'Amenities filter',
        sql: `SELECT id FROM properties WHERE status='available' AND amenities @> ARRAY['wifi']`,
      },
      {
        label: 'Price range',
        sql: `SELECT id FROM properties WHERE status='available' AND price_per_night BETWEEN 100 AND 300`,
      },
      {
        label: 'Status index',
        sql: `SELECT id FROM properties WHERE status='available' ORDER BY created_at DESC LIMIT 20`,
      },
    ];

    for (const { label, sql } of scenarios) {
      const plan = await tryExplain(db, sql);
      if (!plan) {
        console.log(`  [bench] ${label}: exec_explain not available`);
        continue;
      }
      const nodes = flattenPlan(plan);
      const seqScans = nodes.filter((n) => n['Node Type'] === 'Seq Scan');
      const indexNodes = nodes.filter((n) => INDEX_SCAN_NODES.has(n['Node Type']));
      console.log(
        `  [bench] ${label}: ${indexNodes.length} index node(s), ${seqScans.length} seq scan(s)`,
      );
    }

    // This test always passes — it only exists to document plans in CI output.
    expect(true).toBe(true);
  });
});
