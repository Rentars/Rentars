import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { Property } from './property.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavedSearch {
  id: string;
  user_id: string;
  name: string;
  filters: Record<string, unknown>;
  is_paused?: boolean;
  digest_frequency?: 'immediate' | 'daily' | 'weekly';
  created_at?: string;
  updated_at?: string;
  version?: number;
}

/** Subset of AdvancedSearchFilters relevant for matching a new property. */
export interface SavedSearchFilters {
  query?: string;
  city?: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  min_bathrooms?: number;
  guests?: number;
  amenities?: string[];
  property_types?: string[];
  checkIn?: string;
  checkOut?: string;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createSavedSearch(
  userId: string,
  name: string,
  filters: Record<string, unknown>,
): Promise<ServiceResponse<SavedSearch>> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: 'Search name is required' };
  }

  const { data, error } = await supabase
    .from('saved_searches')
    .insert({ user_id: userId, name: name.trim(), filters })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as SavedSearch };
}

export async function listSavedSearches(
  userId: string,
): Promise<ServiceResponse<SavedSearch[]>> {
  const { data, error } = await supabase
    .from('saved_searches')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as SavedSearch[] };
}

export async function updateSavedSearch(
  userId: string,
  searchId: string,
  updates: Partial<SavedSearch>,
): Promise<ServiceResponse<SavedSearch>> {
  const { data, error } = await supabase
    .from('saved_searches')
    .update(updates)
    .eq('id', searchId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as SavedSearch };
}

export async function pauseSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<SavedSearch>> {
  return updateSavedSearch(userId, searchId, { is_paused: true });
}

export async function resumeSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<SavedSearch>> {
  return updateSavedSearch(userId, searchId, { is_paused: false });
}

export async function updateDigestFrequency(
  userId: string,
  searchId: string,
  frequency: 'immediate' | 'daily' | 'weekly',
): Promise<ServiceResponse<SavedSearch>> {
  if (!['immediate', 'daily', 'weekly'].includes(frequency)) {
    return { success: false, error: 'Invalid digest frequency' };
  }
  return updateSavedSearch(userId, searchId, { digest_frequency: frequency });
}

export async function deleteSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('saved_searches')
    .delete()
    .eq('id', searchId)
    .eq('user_id', userId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Matcher ──────────────────────────────────────────────────────────────────

/**
 * Synchronous portion of the matcher: evaluates all filters except dates.
 * Exported separately so unit tests can cover filter logic without DB calls.
 */
export function matchesSavedSearchSync(
  property: Pick<Property, 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
  filters: SavedSearchFilters,
): boolean {
  // Price range
  if (filters.min_price !== undefined && property.price_per_night != null) {
    if (property.price_per_night < filters.min_price) return false;
  }
  if (filters.max_price !== undefined && property.price_per_night != null) {
    if (property.price_per_night > filters.max_price) return false;
  }

  // City (case-insensitive partial match)
  if (filters.city && property.city) {
    if (!property.city.toLowerCase().includes(filters.city.toLowerCase())) return false;
  }

  // Country (case-insensitive partial match)
  if (filters.country && property.country) {
    if (!property.country.toLowerCase().includes(filters.country.toLowerCase())) return false;
  }

  // Bedrooms (minimum)
  if (filters.bedrooms !== undefined && property.bedrooms != null) {
    if (property.bedrooms < filters.bedrooms) return false;
  }

  // Bathrooms (minimum)
  if (filters.min_bathrooms !== undefined && property.bathrooms != null) {
    if (property.bathrooms < filters.min_bathrooms) return false;
  }

  // Guest capacity (minimum)
  if (filters.guests !== undefined && property.max_guests != null) {
    if (property.max_guests < filters.guests) return false;
  }

  // Property type (set membership — OR)
  if (filters.property_types && filters.property_types.length > 0 && property.property_type) {
    if (!filters.property_types.includes(property.property_type)) return false;
  }

  // Amenities (property must have ALL requested amenities)
  if (filters.amenities && filters.amenities.length > 0 && property.amenities) {
    const propAmenities = new Set(property.amenities.map((a) => a.toLowerCase()));
    for (const required of filters.amenities) {
      if (!propAmenities.has(required.toLowerCase())) return false;
    }
  }

  // Text query (title match — simple case-insensitive contains)
  if (filters.query && filters.query.trim().length > 0) {
    const q = filters.query.toLowerCase();
    const title = (property.title ?? '').toLowerCase();
    if (!title.includes(q)) return false;
  }

  return true;
}

/**
 * Check whether a property has blocked availability ranges overlapping the
 * requested date window. Uses the same overlap inequality as advancedSearch:
 *   start_date < checkOut AND end_date > checkIn
 *
 * For a newly published property there should be no bookings yet, but the
 * host may have pre-blocked dates via availability_ranges.
 */
async function isPropertyAvailableForDates(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('availability_ranges')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOut)
    .gt('end_date', checkIn)
    .limit(1);

  return !data || data.length === 0;
}

/**
 * Full matcher: sync filter checks + async date-range availability check.
 * When checkIn/checkOut are absent from filters, behaves like the sync version.
 */
export async function matchesSavedSearch(
  property: Pick<Property, 'id' | 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
  filters: SavedSearchFilters,
): Promise<boolean> {
  if (!matchesSavedSearchSync(property, filters)) return false;

  // Date-range availability check: verify the property isn't blocked for the
  // requested dates. Only runs when both checkIn and checkOut are provided.
  if (filters.checkIn && filters.checkOut && property.id) {
    const available = await isPropertyAvailableForDates(property.id, filters.checkIn, filters.checkOut);
    if (!available) return false;
  }

  return true;
}

// ─── Notification fan-out ─────────────────────────────────────────────────────

/**
 * Find all saved searches that match a newly listed property and send
 * notifications to their owners. Fire-and-forget: notification failures
 * never throw.
 *
 * Respects pause status and digest frequency preferences.
 *
 * @returns The number of users notified.
 */
export async function notifyMatchingSavedSearches(
  property: Pick<Property, 'id' | 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
): Promise<ServiceResponse<number>> {
  // Fetch all saved searches that are not paused
  const { data: searches, error } = await supabase
    .from('saved_searches')
    .select('id, user_id, name, filters, is_paused, digest_frequency')
    .eq('is_paused', false);

  if (error) return { success: false, error: error.message };

  const allSearches = (searches ?? []) as SavedSearch[];
  const matching: SavedSearch[] = [];

  for (const s of allSearches) {
    const isMatch = await matchesSavedSearch(property, s.filters as SavedSearchFilters);
    if (isMatch) matching.push(s);
  }

  if (matching.length === 0) return { success: true, data: 0 };

  // Group by user to handle digest frequency per user
  const searchesByUser = new Map<string, SavedSearch[]>();
  for (const search of matching) {
    if (!searchesByUser.has(search.user_id)) {
      searchesByUser.set(search.user_id, []);
    }
    searchesByUser.get(search.user_id)!.push(search);
  }

  let notified = 0;
  const { createNotification } = await import('./notification.service.js');

  for (const [userId, userSearches] of searchesByUser.entries()) {
    try {
      const lastSearch = userSearches[0];
      const result = await createNotification(userId, 'new_property_search', {
        propertyId: property.id,
        propertyTitle: property.title,
        savedSearchName: lastSearch.name,
        message: `A new listing "${property.title}" matches your saved search "${lastSearch.name}".`,
        matchCount: userSearches.length,
        digestFrequency: lastSearch.digest_frequency || 'immediate',
      });
      if (result.success) notified++;
    } catch {
      // Notification failure must never block property creation
    }
  }

  return { success: true, data: notified };
}
