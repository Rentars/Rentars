/**
 * Property service — rich filtering, pagination, featured listings,
 * availability ranges, and p-limit concurrency control for parallel
 * blockchain + DB operations.
 */

import pLimit from 'p-limit';
import { supabase } from '../config/supabase.js';
import { ALLOWED_AMENITIES, type Amenity } from '../validators/property.validator.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PropertyFilters {
  city?: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  amenities?: Amenity[];
  check_in?: string;   // ISO date string YYYY-MM-DD
  check_out?: string;  // ISO date string YYYY-MM-DD
  max_guests?: number;
  page?: number;
  limit?: number;
}

export interface PaginatedProperties {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AvailabilityRange {
  start_date: string;
  end_date: string;
  reason?: 'booked' | 'blocked';
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

/**
 * Limits concurrent parallel operations (e.g. blockchain + DB calls) to
 * avoid overwhelming the Stellar RPC node or Supabase connection pool.
 */
const limit = pLimit(5);

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Search properties with rich filtering and pagination.
 *
 * Supports: city, country, price range, amenities, availability dates,
 * max_guests, page, and limit.
 */
export async function searchProperties(
  filters: PropertyFilters,
): Promise<PaginatedProperties> {
  const {
    city,
    country,
    min_price,
    max_price,
    amenities,
    check_in,
    check_out,
    max_guests,
    page = 1,
    limit: pageLimit = 20,
  } = filters;

  const offset = (page - 1) * pageLimit;

  let query = supabase.from('properties').select('*', { count: 'exact' });

  // ── Location filters ──────────────────────────────────────────────────────
  if (city) {
    query = query.ilike('location->>city', `%${city}%`);
  }
  if (country) {
    query = query.ilike('location->>country', `%${country}%`);
  }

  // ── Price range filters ───────────────────────────────────────────────────
  if (min_price !== undefined) {
    query = query.gte('price_per_night', min_price);
  }
  if (max_price !== undefined) {
    query = query.lte('price_per_night', max_price);
  }

  // ── Guest capacity filter ─────────────────────────────────────────────────
  if (max_guests !== undefined) {
    query = query.gte('max_guests', max_guests);
  }

  // ── Amenities filter (property must contain ALL requested amenities) ───────
  if (amenities && amenities.length > 0) {
    // Supabase JSONB array containment: amenities column @> requested array
    query = query.contains('amenities', amenities);
  }

  // ── Availability filter (exclude properties with overlapping bookings) ─────
  if (check_in && check_out) {
    // Fetch property IDs that have active bookings overlapping the range
    const { data: bookedIds } = await supabase
      .from('bookings')
      .select('property_id')
      .neq('status', 'Cancelled')
      .lt('check_in', check_out)
      .gt('check_out', check_in);

    if (bookedIds && bookedIds.length > 0) {
      const ids = [...new Set(bookedIds.map((b) => b.property_id as string))];
      query = query.not('id', 'in', `(${ids.map((id) => `"${id}"`).join(',')})`);
    }
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  query = query.range(offset, offset + pageLimit - 1).order('created_at', { ascending: false });

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`Failed to search properties: ${error.message}`);
  }

  const total = count ?? 0;

  return {
    data: (data ?? []) as Record<string, unknown>[],
    total,
    page,
    limit: pageLimit,
    totalPages: Math.ceil(total / pageLimit),
  };
}

/**
 * Return properties marked as featured, ordered by creation date descending.
 */
export async function getFeaturedProperties(): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('featured', true)
    .order('created_at', { ascending: false })
    .limit(12);

  if (error) {
    throw new Error(`Failed to fetch featured properties: ${error.message}`);
  }

  return (data ?? []) as Record<string, unknown>[];
}

/**
 * Return all blocked/booked date ranges for a property.
 *
 * Combines:
 *   1. Active bookings from the `bookings` table (reason: 'booked')
 *   2. Manual blocks from the `availability_blocks` table (reason: 'blocked')
 */
