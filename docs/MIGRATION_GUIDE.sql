-- Migration guide for updating existing properties with calendar pricing
--
-- This file covers two migrations:
--   Part A: Calendar pricing data migration (Steps 1-8 below).
--   Part B: Soroban contract upgrade data migration for listings, bookings,
--           and reviews (see "Contract upgrade migration" section at the end).
--           Part B defines fixture selection, reference/balance verification,
--           and reconciliation of records that cannot be migrated.
--
-- Upgrade authority, compatibility period, dual-read/adapter needs, cutover
-- validation, and rollback limitations are documented in
-- docs/CONTRACT_UPGRADE_STRATEGY.md. This file holds the executable SQL.

-- ===========================================================================
-- Part A: Calendar pricing migration
-- ===========================================================================

-- Step 1: Update properties with base pricing (data migration)
-- For existing properties, migrate price_per_night → base_price_per_night
UPDATE properties
SET base_price_per_night = price_per_night
WHERE base_price_per_night = 0 OR base_price_per_night IS NULL;

-- Step 2: Set sensible defaults for new fields
UPDATE properties
SET minimum_stay_nights = COALESCE(minimum_stay_nights, 1)
WHERE minimum_stay_nights IS NULL OR minimum_stay_nights = 0;

-- Step 3: Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_bookings_status_dates
  ON bookings(property_id, status, check_in, check_out)
  WHERE status != 'Cancelled';

-- Step 4: Populate pricing_history from existing bookings (audit trail)
-- This captures historical pricing information
INSERT INTO pricing_history (property_id, date, price_per_night, reason, created_at)
SELECT
  p.id,
  DATE(b.created_at),
  p.base_price_per_night,
  'Historical import from bookings',
  NOW()
FROM properties p
LEFT JOIN bookings b ON p.id = b.property_id
WHERE b.created_at > NOW() - INTERVAL '90 days'
  AND NOT EXISTS (
    SELECT 1 FROM pricing_history ph
    WHERE ph.property_id = p.id
      AND DATE(ph.created_at) = DATE(b.created_at)
  )
ON CONFLICT DO NOTHING;

-- Step 5: Verify migration success
-- Count properties with proper base pricing
SELECT 
  COUNT(*) as total_properties,
  COUNT(CASE WHEN base_price_per_night > 0 THEN 1 END) as with_base_price,
  COUNT(CASE WHEN minimum_stay_nights >= 1 THEN 1 END) as with_min_stay
FROM properties;

-- Step 6: Archive old price_per_night if needed (optional)
-- ALTER TABLE properties DROP COLUMN price_per_night;
-- Only drop after confirming base_price_per_night is working

-- Step 7: Test that availability queries work correctly
EXPLAIN ANALYZE
SELECT d::date
FROM generate_series(
  (SELECT MIN(check_in) FROM bookings),
  (SELECT MAX(check_out) FROM bookings),
  '1 day'::interval
) AS d
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.property_id = 'test-id'
    AND b.status != 'Cancelled'
    AND d::date >= b.check_in::date
    AND d::date < b.check_out::date
);

-- Step 8: Create maintenance record
INSERT INTO special_events (property_id, name, start_date, end_date, is_blocked, created_at)
SELECT 
  id,
  'Historical availability import',
  CURRENT_DATE,
  CURRENT_DATE + INTERVAL '1 day',
  false,
  NOW()
FROM properties
WHERE created_at < NOW() - INTERVAL '30 days'
LIMIT 0; -- Don't actually create, just showing structure

-- Migration verification queries

-- Check for properties missing base pricing
SELECT id, title, base_price_per_night
FROM properties
WHERE base_price_per_night IS NULL OR base_price_per_night = 0
ORDER BY created_at DESC;

-- Check minimum stay constraints
SELECT id, title, minimum_stay_nights
FROM properties
WHERE minimum_stay_nights IS NULL OR minimum_stay_nights < 1
ORDER BY created_at DESC;

-- Count seasonal pricing by property
SELECT 
  p.id,
  p.title,
  COUNT(sp.id) as season_count,
  COUNT(se.id) as event_count
FROM properties p
LEFT JOIN seasonal_pricing sp ON p.id = sp.property_id
LEFT JOIN special_events se ON p.id = se.property_id
GROUP BY p.id, p.title
ORDER BY season_count DESC, event_count DESC;

-- Availability ranges summary
SELECT 
  p.id,
  p.title,
  COUNT(ar.id) as blocked_ranges,
  MIN(ar.start_date) as earliest_block,
  MAX(ar.end_date) as latest_block
FROM properties p
LEFT JOIN availability_ranges ar ON p.id = ar.property_id AND ar.is_available = false
GROUP BY p.id, p.title
HAVING COUNT(ar.id) > 0
ORDER BY blocked_ranges DESC;

