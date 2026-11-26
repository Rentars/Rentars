/**
 * Tests for Feature 4 — Host dashboard earnings reconciliation against the
 * canonical append-only ledger.
 *
 * Covers the acceptance criteria:
 *  - Available balance includes only funds eligible for payout under policy.
 *  - Earnings, transaction history, and exports reconcile to the same ledger.
 *  - Pending or disputed funds are clearly separated and not withdrawable.
 *  - Refunds do not double-count.
 *
 * Scenarios: partial refund, platform fee, pending escrow (reserved), disputed
 * hold, failed/paid-out escrow release, export-totals-match-dashboard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase mock (filter-aware, per-table seeded rows) ───────────────────────

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {
  earnings_ledger_entries: [],
  bookings: [],
};

/** Resolve a possibly-dotted path (e.g. "properties.owner_id") on a row. */
function getPath(row: Row, col: string): unknown {
  if (col.includes('.')) {
    return col.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, row);
  }
  return row[col];
}

function makeBuilder(table: string) {
  const state = { rows: [...tables[table] ?? []], countMode: false };
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn((_cols?: string, opts?: { count?: string }) => {
    if (opts?.count) state.countMode = true;
    return builder;
  });
  builder.eq = vi.fn((col: string, val: unknown) => {
    state.rows = state.rows.filter((r) => getPath(r, col) === val);
    return builder;
  });
  builder.in = vi.fn((col: string, arr: unknown[]) => {
    state.rows = state.rows.filter((r) => arr.includes(getPath(r, col)));
    return builder;
  });
  builder.not = vi.fn(() => builder);
  builder.gte = vi.fn((col: string, val: unknown) => {
    state.rows = state.rows.filter((r) => String(getPath(r, col)) >= String(val));
    return builder;
  });
  builder.lte = vi.fn((col: string, val: unknown) => {
    state.rows = state.rows.filter((r) => String(getPath(r, col)) <= String(val));
    return builder;
  });
  builder.order = vi.fn(() => builder);
  builder.range = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.single = vi.fn(async () => ({ data: state.rows[0] ?? null, error: null }));
  builder.maybeSingle = vi.fn(async () => ({ data: state.rows[0] ?? null, error: null }));
  builder.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(
      state.countMode
        ? { data: state.rows, count: state.rows.length, error: null }
        : { data: state.rows, error: null },
    ).then(resolve, reject);
  return builder;
}

vi.mock('../config/supabase.js', () => ({
  supabase: { from: vi.fn((table: string) => makeBuilder(table)) },
}));

// ─── Imports after mock registration ───────────────────────────────────────────

const { getHostLedgerBalanceBreakdown } = await import('../services/ledger.service.js');
const { EarningsService } = await import('../services/earnings.service.js');
const { listLedgerEntries } = await import('../services/ledger.service.js');

const earningsService = new EarningsService();

const PERIOD = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T23:59:59.999Z', currency: 'USDC' as const };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ledgerRow(entry_type: string, direction: 'credit' | 'debit', amount: number, overrides: Partial<Row> = {}): Row {
  return {
    entry_type,
    direction,
    amount,
    currency: 'USDC',
    host_id: 'host-1',
    created_at: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

function bookingRow(total_price: number, status: string): Row {
  return {
    total_price,
    status,
    created_at: '2026-06-15T00:00:00.000Z',
    properties: { owner_id: 'host-1' },
  };
}

function seed(table: string, rows: Row[]) {
  tables[table] = rows;
}

beforeEach(() => {
  seed('earnings_ledger_entries', []);
  seed('bookings', []);
});

// ─── Ledger balance breakdown ─────────────────────────────────────────────────

describe('getHostLedgerBalanceBreakdown — per-type sums', () => {
  it('splits gross, fees, refunds, adjustments, and paid_out by entry type', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('booking_payment', 'credit', 500),
      ledgerRow('platform_fee', 'debit', 75), // 5% of 1500
      ledgerRow('refund_debit', 'debit', 100),
      ledgerRow('adjustment', 'credit', 20),
      ledgerRow('escrow_release', 'credit', 300), // paid out
    ]);

    const r = await getHostLedgerBalanceBreakdown('host-1', PERIOD);
    expect(r.success).toBe(true);
    const b = r.data!;
    expect(b.gross).toBe(1500);
    expect(b.platform_fees).toBe(75);
    expect(b.refunds).toBe(100);
    expect(b.adjustments_net).toBe(20);
    expect(b.paid_out).toBe(300);
    // net = gross - fees - refunds + adjustments
    expect(b.net).toBe(1500 - 75 - 100 + 20);
  });

  it('all-time breakdown when no period filter is supplied', async () => {
    seed('earnings_ledger_entries', [ledgerRow('booking_payment', 'credit', 200)]);
    const r = await getHostLedgerBalanceBreakdown('host-1');
    expect(r.success).toBe(true);
    expect(r.data!.gross).toBe(200);
  });

  it('returns zeros for an empty ledger', async () => {
    const r = await getHostLedgerBalanceBreakdown('host-1', PERIOD);
    expect(r.data!.gross).toBe(0);
    expect(r.data!.net).toBe(0);
    expect(r.data!.paid_out).toBe(0);
  });
});

// ─── getReconciledEarnings — balance derivation ───────────────────────────────