export async function getAvailabilityRanges(
  propertyId: string,
): Promise<AvailabilityRange[]> {
  // Run both queries in parallel, limited by the concurrency limiter
  const [bookingsResult, blocksResult] = await Promise.all([
    limit(() =>
      supabase
        .from('bookings')
        .select('check_in, check_out')
        .eq('property_id', propertyId)
        .neq('status', 'Cancelled')
        .gte('check_out', new Date().toISOString().split('T')[0]),
    ),
    limit(() =>
      supabase
        .from('availability_blocks')
        .select('start_date, end_date')
        .eq('property_id', propertyId)
        .gte('end_date', new Date().toISOString().split('T')[0]),
    ),
  ]);

  if (bookingsResult.error) {
    throw new Error(`Failed to fetch bookings: ${bookingsResult.error.message}`);
  }
  if (blocksResult.error) {
    // availability_blocks table may not exist yet — degrade gracefully
    if (blocksResult.error.code === '42P01') {
      // Table does not exist; return only booking ranges
      return (bookingsResult.data ?? []).map((b) => ({
        start_date: b.check_in as string,
        end_date: b.check_out as string,
        reason: 'booked' as const,
      }));
    }
    throw new Error(`Failed to fetch availability blocks: ${blocksResult.error.message}`);
  }

  const bookedRanges: AvailabilityRange[] = (bookingsResult.data ?? []).map((b) => ({
    start_date: b.check_in as string,
    end_date: b.check_out as string,
    reason: 'booked' as const,
  }));

  const blockedRanges: AvailabilityRange[] = (blocksResult.data ?? []).map((b) => ({
    start_date: b.start_date as string,
    end_date: b.end_date as string,
    reason: 'blocked' as const,
  }));

  return [...bookedRanges, ...blockedRanges].sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime(),
  );
}

/**
 * Set (replace) manual availability blocks for a property.
 *
 * Owners use this to block dates that should not be bookable
 * (e.g. personal use, maintenance windows).
 *
 * Replaces all existing blocks for the property with the new set.
 */
export async function setAvailabilityRanges(
  propertyId: string,
  ownerId: string,
  ranges: Array<{ start_date: string; end_date: string }>,
): Promise<AvailabilityRange[]> {
  // Verify ownership before mutating
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', propertyId)
    .single();

  if (propError || !property) {
    throw new Error('Property not found');
  }

  if ((property as Record<string, unknown>).owner_id !== ownerId) {
    throw new Error('Forbidden: you do not own this property');
  }

  // Validate that all ranges are coherent
  for (const range of ranges) {
    if (new Date(range.end_date) <= new Date(range.start_date)) {
      throw new Error(
        `Invalid range: end_date (${range.end_date}) must be after start_date (${range.start_date})`,
      );
    }
  }

  // Delete existing blocks then insert new ones atomically via sequential ops
  // (Supabase JS v2 does not expose transactions directly)
  const { error: deleteError } = await supabase
    .from('availability_blocks')
    .delete()
    .eq('property_id', propertyId);

  if (deleteError && deleteError.code !== '42P01') {
    throw new Error(`Failed to clear existing blocks: ${deleteError.message}`);
  }

  if (ranges.length === 0) {
    return [];
  }

  const rows = ranges.map((r) => ({
    property_id: propertyId,
    start_date: r.start_date,
    end_date: r.end_date,
  }));

  const { data, error: insertError } = await supabase
    .from('availability_blocks')
    .insert(rows)
    .select();

  if (insertError) {
    throw new Error(`Failed to save availability blocks: ${insertError.message}`);
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((b) => ({
    start_date: b.start_date as string,
    end_date: b.end_date as string,
    reason: 'blocked' as const,
  }));
}

/**
 * Validate that all amenities in the given array are in the allowed list.
 * Throws a descriptive error listing any unknown values.
 */
export function validateAmenities(amenities: string[]): asserts amenities is Amenity[] {
  const invalid = amenities.filter(
    (a) => !(ALLOWED_AMENITIES as readonly string[]).includes(a),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid amenities: ${invalid.join(', ')}. Allowed values: ${ALLOWED_AMENITIES.join(', ')}`,
    );
  }
}

/**
 * Run an array of async tasks with bounded concurrency using p-limit.
 *
 * Useful when a controller needs to fan out to both the blockchain and
 * Supabase simultaneously without overwhelming either service.
 *
 * @example
 * const results = await runConcurrent([
 *   () => blockchainClient.getListing(id),
 *   () => supabase.from('properties').select('*').eq('id', dbId).single(),
 * ]);
 */
export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = 5,
): Promise<T[]> {
  const limiter = pLimit(concurrency);
  return Promise.all(tasks.map((task) => limiter(task)));
}
