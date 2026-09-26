/**
 * Supabase client configuration.
 *
 * Issue #663 — DB connection/query safeguards:
 *   • Global fetch timeout (DB_QUERY_TIMEOUT_MS) prevents runaway queries
 *     from holding connections indefinitely and starving the pool.
 *   • Timeout is injected via a custom fetch wrapper so every Supabase
 *     HTTP call — selects, inserts, RPC — inherits it automatically.
 *   • The service-role client is used exclusively on the backend;
 *     it bypasses RLS so all row-level decisions are delegated to
 *     explicit application-layer checks and the RLS policies themselves.
 *
 * Connection budget note:
 *   Supabase JS v2 uses HTTP/REST (PostgREST) — there is no persistent
 *   pg connection pool to configure here.  Pool limits and statement
 *   timeouts must be set in PgBouncer / Supabase project settings.
 *   The timeout wrapper below is the application-side safety net.
 */

import { createClient } from '@supabase/supabase-js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/**
 * Per-query HTTP timeout in ms.
 * Override with DB_QUERY_TIMEOUT_MS env var.
 * Default: 25 000 ms (25 s) — generous enough for large paginated reads,
 * tight enough to surface runaway queries before the HTTP gateway (30 s) kills them.
 */
export const DB_QUERY_TIMEOUT_MS: number = (() => {
  const raw = process.env.DB_QUERY_TIMEOUT_MS;
  if (!raw) return 25_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    structuredLog({
      level: 'warn',
      message: 'DB_QUERY_TIMEOUT_MS is invalid — falling back to 25000 ms',
      timestamp: new Date().toISOString(),
      service: 'db',
      value: raw,
    });
    return 25_000;
  }
  return n;
})();

/**
 * Slow-query threshold in ms. Queries exceeding this are logged at WARN
 * so they appear in the aggregation pipeline with a remediation owner.
 * Override with DB_SLOW_QUERY_THRESHOLD_MS env var. Default: 2 000 ms.
 */
export const DB_SLOW_QUERY_THRESHOLD_MS: number = (() => {
  const raw = process.env.DB_SLOW_QUERY_THRESHOLD_MS;
  if (!raw) return 2_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 2_000;
})();

// ── Timeout-aware fetch wrapper ───────────────────────────────────────────────

/**
 * Custom fetch that aborts after DB_QUERY_TIMEOUT_MS.
 *
 * When the timeout fires the pending request is aborted via AbortController,
 * which causes the Supabase client to surface an error to the caller
 * (rather than leaving the connection open indefinitely).
 */
function timeoutFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_QUERY_TIMEOUT_MS);

  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ── Client ────────────────────────────────────────────────────────────────────

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: {
    fetch: timeoutFetch,
  },
  auth: {
    // Disable auto-refresh on the server — tokens are managed per-request.
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});
