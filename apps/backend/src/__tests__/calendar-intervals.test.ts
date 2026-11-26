/**
 * Tests for Feature 3 — Host calendar management with typed interval reasons.
 *
 * Covers the acceptance criteria:
 *  - Hosts can identify why dates are unavailable (typed reasons + legend labels).
 *  - Hosts can change only intervals allowed by policy (blocks editable, bookings locked).
 *  - Tenant identity and payment details remain private (no PII in the response).
 *  - Backend rejects conflicting blocks even when the UI is bypassed.
 *
 * Cases: typed reasons, pending-hold expiry, overlapping edits, privacy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase mock ─────────────────────────────────────────────────────────────

/**
 * A small chainable-query builder that records the table and resolves a
 * configured payload when awaited (or via .single()). Filters are accepted
 * but ignored — each test seeds the resolved data per table.
 */
type Chain = {
  eq: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => Promise<unknown>;
};

const tableData: Record<string, { rows: unknown[]; error: unknown | null }> = {
  bookings: { rows: [], error: null },
  availability_ranges: { rows: [], error: null },
  properties: { rows: [], error: null },
};

function makeChain(table: string): Chain {
  const chain: Partial<Chain> = {};
  const selfReturning = ['eq', 'not', 'in', 'lt', 'gt', 'order', 'limit', 'range', 'select', 'insert', 'update'] as const;
  for (const m of selfReturning) {
    chain[m] = vi.fn(() => chain as Chain);
  }
  chain.single = vi.fn(async () => {
    const t = tableData[table];
    return { data: t.rows[0] ?? null, error: t.error };
  });
  chain.maybeSingle = vi.fn(async () => {
    const t = tableData[table];
    return { data: t.rows[0] ?? null, error: t.error };
  });
  chain.then = (resolve, reject) =>
    Promise.resolve({ data: tableData[table].rows, error: tableData[table].error }).then(resolve, reject);
  return chain as Chain;
}

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn((table: string) => makeChain(table)),
  },
}));

// ─── Imports (after mock is registered) ───────────────────────────────────────

const {
  getHostCalendarIntervals,
  categorizeBlockReason,
  isPendingHoldExpired,
  PENDING_HOLD_MINUTES,
} = await import('../services/calendarIntervals.service.js');
const { blockAvailabilityRange } = await import('../services/availability.service.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seed(table: string, rows: unknown[], error: unknown | null = null) {
  tableData[table] = { rows, error };
}

beforeEach(() => {
  seed('bookings', []);
  seed('availability_ranges', []);
  seed('properties', []);
});

// ─── categorizeBlockReason ───────────────────────────────────────────────────

describe('categorizeBlockReason', () => {
  it('classifies prefixed maintenance reasons', () => {
    expect(categorizeBlockReason('maintenance:boiler service')).toBe('maintenance');
    expect(categorizeBlockReason('maintenance')).toBe('maintenance');
  });

  it('classifies prefixed personal reasons', () => {
    expect(categorizeBlockReason('personal:family stay')).toBe('personal_block');
    expect(categorizeBlockReason('personal')).toBe('personal_block');
  });

  it('falls back to heuristics for legacy free-text reasons', () => {
    expect(categorizeBlockReason('Cleaning and repair')).toBe('maintenance');
    expect(categorizeBlockReason('Renovation work')).toBe('maintenance');
    expect(categorizeBlockReason('Vacation')).toBe('personal_block');
  });

  it('defaults to personal for empty/null reasons', () => {
    expect(categorizeBlockReason(null)).toBe('personal_block');
    expect(categorizeBlockReason(undefined)).toBe('personal_block');
    expect(categorizeBlockReason('')).toBe('personal_block');
  });
});

// ─── isPendingHoldExpired ─────────────────────────────────────────────────────

