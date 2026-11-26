import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { EarningsService } from '@/services/earnings.service.js';
import {
  getHostLedgerBalance,
  listLedgerEntries,
  reconcileHostLedger,
  postAdjustment,
  type LedgerDirection,
  type LedgerCurrency,
  type LedgerEntry,
} from '@/services/ledger.service.js';
import {
  parseDateRange,
  type DateRangeMetadata,
} from '@/services/analytics/date-range.service.js';
import { EARNINGS_METRIC_DEFINITIONS } from '@/services/analytics/metric-definitions.js';

const earningsService = new EarningsService();

/**
 * Parses and validates the `from`/`to` query parameters using the shared
 * date-range parser so every host widget and export resolves windows the
 * same way (calendar timezone, inclusive end-of-day, partial periods).
 */
function validateDateParams(
  from: unknown,
  to: unknown,
  timezone?: unknown,
): DateRangeMetadata | null {
  const parsed = parseDateRange({ from, to, timezone });
  return parsed.success ? parsed.data : null;
}
======

function parseCurrency(value: unknown): LedgerCurrency | null {
  if (value === undefined) return 'USDC';
  return value === 'USDC' ? 'USDC' : null;
}

/**
 * GET /api/v1/host/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns gross, platform_fees, net, pending, and released earnings for the
 * authenticated host over the requested date range.
 */
export async function getHostEarnings(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, timezone } = req.query as {
    from?: string;
    to?: string;
    timezone?: string;
  };
  if (!from || !to) {
    res.status(422).json({ error: 'from and to query parameters are required (YYYY-MM-DD)' });
    return;
  }

  const range = validateDateParams(from, to, timezone);
  if (!range) {
    res.status(422).json({ error: 'from and to must be valid dates in YYYY-MM-DD format' });
    return;
  }

  const result = await earningsService.getReconciledEarnings(hostId, {
    from: range.from,
    to: range.to,
    currency: 'USDC',
  });
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    ...result.data,
    metadata: {
      range,
      currency: 'USDC',
      definitions: EARNINGS_METRIC_DEFINITIONS,
    },
  });
}
======

/**
 * GET /api/v1/host/ledger?from=&to=&currency=USDC&page=1&limit=50
 *
 * Returns paginated append-only ledger entries for the authenticated host.
 */
export async function getLedgerEntries(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency, timezone } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
    timezone?: string;
  };

  const range = validateDateParams(from, to, timezone);
  if (!range) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }
  const parsedCurrency = parseCurrency(currency);
  if (!parsedCurrency) {
    res.status(422).json({ error: 'currency must be USDC' });
    return;
  }

  const page  = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));

  const result = await listLedgerEntries(
    hostId,
    { from: range.from, to: range.to, currency: parsedCurrency },
    page,
    limit,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    ...result.data,
    metadata: {
      range,
      currency: parsedCurrency,
      definitions: EARNINGS_METRIC_DEFINITIONS,
    },
  });
}
======

/**
 * GET /api/v1/host/ledger/balance?from=&to=&currency=USDC
 *
 * Returns the derived balance (credits − debits) for the authenticated host
 * over the requested period.  Balances are derived from source events rather
 * than a mutable summary column.
 */
export async function getLedgerBalance(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency, timezone } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
    timezone?: string;
  };

  const range = validateDateParams(from, to, timezone);
  if (!range) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }
  const parsedCurrency = parseCurrency(currency);
  if (!parsedCurrency) {
    res.status(422).json({ error: 'currency must be USDC' });
    return;
  }

  const result = await getHostLedgerBalance(
    hostId,
    { from: range.from, to: range.to, currency: parsedCurrency },
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    ...result.data,
    metadata: {
      range,
      currency: parsedCurrency,
      definitions: EARNINGS_METRIC_DEFINITIONS,
    },
  });
}
======

/**
 * GET /api/v1/host/ledger/reconcile?from=&to=&currency=USDC
 *
 * Runs a reconciliation check comparing the ledger net against settled booking
 * totals.  Returns a drift value and a reconciled flag.
 */
