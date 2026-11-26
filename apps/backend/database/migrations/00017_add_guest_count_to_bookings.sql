-- Migration: add guest_count to bookings table
-- Bookings now carry the number of guests so capacity can be enforced at query time.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_count INT NOT NULL DEFAULT 1
    CHECK (guest_count >= 1);

COMMENT ON COLUMN bookings.guest_count IS
  'Number of guests for this booking. Must not exceed properties.max_guests.';

-- ---------------------------------------------------------------------------
-- Capacity constraints and legacy backfill (Issue 047)
-- ---------------------------------------------------------------------------
-- Guest-count rules must agree across listing creation, search, quote, and
-- booking creation. This migration:
--   1. Adds CHECK constraints for valid stored capacities on properties.
--   2. Backfills legacy NULL / invalid guest_count values in bookings and
--      booking_modifications without defaulting to an unsafe capacity.
--   3. Adds CHECK constraints for valid stored guest counts on bookings and
--      booking_modifications.
--
-- Documented bounds:
--   * Minimum guests / capacity: 1 (a listing must accept at least one guest).
--   * Maximum capacity (properties.max_guests): 100. This is the documented
--     upper bound used consistently by the property validator, search service,
--     and booking validator. Values above this are rejected explicitly.
--   * Maximum booking guest_count: 100 (mirrors the property capacity bound).
--
-- Legacy handling:
--   * properties.max_guests: NULL or < 1 is clamped to 1 (the safe minimum),
--     and values above the documented upper bound are clamped to 100. This is
--     a backfill of stored data only; new writes are validated server-side and
--     rejected explicitly rather than clamped.
--   * bookings.guest_count / booking_modifications.guest_count: NULL or < 1 is
--     set to 1. Values above the documented upper bound are clamped to 100.
--     The backfill never raises a guest count, so it cannot create an
--     oversized reservation relative to a listing's capacity.
--   * All statements are idempotent: they only touch rows that violate the
--     constraints and are safe to re-run.

-- 1. Backfill properties.max_guests before adding constraints.
UPDATE properties
SET max_guests = 1
WHERE max_guests IS NULL OR max_guests < 1;

UPDATE properties
SET max_guests = 100
WHERE max_guests > 100;

-- 2. Add capacity constraints on properties.
ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_max_guests_check;

ALTER TABLE properties
  ADD CONSTRAINT properties_max_guests_check
    CHECK (max_guests >= 1 AND max_guests <= 100);

COMMENT ON COLUMN properties.max_guests IS
  'Maximum number of guests the listing accepts. Must be between 1 and 100.';

-- 3. Backfill legacy guest_count values in bookings.
UPDATE bookings
SET guest_count = 1
WHERE guest_count IS NULL OR guest_count < 1;

UPDATE bookings
SET guest_count = 100
WHERE guest_count > 100;

-- 4. Backfill legacy guest_count values in booking_modifications (if present).
DO $$
BEGIN
  IF to_regclass('booking_modifications') IS NOT NULL THEN
    EXECUTE 'UPDATE booking_modifications
             SET guest_count = 1
             WHERE guest_count IS NULL OR guest_count < 1';
    EXECUTE 'UPDATE booking_modifications
             SET guest_count = 100
             WHERE guest_count > 100';
  END IF;
END $$;

-- 5. Add guest-count constraints on bookings.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_guest_count_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_guest_count_check
    CHECK (guest_count >= 1 AND guest_count <= 100);

-- 6. Add guest-count constraints on booking_modifications (if present).
DO $$
BEGIN
  IF to_regclass('booking_modifications') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE booking_modifications
             DROP CONSTRAINT IF EXISTS booking_modifications_guest_count_check';
    EXECUTE 'ALTER TABLE booking_modifications
             ADD CONSTRAINT booking_modifications_guest_count_check
               CHECK (guest_count >= 1 AND guest_count <= 100)';
  END IF;
END $$;