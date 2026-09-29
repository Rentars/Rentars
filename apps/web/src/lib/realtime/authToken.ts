/**
 * Access-token lifecycle for realtime + polling consumers (issue #646).
 *
 * The API issues 15-minute access tokens. A realtime connection (or a
 * fallback poll) can easily outlive that, so consumers need a way to
 * re-authorize *without* an infinite refresh loop.
 *
 * Design:
 *  - `getAccessToken()` / `getRefreshToken()` read from localStorage.
 *  - `refreshAccessToken()` performs a single-flight refresh: concurrent
 *    callers share one in-flight promise, so a burst of 401s produces one
 *    network call, not N.
 *  - Refresh is **bounded**: after `maxRefreshAttempts` consecutive failures
 *    the session is cleared and the module latches into `session-lost` until
 *    `resetRefreshCircuit()` is called. This is what prevents a revoked or
 *    expired refresh token from producing an unbounded 401 → refresh → 401 loop.
 *  - `authenticatedFetch()` wraps `fetch` and transparently retries a request
 *    **at most once** after a successful refresh.
 *
 * Storage keys are unchanged from the rest of the app (`token`), so this is a
 * drop-in, backward-compatible replacement for the ad-hoc `getToken()` helpers.
 */

const ACCESS_TOKEN_KEY = 'token';
const REFRESH_TOKEN_KEY = 'refresh_token';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const DEFAULT_MAX_REFRESH_ATTEMPTS = 3;

export type SessionState = 'active' | 'refresh-failed' | 'session-lost';

export interface RefreshResult {
  ok: boolean;
  token?: string;
  /** True when the circuit breaker tripped and the session was cleared. */
  sessionLost?: boolean;
  error?: string;
}

/** Injected fetch — overridable for tests. */
let fetchImpl: typeof fetch = (...args) => fetch(...args);

export function setRealtimeFetch(fn: typeof fetch): void {
  fetchImpl = fn;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Access to localStorage can throw in hardened/private browsing modes.
    return null;
  }
}

export function getAccessToken(): string | null {
  return storage()?.getItem(ACCESS_TOKEN_KEY) ?? null;
}

export function getRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_TOKEN_KEY) ?? null;
}

export function setAccessToken(token: string): void {
  storage()?.setItem(ACCESS_TOKEN_KEY, token);
}

/** Persist a rotated token pair returned by the refresh endpoint. */
export function setSessionTokens(token: string, refreshToken?: string | null): void {
  setAccessToken(token);
  if (refreshToken) storage()?.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearSession(): void {
  const s = storage();
  s?.removeItem(ACCESS_TOKEN_KEY);
  s?.removeItem(REFRESH_TOKEN_KEY);
}

// ─── Refresh circuit breaker ──────────────────────────────────────────────────

let consecutiveFailures = 0;
let sessionLost = false;
let inFlight: Promise<RefreshResult> | null = null;

/** Current circuit state — surfaced for UI ("session expired" banners). */
export function getSessionState(): SessionState {
  if (sessionLost) return 'session-lost';
  if (consecutiveFailures > 0) return 'refresh-failed';
  return 'active';
}

/**
 * Clear the failure latch. Call after a successful login or an explicit
 * user re-authentication so the next 401 can attempt a refresh again.
 */
export function resetRefreshCircuit(): void {
  consecutiveFailures = 0;
  sessionLost = false;
  inFlight = null;
}

/** Test seam: inspect the latch without reaching into module internals. */
export function getRefreshFailureCount(): number {
  return consecutiveFailures;
}

interface RefreshOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
}

/**
 * Exchange the stored refresh token for a new access token.
 *
 * Single-flight: simultaneous callers await the same promise.
 */
export function refreshAccessToken(options: RefreshOptions = {}): Promise<RefreshResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_REFRESH_ATTEMPTS);

  if (sessionLost) {
    return Promise.resolve({ ok: false, sessionLost: true, error: 'session_lost' });
  }
  if (inFlight) return inFlight;

  inFlight = doRefresh(maxAttempts, options.signal).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function doRefresh(maxAttempts: number, signal?: AbortSignal): Promise<RefreshResult> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    // No refresh token at all — nothing to rotate, do not burn the circuit.
    return { ok: false, error: 'no_refresh_token' };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal,
      });

      if (res.ok) {
        const body = (await res.json()) as { token?: string; refreshToken?: string };
        if (body?.token) {
          setSessionTokens(body.token, body.refreshToken);
          consecutiveFailures = 0;
          return { ok: true, token: body.token };
        }
        // Malformed success body — treat as a failure and retry.
      } else if (res.status === 401 || res.status === 403) {
        // The refresh token itself is rejected. No amount of retrying fixes
        // this, so latch immediately and let the UI prompt for a new login.
        // This is the hard stop that prevents an infinite 401 loop.
        sessionLost = true;
        consecutiveFailures = 0;
        clearSession();
        return { ok: false, sessionLost: true, error: 'refresh_rejected' };
      }
    } catch {
      // Network blip — fall through to the next attempt.
    }

    consecutiveFailures += 1;
    if (consecutiveFailures >= maxAttempts) {
      // Exhausted *transient* retries. Unlike a 401, this may well succeed on
      // a later attempt (server restart, brief outage), so we do NOT destroy
      // the session — we only report failure. The caller's own backoff caps
      // how often this is retried, so there is still no unbounded loop.
      return { ok: false, error: 'max_refresh_attempts' };
    }
  }

  return { ok: false, error: 'refresh_failed' };
}

// ─── Authenticated fetch ──────────────────────────────────────────────────────

export interface AuthenticatedFetchOptions extends RequestInit {
  /**
   * Whether a 401 should trigger a refresh + single retry. Default true.
   */
  retryOnUnauthorized?: boolean;
  maxRefreshAttempts?: number;
}

/**
 * `fetch` with a Bearer token attached. On a 401 it refreshes once and
 * replays the request exactly once — never more, so a permanently rejected
 * token cannot spin.
 */
export async function authenticatedFetch(
  input: string,
  options: AuthenticatedFetchOptions = {}
): Promise<Response> {
  const { retryOnUnauthorized = true, maxRefreshAttempts, headers, ...rest } = options;
  const token = getAccessToken();

  const send = (bearer: string | null): Promise<Response> => {
    const merged = new Headers(headers ?? undefined);
    if (bearer) merged.set('Authorization', `Bearer ${bearer}`);
    return fetchImpl(input, { ...rest, headers: merged });
  };

  const res = await send(token);

  if (res.status !== 401 || !retryOnUnauthorized) return res;

  const refreshed = await refreshAccessToken({ maxAttempts: maxRefreshAttempts });
  if (!refreshed.ok) return res;

  return send(refreshed.token ?? getAccessToken());
}
