import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface HostDashboardSummary {
  total_properties: number;
  active_bookings: number;
  upcoming_reservations: number;
  total_revenue: number;
  net_revenue: number;
  pending_earnings: number;
  released_earnings: number;
  currency: string;
}

export interface HostDashboardSummaryOptions {
  /** Inclusive lower bound (ISO date) applied to ledger entry effective dates. */
  periodStart?: string;
  /** Inclusive upper bound (ISO date) applied to ledger entry effective dates. */
  periodEnd?: string;
  /** ISO 4217 currency code; defaults to USD. */
  currency?: string;
}

type LedgerEntryType =
  | 'booking_credit'
  | 'fee_debit'
  | 'release_credit'
  | 'refund_debit'
  | 'adjustment_credit'
  | 'adjustment_debit';

interface LedgerEntryRow {
  entry_type: LedgerEntryType;
  amount: number | string | null;
  currency: string | null;
  effective_at: string | null;
}

const CREDIT_ENTRY_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'booking_credit',
  'release_credit',
  'adjustment_credit',
]);

const PENDING_ENTRY_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'booking_credit',
]);

const RELEASED_ENTRY_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'release_credit',
]);

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Derives host balances from append-only earnings_ledger entries.
 * Credits increase the balance, debits decrease it. Entries are never
 * mutated; corrections arrive as adjustment_credit/adjustment_debit rows.
 */
async function deriveLedgerBalances(
  hostId: string,
  options: HostDashboardSummaryOptions,
): Promise<ServiceResponse<{ total: number; net: number; pending: number; released: number }>> {
  const currency = (options.currency ?? 'USD').toUpperCase();

  let query = supabase
    .from('earnings_ledger')
    .select('entry_type, amount, currency, effective_at')
    .eq('host_id', hostId)
    .eq('currency', currency);

  if (options.periodStart) query = query.gte('effective_at', options.periodStart);
  if (options.periodEnd) query = query.lte('effective_at', options.periodEnd);

  const { data, error } = await query;

  if (error) return { success: false, error: error.message };

  let total = 0;
  let net = 0;
  let pending = 0;
  let released = 0;

  for (const row of (data ?? []) as LedgerEntryRow[]) {
    const amount = Number(row.amount) || 0;
    const isCredit = CREDIT_ENTRY_TYPES.has(row.entry_type);
    const signed = isCredit ? amount : -amount;

    if (isCredit) total += amount;
    net += signed;

    if (PENDING_ENTRY_TYPES.has(row.entry_type)) pending += amount;
    if (RELEASED_ENTRY_TYPES.has(row.entry_type)) released += amount;
  }

  return {
    success: true,
    data: {
      total: roundCurrency(total),
      net: roundCurrency(net),
      pending: roundCurrency(pending),
      released: roundCurrency(released),
    },
  };
}

export interface HostProperty {
  id: string;
  title: string;
  location: string;
  price_per_night: number;
  status: string;
  active_bookings: number;
  total_bookings: number;
  average_rating: number;
  review_count: number;
  images: string[];
  created_at: string;
}

/**
 * Returns a summary of the host's properties, bookings, and revenue
 * for use in the host dashboard overview section.
 */
