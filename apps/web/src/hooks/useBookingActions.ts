'use client';

import { useState, useCallback, useRef } from 'react';
import type { Booking } from '@/types/booking';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type ActionType = 'confirm' | 'complete' | 'cancel' | 'dispute';

interface UseBookingActionsResult {
  /** Currently executing action (or null) */
  pendingAction: ActionType | null;
  /** Latest error message (or null) */
  actionError: string | null;
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

  // Synchronous re-entry guard: state updates land after the current tick, so
  // a second click before re-render must be rejected here or two POSTs fire.
  const inFlightRef = useRef(false);

  const clearError = useCallback(() => setActionError(null), []);

  const call = useCallback(
    async (action: ActionType, body?: Record<string, unknown>): Promise<Booking | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
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
        onSuccess?.(updated);
        return updated;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : `Failed to ${action} booking`);
        return null;
      } finally {
        inFlightRef.current = false;
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

  return { pendingAction, actionError, confirm, complete, cancel, dispute, clearError };
}
