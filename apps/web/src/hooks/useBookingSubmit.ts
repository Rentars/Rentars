'use client';

/**
 * useBookingSubmit — idempotency-safe booking submission with offline resilience.
 *
 * Design decisions
 * ----------------
 * 1. NEVER queue a payment or booking mutation for blind replay.
 *    After reconnect, we look up the server-side status of the last operation
 *    via its idempotency key.  If the server already committed the booking, we
 *    surface that result without re-submitting.
 *
 * 2. The idempotency key is a client-generated UUID scoped to the current
 *    form session.  It is included in every submission attempt so the backend
 *    can deduplicate retries that cross a disconnect/reconnect boundary.
 *
 * 3. Local draft preservation: non-sensitive form values (dates, guest count)
 *    are saved to localStorage so the user can continue after a page reload.
 *    Payment data, wallet keys, and XDR transactions are NEVER stored locally.
 *
 * 4. On reconnect, cached availability and pricing data is marked stale so
 *    the form refetches before allowing a new submission.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import {
  saveDraft,
  loadDraft,
  clearDraft,
  markCachedDataStale,
  clearStaleMarker,
  type BookingDraft,
} from '@/lib/offlineSafety';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BookingSubmitInput {
  propertyId: string;
  checkIn: string;   // ISO date YYYY-MM-DD
  checkOut: string;  // ISO date YYYY-MM-DD
  guestCount: number;
  totalPrice: number;
  rulesAcknowledgedAt: string;
  /** Platform policy version the tenant agreed to. */
  termsVersion?: string;
}

export type SubmitStatus =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'error'
  | 'offline'
  | 'checking_status'; // polling server after reconnect

export interface UseBookingSubmitResult {
  /** Current lifecycle state of the submission. */
  status: SubmitStatus;
  /** The booking returned by the server on success (or discovered via status lookup). */
  booking: Record<string, unknown> | null;
  /** User-facing error message; null when status is not 'error'. */
  errorMessage: string | null;
  /** True when cached availability/pricing data may be outdated. */
  dataIsStale: boolean;
  /**
   * Submit the booking.  Returns immediately when offline — sets status to
   * 'offline' and preserves the form draft so the user can retry.
   */
  submit: (input: BookingSubmitInput) => Promise<void>;
  /** Clear the idempotency key and draft, resetting to 'idle'. */
  reset: () => void;
  /** Restore a previously saved draft for this property. */
  restoredDraft: BookingDraft | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * Generate a UUID v4 idempotency key.  Uses crypto.randomUUID when available,
 * falls back to a hex timestamp + random suffix that is unique per session.
 */
function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function useBookingSubmit(propertyId: string): UseBookingSubmitResult {
  const { isOnline, justReconnected } = useOnlineStatus();

  const [status, setStatus]           = useState<SubmitStatus>('idle');
  const [booking, setBooking]         = useState<Record<string, unknown> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dataIsStale, setDataIsStale] = useState(false);

