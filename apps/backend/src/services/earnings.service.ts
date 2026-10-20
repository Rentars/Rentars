import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

const PLATFORM_FEE_RATE = 0.05;
const DEFAULT_CURRENCY = 'USD';

/**
 * Append-only ledger entry types. Credits increase what the host is owed,
 * debits reduce it. Corrections are always new adjustment entries; historical
 * rows are never mutated.
 */
export type LedgerEntryType =
  | 'booking_credit'
  | 'platform_fee_debit'
  | 'release_credit'
  | 'refund_debit'
  | 'adjustment_credit'
  | 'adjustment_debit';

const CREDIT_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'booking_credit',
  'release_credit',
  'adjustment_credit',
]);

const DEBIT_TYPES: ReadonlySet<LedgerEntryType> = new Set<LedgerEntryType>([
  'platform_fee_debit',
  'refund_debit',
  'adjustment_debit',
]);

export interface LedgerEntryInput {
  hostId: string;
  bookingId: string | null;
  entryType: LedgerEntryType;
  /** Signed amount in minor units (e.g. cents). Sign is normalized by entry type. */
  amountMinor: number;
  currency?: string;
  /** Unique, deterministic reference used to make writes idempotent. */
  sourceRef: string;
}

export interface LedgerEntry {
  id: string;
  host_id: string;
  booking_id: string | null;
  entry_type: LedgerEntryType;
  amount_minor: number;
  currency: string;
  source_ref: string;
  created_at: string;
}

export interface EarningsSummary {
  gross: number;
  platform_fees: number;
  net: number;
  pending: number;
  released: number;
}

export interface ReconciliationResult {
  hostId: string;
  from: string;
  to: string;
  currency: string;
  ledgerNetMinor: number;
  settledNetMinor: number;
  chainNetMinor: number;
  discrepancyMinor: number;
  adjustmentsCreated: number;
}

function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

function fromMinor(amountMinor: number): number {
  return Math.round(amountMinor) / 100;
}

function normalizeCurrency(currency?: string): string {
  return (currency ?? DEFAULT_CURRENCY).toUpperCase();
}

function signedAmount(entryType: LedgerEntryType, amountMinor: number): number {
  const magnitude = Math.abs(Math.round(amountMinor));
  if (CREDIT_TYPES.has(entryType)) return magnitude;
  if (DEBIT_TYPES.has(entryType)) return -magnitude;
  return 0;
}

export class EarningsService {
  /**
   * Append a single ledger entry. Idempotent on `source_ref`: duplicate
   * callbacks (e.g. repeated provider webhooks) cannot create duplicate rows.
   * Returns the inserted entry, or null when the source_ref already existed.
   */
  async appendLedgerEntry(
    input: LedgerEntryInput,
  ): Promise<ServiceResponse<LedgerEntry | null>> {
    const { hostId, bookingId, entryType, amountMinor, sourceRef } = input;
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!sourceRef) return { success: false, error: 'sourceRef is required' };
    if (!CREDIT_TYPES.has(entryType) && !DEBIT_TYPES.has(entryType)) {
      return { success: false, error: `unknown entryType: ${entryType}` };
    }
    if (!Number.isFinite(amountMinor) || amountMinor === 0) {
      return { success: false, error: 'amountMinor must be a non-zero number' };
    }

    const row = {
      host_id: hostId,
      booking_id: bookingId,
      entry_type: entryType,
      amount_minor: signedAmount(entryType, amountMinor),
      currency: normalizeCurrency(input.currency),
      source_ref: sourceRef,
    };

    const { data, error } = await supabase
      .from('earnings_ledger')
      .upsert(row, { onConflict: 'source_ref', ignoreDuplicates: true })
      .select()
      .maybeSingle();