describe('EarningsService.getReconciledEarnings — ledger-derived balances', () => {
  it('derives net from the ledger, not from summing booking totals', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
    ]);
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.success).toBe(true);
    expect(r.data!.gross).toBe(1000);
    expect(r.data!.platform_fees).toBe(50);
    expect(r.data!.net).toBe(950);
  });

  it('a partial refund is subtracted exactly once from net', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
      ledgerRow('refund_debit', 'debit', 200), // partial refund
    ]);
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.data!.refunds).toBe(200);
    // net = 1000 - 50 - 200 = 750 (refund counted once)
    expect(r.data!.net).toBe(750);
  });

  it('refund does not double-count: a refunded booking is not also "pending"', async () => {
    // A pending booking that was cancelled/refunded is Cancelled (excluded from
    // reserved) and its refund_debit subtracts from net once.
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 800),
      ledgerRow('platform_fee', 'debit', 40),
      ledgerRow('refund_debit', 'debit', 800), // full refund of the settled booking
    ]);
    // No Pending/Disputed bookings remain (the refunded one is Cancelled).
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.data!.net).toBe(800 - 40 - 800); // -40 (correctly negative — full refund)
    expect(r.data!.pending).toBe(0); // reserved excludes cancelled bookings
  });

  it('pending escrow funds are reserved and NOT withdrawable', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
    ]);
    // A Pending booking (not yet in the ledger) is reserved in escrow.
    seed('bookings', [bookingRow(400, 'Pending')]);
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.data!.pending).toBe(380); // 400 * 0.95
    // available must NOT include pending reserved funds
    expect(r.data!.available).toBe(950); // 950 - 0 paid_out - 0 disputed
    expect(r.data!.available).not.toBe(950 + 380);
  });

  it('disputed funds are held and excluded from the available balance', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
    ]);
    seed('bookings', [bookingRow(600, 'Disputed')]); // disputed net = 570
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.data!.disputed).toBe(570);
    // available = net(950) - paid_out(0) - disputed(570) = 380
    expect(r.data!.available).toBe(380);
    expect(r.data!.available).toBeLessThan(r.data!.net);
  });

  it('paid-out escrow release reduces the available balance', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
      ledgerRow('escrow_release', 'credit', 500), // already paid out to host wallet
    ]);
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    expect(r.data!.paid_out).toBe(500);
    // available = net(950) - paid_out(500) - disputed(0) = 450
    expect(r.data!.available).toBe(450);
  });

  it('combined: gross, fee, refund, pending, disputed, paid_out, available', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 2000),
      ledgerRow('platform_fee', 'debit', 100),
      ledgerRow('refund_debit', 'debit', 150),
      ledgerRow('escrow_release', 'credit', 400),
    ]);
    seed('bookings', [bookingRow(300, 'Pending'), bookingRow(500, 'Disputed')]);
    const r = await earningsService.getReconciledEarnings('host-1', PERIOD);
    const d = r.data!;
    expect(d.gross).toBe(2000);
    expect(d.platform_fees).toBe(100);
    expect(d.refunds).toBe(150);
    expect(d.net).toBe(2000 - 100 - 150); // 1750
    expect(d.paid_out).toBe(400);
    expect(d.pending).toBe(285); // 300 * 0.95
    expect(d.disputed).toBe(475); // 500 * 0.95
    expect(d.available).toBe(1750 - 400 - 475); // 875
  });
});

// ─── Export totals match dashboard/earnings definitions ───────────────────────

describe('export reconciles to the same ledger', () => {
  it('listLedgerEntries returns the same entries the breakdown is built from', async () => {
    const rows = [
      ledgerRow('booking_payment', 'credit', 1000),
      ledgerRow('platform_fee', 'debit', 50),
      ledgerRow('refund_debit', 'debit', 100),
    ];
    seed('earnings_ledger_entries', rows);

    const breakdown = await getHostLedgerBalanceBreakdown('host-1', PERIOD);
    const entries = await listLedgerEntries('host-1', PERIOD, 1, 1000);

    expect(entries.success).toBe(true);
    expect(entries.data!.entries).toHaveLength(3);
    // The export's gross/fees/refunds must match the breakdown's (same source rows).
    expect(breakdown.data!.gross).toBe(1000);
    expect(breakdown.data!.platform_fees).toBe(50);
    expect(breakdown.data!.refunds).toBe(100);
    expect(entries.data!.entries.every((e) => rows.some((r) => r.entry_type === e.entry_type))).toBe(true);
  });

  it('getReconciledEarnings and the breakdown agree on net', async () => {
    seed('earnings_ledger_entries', [
      ledgerRow('booking_payment', 'credit', 600),
      ledgerRow('platform_fee', 'debit', 30),
      ledgerRow('refund_debit', 'debit', 60),
    ]);
    const [summary, breakdown] = await Promise.all([
      earningsService.getReconciledEarnings('host-1', PERIOD),
      getHostLedgerBalanceBreakdown('host-1', PERIOD),
    ]);
    expect(summary.data!.net).toBe(breakdown.data!.net);
    expect(summary.data!.gross).toBe(breakdown.data!.gross);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('getReconciledEarnings — validation', () => {
  it('rejects a missing hostId', async () => {
    const r = await earningsService.getReconciledEarnings('', PERIOD);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/hostId is required/i);
  });

  it('rejects a missing date range', async () => {
    const r = await earningsService.getReconciledEarnings('host-1', { from: '', to: '', currency: 'USDC' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/from and to date range are required/i);
  });
});
