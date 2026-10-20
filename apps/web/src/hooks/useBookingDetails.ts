'use client';

import { useEffect, useState } from 'react';
import type { Booking } from '@/types/booking';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface PriceBreakdown {
  base_nightly_rate: number;
  nights: number;
  subtotal: number;
  dynamic_adjustments: number;
  platform_fee_pct: number;
  platform_fee: number;
  total: number;
  breakdown: Array<{ date: string; price: number; is_available: boolean; reason?: string }>;
}

export type RefundSettlementState =
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

export interface RefundRequest {
  id: string;
  booking_id: string;
  status: RefundSettlementState;
  amount: number;
  currency?: string;
  destination_reference?: string | null;
  provider_reference?: string | null;
  failure_reason?: string | null;
  retryable?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RefundCalculation {
  eligible: boolean;
  eligible_amount: number;
  currency?: string;
  policy_snapshot_id?: string | null;
  policy_snapshot_at?: string | null;
  cancellation_fee?: number;
  platform_fee_refund?: number;
  non_refundable_amount?: number;
  reason?: string | null;
  computed_at?: string | null;
}

export interface BookingDetailsResponse extends Booking {
  quote_version?: string | null;
  reconciliation_state?: string | null;
  refund_request?: RefundRequest | null;
  refund_calculation?: RefundCalculation | null;
}

export function useBookingDetails(bookingId: string) {
  const [booking, setBooking] = useState<BookingDetailsResponse | null>(null);
  const [priceBreakdown, setPriceBreakdown] = useState<PriceBreakdown | null>(null);
  const [refundRequest, setRefundRequest] = useState<RefundRequest | null>(null);
  const [refundCalculation, setRefundCalculation] = useState<RefundCalculation | null>(null);
  const [quoteVersion, setQuoteVersion] = useState<string | null>(null);
  const [reconciliationState, setReconciliationState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bookingId) return;

    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/bookings/${bookingId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(async (data: BookingDetailsResponse) => {
        setBooking(data);
        setRefundRequest(data.refund_request ?? null);
        setRefundCalculation(data.refund_calculation ?? null);
        setQuoteVersion(data.quote_version ?? null);
        setReconciliationState(data.reconciliation_state ?? null);
        if (data.property_id && data.check_in && data.check_out) {
          const start = data.check_in.split('T')[0];
          const end = data.check_out.split('T')[0];
          const quoteRes = await fetch(
            `${API_URL}/api/v1/properties/${data.property_id}/quote?start=${start}&end=${end}`,
          ).catch(() => null);
          if (quoteRes?.ok) {
            setPriceBreakdown(await quoteRes.json());
          }
        }
      })
      .catch(() => setError('Failed to load booking'))
      .finally(() => setIsLoading(false));
  }, [bookingId]);

  return {
    booking,
    priceBreakdown,
    refundRequest,
    refundCalculation,
    quoteVersion,
    reconciliationState,
    isLoading,
    error,
  };
}
