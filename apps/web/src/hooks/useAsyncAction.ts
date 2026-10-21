'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAsyncActionResult<TArgs extends unknown[], TResult> {
  /**
   * Run the mutation. While a previous invocation is still in flight the call
   * is a no-op (returns `undefined`) — this is a *synchronous* re-entry guard,
   * so even clicks that land before React re-renders a disabled button cannot
   * duplicate the action.
   */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  /** True while the action is in flight (drives button/aria-busy UI). */
  isPending: boolean;
  /** Human-readable message for the last failure, or null. */
  error: string | null;
  /** Clear the error and pending state (e.g. after the user dismisses). */
  reset: () => void;
}

interface UseAsyncActionOptions<TResult> {
  onSuccess?: (result: TResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * useAsyncAction — wraps a one-off mutation (POST/PATCH/wallet signature…) with
 * the guarantees every mutation surface in this app needs:
 *
 * - **No duplicate submissions** — a synchronous ref guard rejects re-entry
 *   while the promise is in flight, independent of button `disabled` state.
 * - **Pending state** for `aria-busy` / spinner / disabled affordances.
 * - **Captured error message** so callers can render an accessible error
 *   region (`role="alert"`) instead of `alert()` or silent console logging.
 *
 * ```tsx
 * const save = useAsyncAction(async (payload: Booking) => api.post(payload));
 * <button disabled={save.isPending} onClick={() => save.run(booking)}>
 *   {save.isPending ? 'Saving…' : 'Book now'}
 * </button>
 * {save.error && <ErrorState message={save.error} onRetry={() => save.run(booking)} />}
 * ```
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions<TResult> = {},
): UseAsyncActionResult<TArgs, TResult> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const isMountedRef = useRef(true);

  // Keep the latest callbacks in refs so `run` stays referentially stable and
  // callers can safely list it in dependency arrays.
  const actionRef = useRef(action);
  const optionsRef = useRef(options);
  actionRef.current = action;
  optionsRef.current = options;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (...args: TArgs) => {
    if (inFlightRef.current) return undefined;
    inFlightRef.current = true;

    if (isMountedRef.current) {
      setIsPending(true);
      setError(null);
    }

    try {
      const result = await actionRef.current(...args);
      if (isMountedRef.current) optionsRef.current.onSuccess?.(result);
      return result;
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      }
      optionsRef.current.onError?.(err);
      return undefined;
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setIsPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setIsPending(false);
  }, []);

  return { run, isPending, error, reset };
}