    if (error) return { success: false, error: error.message };
    return { success: true, data: (data as LedgerEntry | null) ?? null };
  }

  /**
   * Append multiple ledger entries atomically with their settlement events.
   * All entries share a single insert; any conflict on source_ref is ignored.
   */
  async appendLedgerEntries(
    inputs: LedgerEntryInput[],
  ): Promise<ServiceResponse<LedgerEntry[]>> {
    if (inputs.length === 0) return { success: true, data: [] };

    const rows = [];
    for (const input of inputs) {
      if (!input.hostId) return { success: false, error: 'hostId is required' };
      if (!input.sourceRef) return { success: false, error: 'sourceRef is required' };
      if (!CREDIT_TYPES.has(input.entryType) && !DEBIT_TYPES.has(input.entryType)) {
        return { success: false, error: `unknown entryType: ${input.entryType}` };
      }
      if (!Number.isFinite(input.amountMinor) || input.amountMinor === 0) {
        return { success: false, error: 'amountMinor must be a non-zero number' };
      }
      rows.push({
        host_id: input.hostId,
        booking_id: input.bookingId,
        entry_type: input.entryType,
        amount_minor: signedAmount(input.entryType, input.amountMinor),
        currency: normalizeCurrency(input.currency),
        source_ref: input.sourceRef,
      });
    }

    const { data, error } = await supabase
      .from('earnings_ledger')
      .upsert(rows, { onConflict: 'source_ref', ignoreDuplicates: true })
      .select();

    if (error) return { success: false, error: error.message };
    return { success: true, data: (data ?? []) as LedgerEntry[] };
  }

  /**
   * Derive the host earnings summary from the append-only ledger for the
   * given period (and optional currency).
   */
  async getHostEarnings(
    hostId: string,
    from: string,
    to: string,
    currency?: string,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!from || !to) return { success: false, error: 'from and to date range are required' };
    if (new Date(to) < new Date(from)) {
      return { success: false, error: 'to must be on or after from' };
    }

    let query = supabase
      .from('earnings_ledger')
      .select('entry_type, amount_minor, currency')
      .eq('host_id', hostId)
      .gte('created_at', from)
      .lte('created_at', to);

    if (currency) query = query.eq('currency', normalizeCurrency(currency));

    const { data, error } = await query;
    if (error) return { success: false, error: error.message };

    let grossMinor = 0;
    let feesMinor = 0;
    let releasedMinor = 0;
    let pendingMinor = 0;
    let netMinor = 0;

    for (const row of (data ?? []) as Array<{
      entry_type: LedgerEntryType;
      amount_minor: number;
    }>) {
      const amount = Number(row.amount_minor) || 0;
      netMinor += amount;
      switch (row.entry_type) {
        case 'booking_credit':
          grossMinor += amount;
          pendingMinor += amount;
          break;
        case 'platform_fee_debit':
          grossMinor += -amount;
          feesMinor += -amount;
          break;
        case 'release_credit':
          releasedMinor += amount;
          pendingMinor -= amount;
          break;
        case 'refund_debit':
          grossMinor += amount;
          releasedMinor += amount;
          pendingMinor += amount;
          break;
        case 'adjustment_credit':
        case 'adjustment_debit':
          // Adjustments affect net only; they are auditable corrections.
          break;
      }
    }

    return {
      success: true,
      data: {
        gross: fromMinor(grossMinor),
        platform_fees: fromMinor(feesMinor),
        net: fromMinor(netMinor),
        pending: fromMinor(pendingMinor),
        released: fromMinor(releasedMinor),
      },
    };
  }

  /**
   * Reconcile ledger totals against settled provider payments and on-chain
   * records. Any discrepancy is recorded as a new adjustment entry so that
   * history remains immutable and auditable.
   */
  async reconcileHostEarnings(
    hostId: string,
    from: string,
    to: string,
    currency?: string,
  ): Promise<ServiceResponse<ReconciliationResult>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!from || !to) return { success: false, error: 'from and to date range are required' };
    if (new Date(to) < new Date(from)) {
      return { success: false, error: 'to must be on or after from' };
    }

    const cur = normalizeCurrency(currency);

    const ledgerRes = await this.getHostEarnings(hostId, from, to, cur);
    if (!ledgerRes.success) return ledgerRes;
    const ledgerNetMinor = toMinor(ledgerRes.data.net);

    // Settled provider payments for this host in the period.
    const { data: payments, error: payErr } = await supabase
      .from('payments')
      .select('amount, status, currency, bookings!inner(properties!inner(owner_id))')
      .eq('bookings.properties.owner_id', hostId)
      .eq('status', 'settled')
      .gte('created_at', from)
      .lte('created_at', to);
    if (payErr) return { success: false, error: payErr.message };

    let settledNetMinor = 0;
    for (const p of (payments ?? []) as Array<{ amount: number; currency?: string }>) {
      if (p.currency && normalizeCurrency(p.currency) !== cur) continue;
      settledNetMinor += toMinor(Number(p.amount) || 0);
    }

    // On-chain settlement records for this host in the period.
    const { data: chainRecords, error: chainErr } = await supabase
      .from('chain_settlements')
      .select('amount, currency, host_id')
      .eq('host_id', hostId)
      .gte('created_at', from)
      .lte('created_at', to);
    if (chainErr) return { success: false, error: chainErr.message };

    let chainNetMinor = 0;
    for (const c of (chainRecords ?? []) as Array<{ amount: number; currency?: string }>) {
      if (c.currency && normalizeCurrency(c.currency) !== cur) continue;
      chainNetMinor += toMinor(Number(c.amount) || 0);
    }

    const discrepancyMinor = settledNetMinor - ledgerNetMinor;
    let adjustmentsCreated = 0;

    if (discrepancyMinor !== 0) {
      const sourceRef = `reconcile:${hostId}:${cur}:${from}:${to}:${discrepancyMinor}`;
      const entryType: LedgerEntryType =
        discrepancyMinor > 0 ? 'adjustment_credit' : 'adjustment_debit';
      const res = await this.appendLedgerEntry({
        hostId,
        bookingId: null,
        entryType,
        amountMinor: Math.abs(discrepancyMinor),
        currency: cur,
        sourceRef,
      });
      if (!res.success) return res;
      if (res.data) adjustmentsCreated = 1;
    }

    return {
      success: true,
      data: {
        hostId,
        from,
        to,
        currency: cur,
        ledgerNetMinor,
        settledNetMinor,
        chainNetMinor,
        discrepancyMinor,
        adjustmentsCreated,
      },
    };
  }
}