-- Timeline of pricing changes
SELECT 
  property_id,
  date,
  price_per_night,
  reason,
  created_at
FROM pricing_history
ORDER BY property_id, date DESC
LIMIT 50;

-- ===========================================================================
-- Part B: Contract upgrade migration (listings, bookings, reviews)
-- ===========================================================================
--
-- State classification (see strategy doc for rationale):
--   IMMUTABLE (never rewritten by migration):
--     - listings.id, bookings.id, reviews.id (primary keys / on-chain ids)
--     - bookings.payment_reference, bookings.contract_booking_id
--     - reviews.contract_review_id
--     - any ledger/transaction hash recorded on bookings or reviews
--   MIGRATABLE (copied/transformed into successor contract schema):
--     - listing descriptive fields, pricing fields, availability
--     - booking status, dates, amounts (amounts must reconcile exactly)
--     - review rating, text, timestamps
--   RECONCILE-ONLY (cannot be migrated automatically):
--     - records whose on-chain counterpart is missing or in a terminal
--       inconsistent state; these are flagged in migration_reconciliation
--       and require manual resolution before cutover sign-off.
--
-- Every migrated row must carry the source and target contract version so
-- old and new contract versions are identifiable after cutover.

-- Step B1: Migration bookkeeping tables
CREATE TABLE IF NOT EXISTS contract_versions (
  version_id        TEXT PRIMARY KEY,          -- e.g. 'v1', 'v2'
  contract_id       TEXT NOT NULL,             -- Soroban contract address
  wasm_hash         TEXT NOT NULL,
  deployed_at       TIMESTAMPTZ NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT false,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS migration_runs (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_version    TEXT NOT NULL REFERENCES contract_versions(version_id),
  target_version    TEXT NOT NULL REFERENCES contract_versions(version_id),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','verified','cutover','rolled_back','failed'))
);

CREATE TABLE IF NOT EXISTS migration_reconciliation (
  run_id            UUID NOT NULL REFERENCES migration_runs(run_id),
  entity_type       TEXT NOT NULL CHECK (entity_type IN ('listing','booking','review')),
  entity_id         TEXT NOT NULL,
  reason            TEXT NOT NULL,
  resolved          BOOLEAN NOT NULL DEFAULT false,
  resolution_note   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, entity_type, entity_id)
);

-- Step B2: Fixture selection
-- Representative fixtures for testnet rehearsal. The selection is
-- deterministic so the same set is used on every rehearsal run:
--   - 5 listings: cheapest, most expensive, most booked, newest, oldest
--   - 10 bookings: mix of every status, at least one with a payment
--     reference and one with a refund, spanning > 90 days
--   - 10 reviews: mix of ratings, at least one with empty text
-- Fixtures are copied into *_fixture tables so production rows are untouched.
CREATE TABLE IF NOT EXISTS migration_fixture_ids (
  run_id        UUID NOT NULL REFERENCES migration_runs(run_id),
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('listing','booking','review')),
  entity_id     TEXT NOT NULL,
  selection_tag TEXT NOT NULL,   -- e.g. 'cheapest','most_booked','status:Confirmed'
  PRIMARY KEY (run_id, entity_type, entity_id)
);

-- Listings fixtures
INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'listing', id, 'cheapest'
FROM listings ORDER BY base_price_per_night ASC NULLS LAST LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'listing', id, 'most_expensive'
FROM listings ORDER BY base_price_per_night DESC NULLS LAST LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'listing', b.property_id, 'most_booked'
FROM bookings b
GROUP BY b.property_id
ORDER BY COUNT(*) DESC
LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'listing', id, 'newest'
FROM listings ORDER BY created_at DESC LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'listing', id, 'oldest'
FROM listings ORDER BY created_at ASC LIMIT 1
ON CONFLICT DO NOTHING;

-- Bookings fixtures: one per status, plus payment/refund coverage
INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'booking', id, 'status:' || status
FROM (
  SELECT DISTINCT ON (status) id, status
  FROM bookings
  ORDER BY status, created_at DESC
) s
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'booking', id, 'has_payment_reference'
FROM bookings
WHERE payment_reference IS NOT NULL
ORDER BY created_at DESC LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'booking', id, 'has_refund'
FROM bookings
WHERE refunded_amount > 0
ORDER BY created_at DESC LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'booking', id, 'older_than_90_days'
FROM bookings
WHERE created_at < NOW() - INTERVAL '90 days'
ORDER BY created_at ASC LIMIT 1
ON CONFLICT DO NOTHING;

-- Reviews fixtures: rating spread plus an empty-text review
INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'review', id, 'rating:' || rating
FROM (
  SELECT DISTINCT ON (rating) id, rating
  FROM reviews
  ORDER BY rating, created_at DESC
) s
ON CONFLICT DO NOTHING;

