/**
 * Host calendar intervals service (Feature 3).
 *
 * Returns typed unavailability intervals for a property so a host can see
 * WHY a given date range is unavailable — distinguishing confirmed bookings,
 * pending (payment-hold) bookings, personal blocks, and maintenance — without
 * exposing tenant identity or payment details.
 *
 * Privacy contract:
 *   The response contains ONLY: dates, booking status, hold-expiry flag, and
 *   the host's own block note. It NEVER contains tenant_id, tenant name, wallet
 *   address, or payment amounts. Tenants are identified to the host only through
 *   the bookings flow, which enforces its own authorization.
 *
 * Policy contract:
 *   - Confirmed/Completed bookings block edits (not editable here).
 *   - Pending bookings hold availability for {@link PENDING_HOLD_MINUTES} after
 *     creation; after that the hold is "expired" and the host may block over it.
 *   - Manual blocks are editable (the host may remove them).
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type UnavailabilityReasonType =
  | 'confirmed_booking'
  | 'pending_booking'
  | 'expired_hold'
  | 'personal_block'
  | 'maintenance';

export interface HostCalendarInterval {
  id: string;
  /** Inclusive start date (ISO YYYY-MM-DD). */
  start_date: string;
  /** Exclusive end date (ISO YYYY-MM-DD) — the departure / unblock day. */
  end_date: string;
  reason_type: UnavailabilityReasonType;
  /** Human-readable label for the calendar legend. */
  label: string;
  /** Origin of the interval: a reservation or a manual block. */
  source: 'booking' | 'block';
  /** Whether the host may remove this interval through the calendar UI. */
  editable: boolean;
  /**
   * Safe booking context. Contains NO tenant identity or payment details —
   * only the booking status, dates, and hold-expiry flag.
   */
  booking_context?: {
    status: string;
    check_in: string;
    check_out: string;
    /** True when a pending booking's hold window has elapsed. */
    hold_expired: boolean;
  };
  /** Free-text note the host attached to a manual block, if any. */
  note?: string;
}

export interface CalendarIntervalsResult {
  propertyId: string;
  from: string;
  to: string;
  intervals: HostCalendarInterval[];
  summary: Record<UnavailabilityReasonType, number>;
}

// ─── Policy constants ─────────────────────────────────────────────────────────

/**
 * Minutes a Pending booking holds availability before the hold expires. After
 * this window elapses the host may block over the (expired) hold. Mirrors the
 * booking-expiry policy used by the booking lifecycle.
 */
export const PENDING_HOLD_MINUTES = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Whether a pending booking's availability hold has expired. Exposed for the
 * block-edit guard and for tests.
 */
export function isPendingHoldExpired(createdAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const ageMs = now.getTime() - created.getTime();
  return ageMs > PENDING_HOLD_MINUTES * 60 * 1000;
}

/**
 * Categorize a manual block's free-text reason into a typed reason. Hosts
 * pick a block type in the UI; the chosen type is stored as a structured
 * prefix in `reason` (e.g. "maintenance:boiler service") so it survives
 * without a separate column, while the free-text note is preserved.
 */
export function categorizeBlockReason(reason?: string | null): 'maintenance' | 'personal_block' {
  if (!reason) return 'personal_block';
  const lower = reason.toLowerCase();
  if (lower.startsWith('maintenance:') || lower === 'maintenance') return 'maintenance';
  if (lower.startsWith('personal:') || lower === 'personal') return 'personal_block';
  // Heuristic fallback for legacy free-text reasons.
  if (/maint|repair|clean|renovat|fix/.test(lower)) return 'maintenance';
  return 'personal_block';
}

const REASON_LABELS: Record<UnavailabilityReasonType, string> = {
  confirmed_booking: 'Confirmed booking',
  pending_booking: 'Pending booking (hold)',
  expired_hold: 'Expired booking hold',
  personal_block: 'Personal block',
  maintenance: 'Maintenance',
};

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Build typed unavailability intervals for a property over [from, to].
 *
 * @param propertyId - UUID of the property.
 * @param from        - ISO date, inclusive start.
 * @param to          - ISO date, inclusive end.
 */
export async function getHostCalendarIntervals(
  propertyId: string,
  from: string,
  to: string,
): Promise<ServiceResponse<CalendarIntervalsResult>> {
  if (!propertyId) return { success: false, error: 'propertyId is required' };

  const fromDate = new Date(from + 'T00:00:00Z');
  const toDate = new Date(to + 'T00:00:00Z');
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { success: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }
  if (fromDate > toDate) {
    return { success: false, error: '`from` must be on or before `to`' };
  }
  const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  if (diffDays > 366) {
    return { success: false, error: 'Date range must not exceed 366 days' };
  }

  // Fetch bookings overlapping [from, to]. Only booking-relevant, non-PII
  // columns are selected — tenant_id and payment fields are deliberately NOT
  // fetched so they can never leak through this response.
  const { data: bookings, error: bErr } = await supabase
    .from('bookings')
    .select('id, check_in, check_out, status, created_at')
    .eq('property_id', propertyId)
    .not('status', 'eq', 'Cancelled')
    .lt('check_in', to)
    .gt('check_out', from);

  if (bErr) return { success: false, error: bErr.message };

  const { data: blocks, error: blErr } = await supabase
    .from('availability_ranges')
    .select('id, start_date, end_date, reason, is_available, blocked_by')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', to)
    .gt('end_date', from);

  if (blErr) return { success: false, error: blErr.message };

  const now = new Date();
  const intervals: HostCalendarInterval[] = [];
  const summary: Record<UnavailabilityReasonType, number> = {
    confirmed_booking: 0,
    pending_booking: 0,
    expired_hold: 0,
    personal_block: 0,
    maintenance: 0,
  };

  for (const b of (bookings ?? []) as Array<{
    id: string;
    check_in: string;
    check_out: string;
    status: string;
    created_at: string | null;
  }>) {
    const isPending = b.status === 'Pending';
    const holdExpired = isPending && isPendingHoldExpired(b.created_at, now);
    let reasonType: UnavailabilityReasonType;
    if (isPending) {
      reasonType = holdExpired ? 'expired_hold' : 'pending_booking';
    } else {
      // Confirmed, Completed, Disputed all continue to hold the dates.
      reasonType = 'confirmed_booking';
    }
    intervals.push({
      id: b.id,
      start_date: b.check_in,
      end_date: b.check_out,
      reason_type: reasonType,
      label: REASON_LABELS[reasonType],
      source: 'booking',
      editable: false,
      booking_context: {
        status: b.status,
        check_in: b.check_in,
        check_out: b.check_out,
        hold_expired: holdExpired,
      },
    });
    summary[reasonType]++;
  }

  for (const bl of (blocks ?? []) as Array<{
    id: string;
    start_date: string;
    end_date: string;
    reason: string | null;
  }>) {
    const reasonType = categorizeBlockReason(bl.reason);
    intervals.push({
      id: bl.id,
      start_date: bl.start_date,
      end_date: bl.end_date,
      reason_type: reasonType,
      label: REASON_LABELS[reasonType],
      source: 'block',
      editable: true,
      note: bl.reason ?? undefined,
    });
    summary[reasonType]++;
  }

  intervals.sort((a, b) => a.start_date.localeCompare(b.start_date));

  return {
    success: true,
    data: { propertyId, from, to, intervals, summary },
  };
}

// Re-export dateRange for callers that want to render per-day from intervals.
export { dateRange };