export async function getReconciliationReport(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency, timezone } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
    timezone?: string;
  };

  const range = validateDateParams(from, to, timezone);
  if (!range) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }
  const parsedCurrency = parseCurrency(currency);
  if (!parsedCurrency) {
    res.status(422).json({ error: 'currency must be USDC' });
    return;
  }

  const result = await reconcileHostLedger(
    hostId,
    { from: range.from, to: range.to, currency: parsedCurrency },
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({
    ...result.data,
    metadata: {
      range,
      currency: parsedCurrency,
      definitions: EARNINGS_METRIC_DEFINITIONS,
    },
  });
}
======

/**
 * POST /api/v1/admin/host/:hostId/ledger/adjustment
/**
 * GET /api/v1/host/earnings/export?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=USDC
 *
 * Returns the host's earnings summary AND the underlying ledger entries for
 * the period using the SAME definitions as the /earnings and /ledger/balance
 * endpoints, so an exported report reconciles exactly with the dashboard and
 * the earnings view (Feature 4).  Entries are capped at 1000 per export.
 */
export async function getEarningsExport(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
  };

  const dates = validateDateParams(from, to);
  if (!dates) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }
  const parsedCurrency = parseCurrency(currency);
  if (!parsedCurrency) {
    res.status(422).json({ error: 'currency must be USDC' });
    return;
  }

  const filter = { ...dates, currency: parsedCurrency };

  const [summaryResult, entriesResult] = await Promise.all([
    earningsService.getReconciledEarnings(hostId, filter),
    listLedgerEntries(hostId, filter, 1, 1000),
  ]);

  if (!summaryResult.success) {
    res.status(400).json({ error: summaryResult.error });
    return;
  }
  if (!entriesResult.success) {
    res.status(400).json({ error: entriesResult.error });
    return;
  }

  const entries: LedgerEntry[] = entriesResult.data!.entries;
  const summary = summaryResult.data!;

  res.json({
    summary,
    entries,
    totals: {
      gross: summary.gross,
      platform_fees: summary.platform_fees,
      refunds: summary.refunds ?? 0,
      net: summary.net,
      paid_out: summary.paid_out ?? 0,
      available: summary.available ?? summary.released,
      pending: summary.pending,
      disputed: summary.disputed ?? 0,
    },
    period: { from: dates.from, to: dates.to },
    currency: parsedCurrency,
    generated_at: new Date().toISOString(),
    entry_count: entries.length,
    total_entries_in_period: entriesResult.data!.total,
  });
}

/**
 * POST /api/v1/admin/host/:hostId/ledger/adjustment
 *
 * Ops-only: post an auditable adjustment entry instead of editing history.
 * Body: { direction: 'credit'|'debit', amount: number, adminNote: string, bookingId?: string }
 */
export async function postLedgerAdjustment(req: AuthRequest, res: Response): Promise<void> {
  const adminId = req.userId;
  if (!adminId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hostId } = req.params;
  if (typeof hostId !== 'string' || !hostId.trim()) {
    res.status(400).json({ error: 'Host ID is required' });
    return;
  }
  const { direction, amount, adminNote, bookingId } = req.body as {
    direction?: unknown;
    amount?: unknown;
    adminNote?: unknown;
    bookingId?: unknown;
  };

  if (direction !== 'credit' && direction !== 'debit') {
    res.status(422).json({ error: 'direction must be "credit" or "debit"' });
    return;
  }

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    res.status(422).json({ error: 'amount must be a positive finite number' });
    return;
  }

  if (typeof adminNote !== 'string' || !adminNote.trim()) {
    res.status(422).json({ error: 'adminNote is required for adjustments' });
    return;
  }

  const result = await postAdjustment(
    hostId,
    direction as LedgerDirection,
    numAmount,
    adminId,
    adminNote,
    typeof bookingId === 'string' ? bookingId : undefined,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data ?? { message: 'Duplicate adjustment — no new entry created' });
}