export async function getHostDashboardSummary(
  hostId: string,
  options: HostDashboardSummaryOptions = {},
): Promise<ServiceResponse<HostDashboardSummary>> {
  const currency = (options.currency ?? 'USD').toUpperCase();

  // Fetch all properties for the host
  const { data: properties, error: propError } = await supabase
    .from('properties')
    .select('id')
    .eq('owner_id', hostId);

  if (propError) return { success: false, error: propError.message };

  const propertyIds = (properties ?? []).map((p: { id: string }) => p.id);
  const total_properties = propertyIds.length;

  if (total_properties === 0) {
    return {
      success: true,
      data: {
        total_properties: 0,
        active_bookings: 0,
        upcoming_reservations: 0,
        total_revenue: 0,
        net_revenue: 0,
        pending_earnings: 0,
        released_earnings: 0,
        currency,
      },
    };
  }

  const now = new Date().toISOString();
  const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Active bookings (Confirmed status, not yet checked out)
  const { count: activeCount } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .in('property_id', propertyIds)
    .eq('status', 'Confirmed')
    .gte('check_out', now);

  // Upcoming reservations (check-in within next 7 days)
  const { count: upcomingCount } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .in('property_id', propertyIds)
    .eq('status', 'Confirmed')
    .gte('check_in', now)
    .lte('check_in', sevenDaysFromNow);

  // Revenue is derived from the append-only earnings ledger so that late
  // payment events, refunds, and adjustments are reflected without mutating
  // historical booking totals.
  const balances = await deriveLedgerBalances(hostId, { ...options, currency });
  if (!balances.success) return { success: false, error: balances.error };

  return {
    success: true,
    data: {
      total_properties,
      active_bookings: activeCount ?? 0,
      upcoming_reservations: upcomingCount ?? 0,
      total_revenue: balances.data.total,
      net_revenue: balances.data.net,
      pending_earnings: balances.data.pending,
      released_earnings: balances.data.released,
      currency,
    },
  };
}

/**
 * Returns the host's properties enriched with booking counts and ratings.
 */
export async function getHostProperties(
  hostId: string,
  page = 1,
  limit = 20,
): Promise<ServiceResponse<{ properties: HostProperty[]; total: number }>> {
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from('properties')
    .select('id, title, location, price_per_night, status, images, average_rating, review_count, created_at', {
      count: 'exact',
    })
    .eq('owner_id', hostId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { success: false, error: error.message };

  const propertyRows = (data ?? []) as Array<{
    id: string;
    title: string;
    location: string;
    price_per_night: number;
    status: string;
    images: string[] | null;
    average_rating: number | null;
    review_count: number | null;
    created_at: string;
  }>;

  if (propertyRows.length === 0) {
    return { success: true, data: { properties: [], total: count ?? 0 } };
  }

  const propertyIds = propertyRows.map((p) => p.id);

  // Active booking counts per property
  const { data: bookingData } = await supabase
    .from('bookings')
    .select('property_id, status')
    .in('property_id', propertyIds)
    .not('status', 'eq', 'Cancelled');

  const bookingsByProp: Record<string, { total: number; active: number }> = {};
  for (const b of (bookingData ?? []) as Array<{ property_id: string; status: string }>) {
    if (!bookingsByProp[b.property_id]) {
      bookingsByProp[b.property_id] = { total: 0, active: 0 };
    }
    bookingsByProp[b.property_id].total++;
    if (b.status === 'Confirmed') bookingsByProp[b.property_id].active++;
  }

  const properties: HostProperty[] = propertyRows.map((p) => ({
    id: p.id,
    title: p.title,
    location: p.location ?? '',
    price_per_night: p.price_per_night ?? 0,
    status: p.status ?? 'draft',
    active_bookings: bookingsByProp[p.id]?.active ?? 0,
    total_bookings: bookingsByProp[p.id]?.total ?? 0,
    average_rating: p.average_rating ?? 0,
    review_count: p.review_count ?? 0,
    images: p.images ?? [],
    created_at: p.created_at,
  }));

  return { success: true, data: { properties, total: count ?? 0 } };
}

/**
 * Update the published/unpublished/draft status of a property.
 * Only the owner can update their property status.
 */
export async function updatePropertyStatus(
  propertyId: string,
  ownerId: string,
  status: 'draft' | 'published' | 'unpublished',
): Promise<ServiceResponse<{ id: string; status: string }>> {
  // Verify ownership
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (propError || !property) return { success: false, error: 'Property not found' };
  if ((property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const { data, error } = await supabase
    .from('properties')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', propertyId)
    .select('id, status')
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as { id: string; status: string } };
}
