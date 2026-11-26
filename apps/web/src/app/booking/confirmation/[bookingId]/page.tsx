'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import BookingConfirmationPage from '@/components/booking/confirmation/BookingConfirmationPage';

interface ConfirmationPageProps {
  params: {
    bookingId: string;
  };
}

type EscrowState =
  | 'pending'
  | 'secured'
  | 'released'
  | 'failed'
  | 'indeterminate';

interface BookingStatusResponse {
  bookingId: string;
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  paymentStatus: 'pending' | 'succeeded' | 'failed';
  escrowStatus: EscrowState;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: BookingStatusResponse };

const BOOKING_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_POLL_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

function isValidBookingId(value: unknown): value is string {
  return typeof value === 'string' && BOOKING_ID_PATTERN.test(value);
}

function backoffDelay(attempt: number): number {
  const delay = BASE_BACKOFF_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function isPending(data: BookingStatusResponse): boolean {
  return (
    data.status === 'pending' ||
    data.paymentStatus === 'pending' ||
    data.escrowStatus === 'pending'
  );
}

export default function ConfirmationPage({ params }: ConfirmationPageProps) {
  const bookingId = params?.bookingId;
  const validId = isValidBookingId(bookingId);

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const pollAttemptsRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(
    async (id: string): Promise<LoadState> => {
      try {
        const response = await fetch(
          `/api/bookings/${encodeURIComponent(id)}/status`,
          {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          },
        );

        if (response.status === 401 || response.status === 403) {
          return { kind: 'unauthorized' };
        }

        if (response.status === 404) {
          return { kind: 'not-found' };
        }

        if (!response.ok) {
          return {
            kind: 'error',
            message: 'We could not verify your booking status right now.',
          };
        }

        const data = (await response.json()) as BookingStatusResponse;

        if (!data || data.bookingId !== id) {
          return {
            kind: 'error',
            message: 'We received an unexpected response while verifying your booking.',
          };
        }

        return { kind: 'ready', data };
      } catch {
        return {
          kind: 'error',
          message: 'A network error occurred while verifying your booking status.',
        };
      }
    },
    [],
  );

  useEffect(() => {
    if (!validId) {
      setState({ kind: 'not-found' });
      return;
    }

    cancelledRef.current = false;
    pollAttemptsRef.current = 0;
    clearPendingTimeout();
    setState({ kind: 'loading' });

    const run = async () => {
      const result = await fetchStatus(bookingId);
      if (cancelledRef.current) return;

      setState(result);

      if (result.kind === 'ready' && isPending(result.data)) {
        schedulePoll(bookingId);
      }
    };

    const schedulePoll = (id: string) => {
      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        return;
      }
      const delay = backoffDelay(pollAttemptsRef.current);
      pollAttemptsRef.current += 1;

      timeoutRef.current = setTimeout(async () => {
        if (cancelledRef.current) return;
        const result = await fetchStatus(id);
        if (cancelledRef.current) return;

        setState(result);

        if (result.kind === 'ready' && isPending(result.data)) {
          schedulePoll(id);
        }
      }, delay);
    };

    void run();

    return () => {
      cancelledRef.current = true;
      clearPendingTimeout();
    };
  }, [bookingId, validId, retryNonce, fetchStatus, clearPendingTimeout]);

  if (!validId) {
    notFound();
  }

  const handleRetry = () => {
    setRetryNonce((n) => n + 1);
  };

  return (
    <main className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4">
        {state.kind === 'loading' && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-lg bg-white p-6 shadow text-center text-gray-600"
          >
            Verifying your booking and payment status…
          </div>
        )}

        {state.kind === 'unauthorized' && (
          <div
            role="alert"
            className="rounded-lg bg-white p-6 shadow text-center"
          >
            <h1 className="text-lg font-semibold text-gray-900">
              You don&apos;t have access to this booking
            </h1>
            <p className="mt-2 text-gray-600">
              Sign in with the account used to make this booking, or contact
              support if you believe this is a mistake.
            </p>
          </div>
        )}

        {state.kind === 'not-found' && (
          <div
            role="alert"
            className="rounded-lg bg-white p-6 shadow text-center"
          >
            <h1 className="text-lg font-semibold text-gray-900">
              Booking not found
            </h1>
            <p className="mt-2 text-gray-600">
              We couldn&apos;t find a booking with that reference. Check the link
              in your confirmation email or contact support.
            </p>
          </div>
        )}

        {state.kind === 'error' && (
          <div
            role="alert"
            className="rounded-lg bg-white p-6 shadow text-center"
          >
            <h1 className="text-lg font-semibold text-gray-900">
              We couldn&apos;t verify your booking
            </h1>
            <p className="mt-2 text-gray-600">{state.message}</p>
            <p className="mt-2 text-gray-600">
              Your payment may still be processing. Refreshing this page is
              safe and will not charge you again.
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-4 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
            >
              Retry verification
            </button>
          </div>
        )}

        {state.kind === 'ready' && (
          <BookingConfirmationPage
            bookingId={state.data.bookingId}
            status={state.data.status}
            paymentStatus={state.data.paymentStatus}
            escrowStatus={state.data.escrowStatus}
            onRetry={handleRetry}
          />
        )}
      </div>
    </main>
  );
}