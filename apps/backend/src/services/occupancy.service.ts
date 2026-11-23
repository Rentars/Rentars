/**
 * Occupancy heatmap service.
 *
 * Returns the daily availability status for a property over a date range.
 * Status values:
 *   'booked'    — an active booking (Pending or Confirmed) covers this day
 *   'blocked'   — a manual availability block covers this day
 *   'available' — neither booked nor blocked
 *
 * Host-only: the controller enforces that only the property owner may call
 * this endpoint.
 */

import { supabase } from '@/config/supabase.js';
import { RESERVING_BOOKING_STATUSES } from './booking.service.js';
import type { ServiceResponse } from './index.js';
import {
  DEFAULT_CALENDAR_TIMEZONE,
  dateRange as calendarDateRange,
  coversDate as calendarCoversDate,
  parseCalendarDate,
  type AnalyticsWindowMetadata,
} from './analytics-window.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DayStatus = 'booked' | 'blocked' | 'available';

export interface DayEntry {
  date:   string;     // ISO YYYY-MM-DD
  status: DayStatus;
}

export interface OccupancyHeatmapResult {
  propertyId: string;
  from:       string;
  to:         string;
  days:       DayEntry[];
  summary: {
    booked:    number;
    blocked:   number;
    available: number;
    total:     number;
  };
  /** Explicit window, timezone and inclusion rules for this aggregate. */
  metadata: AnalyticsWindowMetadata;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return true if [rangeStart, rangeEnd) overlaps with the given date.
 * check_in <= date < check_out  (check_out is the departure day, not a night)
 */
function coversDate(rangeStart: string, rangeEnd: string, date: string): boolean {
  return calendarCoversDate(rangeStart, rangeEnd, date);
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Build a per-day status map for a property over the requested horizon.
 *
 * @param propertyId  - UUID of the property
 * @param from        - ISO date string, inclusive start
 * @param to          - ISO date string, inclusive end
 */
export async function getOccupancyHeatmap(
  propertyId: string,
  from:        string,
  to:          string,
): Promise<ServiceResponse<OccupancyHeatmapResult>> {
  if (!propertyId) return { success: false, error: 'propertyId is required' };

  const fromDate = parseCalendarDate(from);
  const toDate   = parseCalendarDate(to);

  if (!fromDate || !toDate) {
    return { success: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }

  if (fromDate > toDate) {
    return { success: false, error: '`from` must be on or before `to`' };
  }

  // Cap horizon at 366 days to prevent accidental huge queries
  const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  if (diffDays > 366) {
    return { success: false, error: 'Date range must not exceed 366 days' };
  }

  // ── Fetch bookings that overlap [from, to] ──────────────────────────────
  // Only statuses that actually reserve inventory (Pending, Confirmed) are
  // shown as booked; Expired/Cancelled holds release their dates.
  const { data: bookings, error: bErr } = await supabase
    .from('bookings')
    .select('check_in, check_out, status')
    .eq('property_id', propertyId)
    .in('status', RESERVING_BOOKING_STATUSES)
    .lt('check_in', to)       // starts before the window ends
    .gt('check_out', from);   // ends after the window starts

  if (bErr) return { success: false, error: bErr.message };

  // ── Fetch manual availability blocks that overlap [from, to] ──────────
  const { data: blocks, error: blErr } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', to)
    .gt('end_date', from);

  if (blErr) return { success: false, error: blErr.message };

  // ── Build sets for O(1) lookup ─────────────────────────────────────────
  const bookedDays  = new Set<string>();
  const blockedDays = new Set<string>();

  for (const b of (bookings ?? []) as { check_in: string; check_out: string; status: string }[]) {
    for (const d of calendarDateRange(
      b.check_in  > from ? b.check_in  : from,
      b.check_out < to   ? b.check_out : to,
    )) {
      if (coversDate(b.check_in, b.check_out, d)) bookedDays.add(d);
    }
  }

  for (const bl of (blocks ?? []) as { start_date: string; end_date: string }[]) {
    for (const d of calendarDateRange(
      bl.start_date > from ? bl.start_date : from,
      bl.end_date   < to   ? bl.end_date   : to,
    )) {
      if (coversDate(bl.start_date, bl.end_date, d)) blockedDays.add(d);
    }
  }

  // ── Assemble per-day entries ────────────────────────────────────────────
  const allDates = calendarDateRange(from, to);
  const days: DayEntry[] = allDates.map((date) => {
    let status: DayStatus = 'available';
    if (bookedDays.has(date))       status = 'booked';
    else if (blockedDays.has(date)) status = 'blocked';
    return { date, status };
  });

  const summary = {
    booked:    days.filter((d) => d.status === 'booked').length,
    blocked:   days.filter((d) => d.status === 'blocked').length,
    available: days.filter((d) => d.status === 'available').length,
    total:     days.length,
  };

  const metadata: AnalyticsWindowMetadata = {
    metric: 'occupancy_heatmap',
    from,
    to,
    timezone: DEFAULT_CALENDAR_TIMEZONE,
    windowType: 'calendar_days_inclusive',
    inclusionRules: {
      bookedStatuses: [...RESERVING_BOOKING_STATUSES],
      nightRule: 'check_in <= date < check_out',
      blockedSource: 'availability_ranges.is_available = false',
      precedence: 'booked_over_blocked',
    },
  };

  return {
    success: true,
    data: { propertyId, from, to, days, summary, metadata },
  };
}