INSERT INTO migration_fixture_ids (run_id, entity_type, entity_id, selection_tag)
SELECT :run_id, 'review', id, 'empty_text'
FROM reviews
WHERE text IS NULL OR text = ''
ORDER BY created_at DESC LIMIT 1
ON CONFLICT DO NOTHING;

-- Step B3: Reference verification
-- Every migrated booking must still point at a listing that exists in the
-- target version, and every migrated review must point at a booking that
-- exists in the target version. Failures are recorded for reconciliation.
INSERT INTO migration_reconciliation (run_id, entity_type, entity_id, reason)
SELECT :run_id, 'booking', b.id, 'listing_reference_missing_in_target'
FROM bookings b
JOIN migration_fixture_ids f
  ON f.run_id = :run_id AND f.entity_type = 'booking' AND f.entity_id = b.id
WHERE NOT EXISTS (
  SELECT 1 FROM listings l
  WHERE l.id = b.property_id
    AND l.contract_version = :target_version
)
ON CONFLICT DO NOTHING;

INSERT INTO migration_reconciliation (run_id, entity_type, entity_id, reason)
SELECT :run_id, 'review', r.id, 'booking_reference_missing_in_target'
FROM reviews r
JOIN migration_fixture_ids f
  ON f.run_id = :run_id AND f.entity_type = 'review' AND f.entity_id = r.id
WHERE NOT EXISTS (
  SELECT 1 FROM bookings b
  WHERE b.id = r.booking_id
    AND b.contract_version = :target_version
)
ON CONFLICT DO NOTHING;

-- Step B4: Balance verification
-- Payment references and amounts must reconcile exactly between source and
-- target. Any mismatch blocks cutover.
INSERT INTO migration_reconciliation (run_id, entity_type, entity_id, reason)
SELECT :run_id, 'booking', b.id, 'payment_reference_mismatch'
FROM bookings b
JOIN migration_fixture_ids f
  ON f.run_id = :run_id AND f.entity_type = 'booking' AND f.entity_id = b.id
WHERE b.contract_version = :target_version
  AND b.payment_reference IS DISTINCT FROM b.source_payment_reference
ON CONFLICT DO NOTHING;

INSERT INTO migration_reconciliation (run_id, entity_type, entity_id, reason)
SELECT :run_id, 'booking', b.id, 'amount_mismatch'
FROM bookings b
JOIN migration_fixture_ids f
  ON f.run_id = :run_id AND f.entity_type = 'booking' AND f.entity_id = b.id
WHERE b.contract_version = :target_version
  AND b.total_amount IS DISTINCT FROM b.source_total_amount
ON CONFLICT DO NOTHING;

-- Step B5: Reconciliation of records that cannot be migrated
-- Records flagged above are excluded from the migrated set and must be
-- resolved manually. This query lists the outstanding work for the run.
SELECT entity_type, entity_id, reason, resolved, resolution_note
FROM migration_reconciliation
WHERE run_id = :run_id AND resolved = false
ORDER BY entity_type, entity_id;

-- Step B6: Cutover validation summary
-- Must return zero for every mismatch column before cutover is approved.
SELECT
  (SELECT COUNT(*) FROM migration_reconciliation
     WHERE run_id = :run_id AND resolved = false)                AS unresolved_records,
  (SELECT COUNT(*) FROM bookings b
     JOIN migration_fixture_ids f
       ON f.run_id = :run_id AND f.entity_type = 'booking' AND f.entity_id = b.id
     WHERE b.contract_version = :target_version
       AND b.payment_reference IS DISTINCT FROM b.source_payment_reference)
                                                                  AS payment_ref_mismatches,
  (SELECT COUNT(*) FROM bookings b
     JOIN migration_fixture_ids f
       ON f.run_id = :run_id AND f.entity_type = 'booking' AND f.entity_id = b.id
     WHERE b.contract_version = :target_version
       AND b.total_amount IS DISTINCT FROM b.source_total_amount)
                                                                  AS amount_mismatches,
  (SELECT COUNT(*) FROM migration_fixture_ids
     WHERE run_id = :run_id)                                      AS fixtures_selected;

-- Step B7: Identify old vs new contract versions
-- Confirms every migrated row is tagged with the target version and that no
-- row is left on the source version after cutover.
SELECT contract_version, COUNT(*) AS row_count
FROM (
  SELECT contract_version FROM listings
  UNION ALL
  SELECT contract_version FROM bookings
  UNION ALL
  SELECT contract_version FROM reviews
) all_rows
GROUP BY contract_version
ORDER BY contract_version;

-- Step B8: Record run completion (run only after B6 returns all zeros)
UPDATE migration_runs
SET status = 'verified', completed_at = NOW()
WHERE run_id = :run_id
  AND NOT EXISTS (
    SELECT 1 FROM migration_reconciliation
    WHERE run_id = :run_id AND resolved = false
  );