  // Idempotency key is stable for the lifetime of this form session.
  // It resets only when reset() is called.
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey());

  // Track whether a submission was in-flight when connectivity dropped.
  const pendingKeyRef = useRef<string | null>(null);

  // Restored draft (non-null when loadDraft returns a saved form state).
  const [restoredDraft, setRestoredDraft] = useState<BookingDraft | null>(null);

  // On mount: restore any saved draft for this property.
  useEffect(() => {
    const draft = loadDraft(propertyId);
    if (draft) {
      setRestoredDraft(draft);
      // Reuse the draft's idempotency key so a reconnect lookup targets the
      // right server-side record.
      idempotencyKeyRef.current = draft.idempotencyKey;
    }
  }, [propertyId]);

  // On reconnect: mark cached data as stale and attempt a status lookup
  // if a submission was pending at the moment connectivity dropped.
  useEffect(() => {
    if (!justReconnected) return;

    // Any availability / pricing data fetched while offline may be outdated.
    markCachedDataStale();
    setDataIsStale(true);

    const keyToCheck = pendingKeyRef.current;
    if (!keyToCheck) return;

    // We had an in-flight submission when we went offline.  Rather than
    // blindly resending, ask the server whether it already committed the booking.
    setStatus('checking_status');

    fetch(`${API_URL}/api/v1/bookings/idempotency-status`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': keyToCheck,
      },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          // Server has no record (404) or errored — allow the user to retry.
          pendingKeyRef.current = null;
          setStatus('idle');
          return;
        }
        const body = (await res.json()) as {
          status: 'processing' | 'completed';
          booking?: Record<string, unknown>;
        };
        if (body.status === 'completed' && body.booking) {
          // The server committed the booking before connectivity dropped.
          setBooking(body.booking);
          setStatus('success');
          clearDraft(propertyId);
          pendingKeyRef.current = null;
        } else {
          // Still processing or not found — let the user retry.
          pendingKeyRef.current = null;
          setStatus('idle');
        }
      })
      .catch(() => {
        // Network error on the status check itself — stay idle, let user retry.
        pendingKeyRef.current = null;
        setStatus('idle');
      });
  }, [justReconnected, propertyId]);

  // When we come back online and clear stale state after a successful recheck,
  // remove the stale marker from sessionStorage.
  useEffect(() => {
    if (isOnline && status === 'success') {
      clearStaleMarker();
      setDataIsStale(false);
    }
  }, [isOnline, status]);

  const submit = useCallback(
    async (input: BookingSubmitInput): Promise<void> => {
      // Block submission while offline.
      if (!isOnline) {
        // Save non-sensitive form state so the user can continue after reconnect.
        const draft: BookingDraft = {
          idempotencyKey: idempotencyKeyRef.current,
          propertyId: input.propertyId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guestCount: input.guestCount,
          savedAt: Date.now(),
        };
        saveDraft(draft);
        setRestoredDraft(draft);
        setStatus('offline');
        setErrorMessage(
          'You are offline. Your form progress has been saved. ' +
          'Once you reconnect, we will check whether your previous attempt succeeded before retrying.',
        );
        return;
      }

      // Block submission while stale data has not been refreshed.
      if (dataIsStale) {
        setErrorMessage(
          'Availability and pricing data may be outdated after a connectivity interruption. ' +
          'Please wait for the page to refresh before submitting.',
        );
        return;
      }

      setStatus('submitting');
      setErrorMessage(null);

      // Record the key that is now in-flight so the reconnect effect can look
      // it up if connectivity drops mid-request.
      pendingKeyRef.current = idempotencyKeyRef.current;

      try {
        const res = await fetch(`${API_URL}/api/v1/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKeyRef.current,
          },
          credentials: 'include',
          body: JSON.stringify({
            property_id:           input.propertyId,
            check_in:              input.checkIn,
            check_out:             input.checkOut,
            guest_count:           input.guestCount,
            total_price:           input.totalPrice,
            rules_acknowledged_at: input.rulesAcknowledgedAt,
            terms_version:         input.termsVersion,
          }),
        });

        const body = (await res.json()) as { data?: Record<string, unknown>; error?: string };

        if (!res.ok) {
          pendingKeyRef.current = null;
          setStatus('error');
          setErrorMessage(body.error ?? `Booking failed (HTTP ${res.status})`);
          return;
        }

        // Success — clear draft and pending state.
        pendingKeyRef.current = null;
        setBooking(body.data ?? null);
        setStatus('success');
        clearDraft(input.propertyId);
      } catch (err) {
        // Network error — the request may or may not have reached the server.
        // Do NOT retry automatically.  Leave pendingKeyRef set so the reconnect
        // effect can query the server status when connectivity returns.
        setStatus('offline');
        setErrorMessage(
          'The connection was lost while submitting. ' +
          'Your form progress has been saved. ' +
          'We will check the booking status as soon as you reconnect.',
        );
        // Persist form state so it survives a page reload.
        const draft: BookingDraft = {
          idempotencyKey: idempotencyKeyRef.current,
          propertyId: input.propertyId,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guestCount: input.guestCount,
          savedAt: Date.now(),
        };
        saveDraft(draft);
        // Suppress unused variable warning
        void err;
      }
    },
    [isOnline, dataIsStale, propertyId],
  );

  const reset = useCallback(() => {
    idempotencyKeyRef.current = generateIdempotencyKey();
    pendingKeyRef.current = null;
    setStatus('idle');
    setBooking(null);
    setErrorMessage(null);
    setRestoredDraft(null);
    clearDraft(propertyId);
    clearStaleMarker();
    setDataIsStale(false);
  }, [propertyId]);

  return { status, booking, errorMessage, dataIsStale, submit, reset, restoredDraft };
}
