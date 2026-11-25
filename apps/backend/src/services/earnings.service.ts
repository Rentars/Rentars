import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import {
  getHostLedgerBalanceBreakdown,
  recordBookingSettlement,
  type PeriodFilter,
  type LedgerBalanceBreakdown,
} from './ledger.service.js';

const PLATFORM_FEE_RATE = 0.05;

export interface EarningsSummary {
  gross: number;
  platform_fees: number;
  net: number;
  pending: number;
  released: number;
  /** Refunds returned to tenants (Σ refund_debit). Subtracted once from net. */
  refunds?: number;
  /** Net manual adjustments (Σ adjustment credits − debits). */
  adjustments?: number;
  /** Funds already paid out to the host wallet (Σ escrow_release). */
  paid_out?: number;
  /** Disputed-booking funds on hold — NOT withdrawable. */
  disputed?: number;
  /**
   * Available (withdrawable) balance = net − paid_out − disputed.
   * Includes only funds eligible for payout under policy.
   */
  available?: number;
}

export class EarningsService {
  async getHostEarnings(
    hostId: string,
    from: string,
    to: string,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!from || !to) return { success: false, error: 'from and to date range are required' };
    if (new Date(to) < new Date(from)) {
      return { success: false, error: 'to must be on or after from' };
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .not('status', 'eq', 'Cancelled')
      .gte('created_at', from)
      .lte('created_at', to);

    if (error) return { success: false, error: error.message };

    let gross = 0;
    let pending = 0;
    let released = 0;

    for (const row of (data ?? []) as Array<{ total_price: number; status: string }>) {
      const price = Number(row.total_price) || 0;
      gross += price;
      if (row.status === 'Confirmed' || row.status === 'Completed') {
        released += price;
      } else {
        pending += price;
      }
    }

    const platform_fees = Math.round(gross * PLATFORM_FEE_RATE * 100) / 100;
    const net = Math.round((gross - platform_fees) * 100) / 100;
    const releasedNet = Math.round(released * 0.95 * 100) / 100;
    const pendingNet = Math.round(pending * 0.95 * 100) / 100;

    return {
      success: true,
      data: {
        gross: Math.round(gross * 100) / 100,
        platform_fees,
        net,
        pending: pendingNet,
        released: releasedNet,
      },
    };
  }

  /**
   * Reconciled earnings — derives the host's balances from the append-only
   * ledger (Feature 4 / #770). This is the auditable view: every credit and
   * debit is sourced from a settlement event, not a mutable summary row.
   *
   * Balance model (all ledger-derived unless noted):
   *   gross         Σ booking_payment credits (settled booking revenue)
   *   platform_fees Σ platform_fee debits
   *   refunds       Σ refund_debit debits (subtracted exactly once from net)
   *   adjustments   Σ adjustment credits − Σ adjustment debits
   *   net           gross − platform_fees − refunds + adjustments  (settled net)
   *   paid_out      Σ escrow_release credits (funds sent to the host wallet)
   *   pending       Reserved funds from Pending bookings NOT yet in the ledger
   *                 (in escrow, NOT withdrawable)
   *   disputed      Disputed-booking funds on hold (NOT withdrawable)
   *   available     net − paid_out − disputed  (only funds eligible for payout)
   *   released      Alias of `available`, kept for API/UI backward compatibility.
   *
   * Refunds cannot double-count: a refund_debit is subtracted once from net,
   * and reserved (pending) bookings are computed separately and never include
   * cancelled/refunded bookings. Disputed funds are removed from `available`
   * so they are never presented as withdrawable.
   */
  async getReconciledEarnings(
    hostId: string,
    filter: PeriodFilter,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };
    if (!filter.from || !filter.to) {
      return { success: false, error: 'from and to date range are required' };
    }

    // 1. Per-entry-type ledger breakdown (gross, fees, refunds, adjustments, paid_out, net).
    const breakdownResult = await getHostLedgerBalanceBreakdown(hostId, filter);
    if (!breakdownResult.success || !breakdownResult.data) {
      return { success: false, error: breakdownResult.error };
    }
    const b: LedgerBalanceBreakdown = breakdownResult.data;

    // 2. Reserved (pending) and disputed funds from bookings NOT yet settled /
    //    on hold. These are NOT in the ledger and must NOT be presented as
    //    withdrawable. Pending = reserved in escrow; Disputed = held.
    const pendingAndDisputed = await this.reservedAndDisputed(hostId, filter);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const available = round2(b.net - b.paid_out - pendingAndDisputed.disputed);

    return {
      success: true,
      data: {
        gross: b.gross,
        platform_fees: b.platform_fees,
        refunds: b.refunds,
        adjustments: b.adjustments_net,
        net: b.net,
        paid_out: b.paid_out,
        pending: round2(pendingAndDisputed.pending),
        disputed: round2(pendingAndDisputed.disputed),
        available,
        // Backward-compatible alias: "Released" = the withdrawable settled balance.
        released: available,
      },
    };
  }

  /**
   * Compute reserved (Pending) and held (Disputed) booking nets for a period.
   * Pending bookings are not yet in the ledger (funds in escrow); Disputed
   * bookings are settled but held. Neither is withdrawable. Cancelled bookings
   * are excluded so refunded bookings never reappear as "pending".
   */
  private async reservedAndDisputed(
    hostId: string,
    filter: PeriodFilter,
  ): Promise<{ pending: number; disputed: number }> {
    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .in('status', ['Pending', 'Disputed'])
      .gte('created_at', filter.from)
      .lte('created_at', filter.to);

    if (error || !data) return { pending: 0, disputed: 0 };

    let pending = 0;
    let disputed = 0;
    for (const row of data as Array<{ total_price: number | string; status: string }>) {
      const price = Number(row.total_price) || 0;
      const net = price * (1 - PLATFORM_FEE_RATE);
      if (row.status === 'Pending') pending += net;
      else if (row.status === 'Disputed') disputed += net;
    }
    return { pending, disputed };
  }
}

// Re-export ledger helpers for convenience
export { recordBookingSettlement };