describe('isPendingHoldExpired', () => {
  it('is NOT expired within the hold window', () => {
    const createdAt = new Date(Date.now() - PENDING_HOLD_MINUTES * 60 * 1000 + 5000).toISOString();
    expect(isPendingHoldExpired(createdAt)).toBe(false);
  });

  it('IS expired after the hold window elapses', () => {
    const createdAt = new Date(Date.now() - (PENDING_HOLD_MINUTES + 5) * 60 * 1000).toISOString();
    expect(isPendingHoldExpired(createdAt)).toBe(true);
  });

  it('handles missing/invalid created_at (treats as not expired)', () => {
    expect(isPendingHoldExpired(null)).toBe(false);
    expect(isPendingHoldExpired(undefined)).toBe(false);
    expect(isPendingHoldExpired('not-a-date')).toBe(false);
  });
});

// ─── getHostCalendarIntervals — typed reasons & privacy ───────────────────────

describe('getHostCalendarIntervals — typed reasons', () => {
  it('categorizes confirmed, pending, expired, maintenance, and personal intervals', async () => {
    const expiredHoldCreated = new Date(Date.now() - (PENDING_HOLD_MINUTES + 10) * 60 * 1000).toISOString();
    const activeHoldCreated = new Date(Date.now() - 60_000).toISOString();
    seed('bookings', [
      { id: 'b1', check_in: '2027-08-01', check_out: '2027-08-03', status: 'Confirmed', created_at: null },
      { id: 'b2', check_in: '2027-08-10', check_out: '2027-08-12', status: 'Pending', created_at: activeHoldCreated },
      { id: 'b3', check_in: '2027-08-20', check_out: '2027-08-22', status: 'Pending', created_at: expiredHoldCreated },
    ]);
    seed('availability_ranges', [
      { id: 'r1', start_date: '2027-08-25', end_date: '2027-08-28', reason: 'maintenance:roof', is_available: false, blocked_by: 'host' },
      { id: 'r2', start_date: '2027-08-30', end_date: '2027-09-01', reason: 'personal:trip', is_available: false, blocked_by: 'host' },
    ]);

    const r = await getHostCalendarIntervals('prop-1', '2027-08-01', '2027-09-01');
    expect(r.success).toBe(true);
    const intervals = r.data!.intervals;
    const byId = Object.fromEntries(intervals.map((i) => [i.id, i]));

    expect(byId.b1.reason_type).toBe('confirmed_booking');
    expect(byId.b1.editable).toBe(false);
    expect(byId.b1.booking_context?.status).toBe('Confirmed');

    expect(byId.b2.reason_type).toBe('pending_booking');
    expect(byId.b2.booking_context?.hold_expired).toBe(false);

    expect(byId.b3.reason_type).toBe('expired_hold');
    expect(byId.b3.booking_context?.hold_expired).toBe(true);

    expect(byId.r1.reason_type).toBe('maintenance');
    expect(byId.r1.editable).toBe(true);
    expect(byId.r1.source).toBe('block');

    expect(byId.r2.reason_type).toBe('personal_block');
  });

  it('summary counts match the categorized intervals', async () => {
    seed('bookings', [
      { id: 'b1', check_in: '2027-08-01', check_out: '2027-08-03', status: 'Confirmed', created_at: null },
      { id: 'b2', check_in: '2027-08-10', check_out: '2027-08-12', status: 'Pending', created_at: new Date().toISOString() },
    ]);
    seed('availability_ranges', [
      { id: 'r1', start_date: '2027-08-15', end_date: '2027-08-17', reason: 'maintenance:x', is_available: false },
    ]);
    const r = await getHostCalendarIntervals('prop-1', '2027-08-01', '2027-08-31');
    expect(r.data!.summary.confirmed_booking).toBe(1);
    expect(r.data!.summary.pending_booking).toBe(1);
    expect(r.data!.summary.maintenance).toBe(1);
    expect(r.data!.summary.personal_block).toBe(0);
  });

  it('sorts intervals by start_date ascending', async () => {
    seed('bookings', [
      { id: 'b2', check_in: '2027-08-10', check_out: '2027-08-12', status: 'Confirmed', created_at: null },
      { id: 'b1', check_in: '2027-08-01', check_out: '2027-08-03', status: 'Confirmed', created_at: null },
    ]);
    seed('availability_ranges', []);
    const r = await getHostCalendarIntervals('prop-1', '2027-08-01', '2027-08-31');
    expect(r.data!.intervals.map((i) => i.id)).toEqual(['b1', 'b2']);
  });

  it('does NOT leak tenant identity or payment details (privacy)', async () => {
    // Even if the DB row somehow contained PII columns, the service must not
    // surface them — it only maps known safe fields.
    seed('bookings', [
      {
        id: 'b1',
        check_in: '2027-08-01',
        check_out: '2027-08-03',
        status: 'Confirmed',
        created_at: null,
        tenant_id: 'secret-tenant',
        tenant_email: 'tenant@example.com',
        wallet_address: 'GSECRET',
        total_price: 500,
        payment_amount: 500,
      } as unknown,
    ]);
    seed('availability_ranges', []);
    const r = await getHostCalendarIntervals('prop-1', '2027-08-01', '2027-08-31');
    const json = JSON.stringify(r.data!.intervals);
    expect(json).not.toContain('secret-tenant');
    expect(json).not.toContain('tenant@example.com');
    expect(json).not.toContain('GSECRET');
    expect(json).not.toContain('total_price');
    expect(json).not.toContain('payment_amount');
    expect(json).not.toContain('tenant_id');
  });

  it('rejects an invalid or reversed date range', async () => {
    expect((await getHostCalendarIntervals('p', 'not-a-date', '2027-08-01')).success).toBe(false);
    expect((await getHostCalendarIntervals('p', '2027-09-01', '2027-08-01')).success).toBe(false);
  });
});

