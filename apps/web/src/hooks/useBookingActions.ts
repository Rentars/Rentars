'use client';

import { useState, useCallback } from 'react';
import type { Booking } from '@/types/booking';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type ActionType = 'confirm' | 'complete' | 'cancel' | 'dispute' | 'preview';

/** Settlement state of a refund after cancellation. */
export type RefundState =
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

/** Refund calculation shown to the user before confirming cancellation. */
export interface CancellationPreview {
  /** Amount the user is eligible to receive back */
  eligibleAmount: number;
  /** Currency of the eligible amount */
  currency: string;
  /** Fees retained by the platform/host */
  fees: number;
  /** Refund terms snapshot captured at booking time */
  policySnapshot?: Record<string, unknown>;
  /** Canonical timestamp the calculation was based on */
  calculatedAt?: string;
  /** Human-readable breakdown lines */
  breakdown?: string[];
}

interface UseBookingActionsResult {
  /** Currently executing action (or null) */
  pendingAction: ActionType | null;
  /** Latest error message (or null) */
  actionError: string | null;
  /** Latest refund settlement state (or null when no refund involved) */
  refundState: RefundState | null;
  /** Cancellation preview (calculation) fetched before cancelling */
  cancellationPreview: CancellationPreview | null;
  /** True while the cancellation preview is being fetched */
  previewLoading: boolean;
  /** True only when a refund has been confirmed as settled */
  isRefundComplete: boolean;
  /** Fetch the cancellation preview (calculation) without cancelling */
  fetchCancellationPreview: () => Promise<CancellationPreview | null>;
  /** Confirm check-in — transitions Pending → Confirmed */
  confirm: () => Promise<Booking | null>;
  /** Complete stay — transitions Confirmed → Completed */
  complete: () => Promise<Booking | null>;
  /** Cancel — transitions Pending|Confirmed → Cancelled */
  cancel: () => Promise<Booking | null>;
  /** Dispute — transitions Confirmed → Disputed */
  dispute: (reason?: string) => Promise<Booking | null>;
  clearError: () => void;
}

const REFUND_STATES: RefundState[] = [
  'requested',
  'submitted',
  'confirmed',
  'failed',
  'manual_review',
];

function normalizeRefundState(value: unknown): RefundState | null {
  return typeof value === 'string' && (REFUND_STATES as string[]).includes(value)
    ? (value as RefundState)
    : null;
}

/**
 * Hook that wraps all booking lifecycle mutation calls for a single booking.
 *
 * @param bookingId - UUID of the booking to act on
 * @param onSuccess - Optional callback fired with the updated booking after each action
 */
export function useBookingActions(
  bookingId: string,
  onSuccess?: (updated: Booking) => void,
): UseBookingActionsResult {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [actionError, setActionError]     = useState<string | null>(null);
  const [refundState, setRefundState]     = useState<RefundState | null>(null);
  const [cancellationPreview, setCancellationPreview] =
    useState<CancellationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const clearError = useCallback(() => setActionError(null), []);

  const fetchCancellationPreview = useCallback(async (): Promise<CancellationPreview | null> => {
    setPreviewLoading(true);
    setActionError(null);

    try {
      const url = `${API_BASE}/api/v1/bookings/${bookingId}/cancellation-preview`;
      const res = await fetch(url, { method: 'GET', headers: authHeaders() });
      const json = await res.json();

      if (!res.ok) {
        setActionError(json.error ?? 'Failed to load cancellation preview');
        return null;
      }

      const preview = json as CancellationPreview;
      setCancellationPreview(preview);
      return preview;
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to load cancellation preview',
      );
      return null;
    } finally {
      setPreviewLoading(false);
    }
  }, [bookingId]);

  const call = useCallback(
    async (action: ActionType, body?: Record<string, unknown>): Promise<Booking | null> => {
      setPendingAction(action);
      setActionError(null);

      try {
        const url = `${API_BASE}/api/v1/bookings/${bookingId}/${action}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: authHeaders(),
          body: body ? JSON.stringify(body) : undefined,
        });

        const json = await res.json();

        if (!res.ok) {
          setActionError(json.error ?? `Failed to ${action} booking`);
          return null;
        }

        const updated = json as Booking;

        if (action === 'cancel') {
          // Refund settlement state comes from the server; never assume completion.
          const state = normalizeRefundState(
            (json as { refundState?: unknown }).refundState,
          );
          setRefundState(state);
        }

        onSuccess?.(updated);
        return updated;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Failed to ${action} booking`);
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [bookingId, onSuccess],
  );

  const confirm  = useCallback(() => call('confirm'),            [call]);
  const complete = useCallback(() => call('complete'),           [call]);
  const cancel   = useCallback(() => call('cancel'),             [call]);
  const dispute  = useCallback(
    (reason?: string) => call('dispute', reason ? { reason } : undefined),
    [call],
  );

  // Only a confirmed refund may be presented to the user as complete.
  const isRefundComplete = refundState === 'confirmed';

  return {
    pendingAction,
    actionError,
    refundState,
    cancellationPreview,
    previewLoading,
    isRefundComplete,
    fetchCancellationPreview,
    confirm,
    complete,
    cancel,
    dispute,
    clearError,
  };
}
