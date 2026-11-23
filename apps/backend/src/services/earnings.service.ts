import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import {
  getHostLedgerBalance,
  recordBookingSettlement,
  type PeriodFilter,
} from './ledger.service.js';
import {
  parseDateRange,
  isCountedBookingStatus,
  isReleasedBookingStatus,
  roundMoney,
  type MetricMetadata,
} from './metrics.service.js';

const PLATFORM_FEE_RATE = 0.05;
const DEFAULT_CURRENCY = 'USD';

export interface EarningsSummary {
  gross: number;
  platform_fees: number;
  net: number;
  pending: number;
  released: number;
  /** ISO 4217 currency code the amounts are expressed in. */
  currency: string;
  /** Explicit window / inclusion metadata shared with dashboard widgets and exports. */
  metadata: MetricMetadata;
}

export class EarningsService {
  async getHostEarnings(
    hostId: string,
    from: string,
    to: string,
    currency: string = DEFAULT_CURRENCY,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };

    const range = parseDateRange(from, to);
    if (!range.success || !range.data) {
      return { success: false, error: range.error ?? 'invalid date range' };
    }
    const window = range.data;

    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .in('status', ['Confirmed', 'Completed', 'Pending'])
      .gte('created_at', window.from)
      .lte('created_at', window.to);

    if (error) return { success: false, error: error.message };

    let gross = 0;
    let pending = 0;
    let released = 0;

    for (const row of (data ?? []) as Array<{ total_price: number; status: string }>) {
      if (!isCountedBookingStatus(row.status)) continue;
      const price = Number(row.total_price) || 0;
      gross += price;
      if (isReleasedBookingStatus(row.status)) {
        released += price;
      } else {
        pending += price;
      }
    }

    const platform_fees = roundMoney(gross * PLATFORM_FEE_RATE);
    const net = roundMoney(gross - platform_fees);
    const releasedNet = roundMoney(released * (1 - PLATFORM_FEE_RATE));
    const pendingNet = roundMoney(pending * (1 - PLATFORM_FEE_RATE));

    return {
      success: true,
      data: {
        gross: roundMoney(gross),
        platform_fees,
        net,
        pending: pendingNet,
        released: releasedNet,
        currency,
        metadata: {
          metric: 'earnings',
          window,
          currency,
          gross_or_net: 'net',
          includes_cancelled: false,
          booked_or_completed: 'booked',
        },
      },
    };
  }

  /**
   * Reconciled earnings — derives the host's balance from the append-only ledger
   * (#770).  This is the auditable view: every credit and debit is sourced from
   * a settlement event, not a mutable summary row.
   */
  async getReconciledEarnings(
    hostId: string,
    filter: PeriodFilter,
    currency: string = DEFAULT_CURRENCY,
  ): Promise<ServiceResponse<EarningsSummary>> {
    if (!hostId) return { success: false, error: 'hostId is required' };

    const range = parseDateRange(filter.from, filter.to);
    if (!range.success || !range.data) {
      return { success: false, error: range.error ?? 'invalid date range' };
    }
    const window = range.data;

    // Derive balance from the ledger (credits − debits)
    const balanceResult = await getHostLedgerBalance(hostId, {
      ...filter,
      from: window.from,
      to: window.to,
    });
    if (!balanceResult.success || !balanceResult.data) {
      return { success: false, error: balanceResult.error };
    }

    const balance = balanceResult.data;

    // Fetch pending vs released from bookings table (for the pending/released split)
    const { data, error } = await supabase
      .from('bookings')
      .select('total_price, status, properties!inner(owner_id)')
      .eq('properties.owner_id', hostId)
      .in('status', ['Confirmed', 'Completed', 'Pending'])
      .gte('created_at', window.from)
      .lte('created_at', window.to);

    if (error) return { success: false, error: error.message };

    let pending = 0;
    let released = 0;

    for (const row of (data ?? []) as Array<{ total_price: number; status: string }>) {
      if (!isCountedBookingStatus(row.status)) continue;
      const price = Number(row.total_price) || 0;
      if (isReleasedBookingStatus(row.status)) {
        released += price;
      } else {
        pending += price;
      }
    }

    return {
      success: true,
      data: {
        gross: roundMoney(balance.total_credits),
        platform_fees: roundMoney(balance.total_debits),
        net: roundMoney(balance.net),
        pending: roundMoney(pending * (1 - PLATFORM_FEE_RATE)),
        released: roundMoney(released * (1 - PLATFORM_FEE_RATE)),
        currency,
        metadata: {
          metric: 'earnings',
          window,
          currency,
          gross_or_net: 'net',
          includes_cancelled: false,
          booked_or_completed: 'booked',
        },
      },
    };
  }
}

// Re-export ledger helpers for convenience
export { recordBookingSettlement };