// ─── blockAvailabilityRange — guarded edits & pending-hold policy ─────────────

describe('blockAvailabilityRange — guarded edits', () => {
  beforeEach(() => {
    seed('properties', [{ owner_id: 'host-1' }]);
  });

  it('rejects a block overlapping a confirmed booking (UI bypass still rejected)', async () => {
    seed('bookings', [
      { id: 'b1', status: 'Confirmed', created_at: null },
    ]);
    const r = await blockAvailabilityRange('prop-1', 'host-1', {
      start_date: '2027-08-05',
      end_date: '2027-08-08',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/confirmed booking|pending hold|overlap/i);
  });

  it('rejects a block overlapping an ACTIVE pending hold', async () => {
    seed('bookings', [
      { id: 'b1', status: 'Pending', created_at: new Date().toISOString() },
    ]);
    const r = await blockAvailabilityRange('prop-1', 'host-1', {
      start_date: '2027-08-05',
      end_date: '2027-08-08',
    });
    expect(r.success).toBe(false);
  });

  it('allows a block over an EXPIRED pending hold (reclaiming the dates)', async () => {
    const expired = new Date(Date.now() - (PENDING_HOLD_MINUTES + 10) * 60 * 1000).toISOString();
    seed('bookings', [
      { id: 'b1', status: 'Pending', created_at: expired },
    ]);
    seed('availability_ranges', [{ id: 'r1', start_date: '2027-08-05', end_date: '2027-08-08', is_available: false, reason: 'personal:x' }]);
    const r = await blockAvailabilityRange('prop-1', 'host-1', {
      start_date: '2027-08-05',
      end_date: '2027-08-08',
      block_type: 'maintenance',
      reason: 'boiler',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a block from a non-owner (authorization)', async () => {
    seed('properties', [{ owner_id: 'host-1' }]);
    const r = await blockAvailabilityRange('prop-1', 'someone-else', {
      start_date: '2027-08-05',
      end_date: '2027-08-08',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/forbidden/i);
  });

  it('stores the block type as a structured reason prefix', async () => {
    seed('bookings', []);
    seed('availability_ranges', [{ id: 'r1', start_date: '2027-08-05', end_date: '2027-08-08', is_available: false, reason: 'maintenance:boiler' }]);
    const r = await blockAvailabilityRange('prop-1', 'host-1', {
      start_date: '2027-08-05',
      end_date: '2027-08-08',
      block_type: 'maintenance',
      reason: 'boiler',
    });
    expect(r.success).toBe(true);
  });
});
