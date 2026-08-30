/**
 * Tests for Feature C — Booking Reminder Scheduler
 *
 * Covers:
 *  1. markReminderSent — inserts a row; treats unique violation as already-sent
 *  2. isReminderSent — checks existence without inserting
 *  3. runReminderScheduler — sends reminders once, skips on re-run (dedup),
 *     respects notification preferences
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  markReminderSent,
  isReminderSent,
  runReminderScheduler,
} from '../services/reminder.service.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockInsert      = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSingle      = vi.fn();
const mockSelectEqEq  = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq    = vi.fn(() => ({
  maybeSingle: mockMaybeSingle,
  eq: mockSelectEqEq,
}));
const mockNot         = vi.fn();
const mockLte         = vi.fn(() => ({ not: mockNot }));
const mockGte         = vi.fn(() => ({ lte: mockLte }));
const mockBookingSelect = vi.fn(() => ({ gte: mockGte }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'booking_reminders') {
    return {
      insert: mockInsert,
      select: vi.fn(() => ({ eq: mockSelectEq })),
    };
  }
  if (table === 'bookings') {
    return { select: mockBookingSelect };
  }
  if (table === 'users') {
    return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })) };
  }
  return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })) };
});

vi.mock('../config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

// ─── Notification service mock ────────────────────────────────────────────────

const mockCreateNotificationWithEmail = vi.fn();
const mockGetPreferences              = vi.fn();

vi.mock('../services/notification.service.js', () => ({
  createNotificationWithEmail: mockCreateNotificationWithEmail,
  getPreferences:              mockGetPreferences,
}));

// Default pref: all enabled
mockGetPreferences.mockResolvedValue({
  success: true,
  data: { email_notifications: true, push_notifications: true, notification_types: {} },
});

// Default email fetch: return a fake email
mockSingle.mockResolvedValue({ data: { email: 'user@example.com' }, error: null });

// ─── markReminderSent ─────────────────────────────────────────────────────────

describe('markReminderSent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true on a successful insert', async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    const result = await markReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(true);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('returns false on a unique_violation (already sent)', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } });
    const result = await markReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(false);
  });

  it('throws on unexpected DB errors', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '42P01', message: 'relation missing' } });
    await expect(markReminderSent('booking-1', 'checkin_tenant')).rejects.toThrow('relation missing');
  });
});

// ─── isReminderSent ───────────────────────────────────────────────────────────

describe('isReminderSent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'row-1' }, error: null });
    const result = await isReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(true);
  });

  it('returns false when no row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await isReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(false);
  });
});

// ─── runReminderScheduler ─────────────────────────────────────────────────────

/** Build a minimal booking row returned by the Supabase query mock. */
function makeBookingRow(id = 'booking-1') {
  return {
    id,
    tenant_id:  'tenant-1',
    check_in:   new Date(Date.now() + 12 * 3_600_000).toISOString().slice(0, 10),
    check_out:  new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10),
    total_price: 300,
    guest_count: 2,
    properties: { title: 'Beach House', owner_id: 'host-1' },
  };
}

describe('runReminderScheduler()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Notification succeeds
    mockCreateNotificationWithEmail.mockResolvedValue({ success: true });

    // Preferences: all enabled
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { email_notifications: true, push_notifications: true, notification_types: {} },
    });

    // Email lookup
    mockSingle.mockResolvedValue({ data: { email: 'u@example.com' }, error: null });
  });

  it('sends reminders for a booking in the window and returns sent count > 0', async () => {
    const row = makeBookingRow();

    // check-in query
    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    // check-out query
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // markReminderSent: first call = new insert (tenant), second = new insert (host)
    mockInsert
      .mockResolvedValueOnce({ error: null }) // checkin_tenant
      .mockResolvedValueOnce({ error: null }); // checkin_host

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBeGreaterThan(0);
    expect(result.data!.errors).toBe(0);
  });

  it('skips reminders already sent (duplicate-proof across runs)', async () => {
    const row = makeBookingRow();

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Both inserts return unique_violation — already sent
    mockInsert
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } })
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    // Nothing new was sent — all skipped
    expect(result.data!.sent).toBe(0);
    expect(result.data!.skipped).toBeGreaterThan(0);
    // Notification service must NOT have been called
    expect(mockCreateNotificationWithEmail).not.toHaveBeenCalled();
  });

  it('returns 0 sent when no bookings are in the window', async () => {
    mockNot.mockResolvedValueOnce({ data: [], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBe(0);
    expect(result.data!.skipped).toBe(0);
  });

  it('respects user preference — skips if booking_reminder is disabled', async () => {
    const row = makeBookingRow('booking-pref');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Insert succeeds (not yet sent)
    mockInsert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null });

    // Preferences: booking_reminder disabled for both users
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        email_notifications: true,
        push_notifications:  true,
        notification_types:  { booking_reminder: false },
      },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    // Marked as sent in DB but not actually delivered
    expect(mockCreateNotificationWithEmail).not.toHaveBeenCalled();
  });

  it('sends both check-in and check-out reminders in the same run', async () => {
    const checkInRow  = makeBookingRow('b-checkin');
    const checkOutRow = makeBookingRow('b-checkout');

    // check-in query returns one booking, check-out query returns another
    mockNot
      .mockResolvedValueOnce({ data: [checkInRow],  error: null })
      .mockResolvedValueOnce({ data: [checkOutRow], error: null });

    // Four inserts: tenant+host for checkin, tenant+host for checkout
    mockInsert
      .mockResolvedValue({ error: null });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBeGreaterThan(0);
  });

  it('counts errors without crashing when markReminderSent throws', async () => {
    const row = makeBookingRow('booking-err');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Unexpected DB error
    mockInsert.mockResolvedValue({
      error: { code: '42P01', message: 'table missing' },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.errors).toBeGreaterThan(0);
  });

  it('prevents duplicate sends with concurrent scheduler invocations', async () => {
    const row = makeBookingRow('booking-concurrent');

    // Simulate two concurrent invocations querying the same booking
    mockNot
      .mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    // First invocation succeeds, second gets unique violation (race condition)
    mockInsert
      .mockResolvedValueOnce({ data: [{ id: 'reminder-1' }], error: null }) // A: tenant sent
      .mockResolvedValueOnce({ data: [{ id: 'reminder-2' }], error: null }) // A: host sent
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } }) // B: tenant already sent
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } }); // B: host already sent

    const resultA = await runReminderScheduler();
    const resultB = await runReminderScheduler();

    // First invocation sends reminders
    expect(resultA.data!.sent).toBeGreaterThan(0);
    // Second invocation skips (already sent)
    expect(resultB.data!.sent).toBe(0);
    expect(resultB.data!.skipped).toBeGreaterThan(0);

    // Notification service called only once per reminder
    expect(mockCreateNotificationWithEmail.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
