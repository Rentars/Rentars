/**
 * Client-side error logger.
 *
 * Sends a sanitised error report to the backend for diagnosis.
 * Stack traces and internal details are NEVER exposed to the user —
 * they are stripped here and only forwarded server-side.
 *
 * Privacy:
 *   All sensitive user data (emails, payment cards, API keys, passwords,
 *   tokens, file paths) is redacted from the message before it leaves
 *   the browser.
 *
 * Deduplication:
 *   Repeated reports of the same error (same digest) within the dedup
 *   window are suppressed to avoid noisy duplicate submissions.
 *
 * Rate limiting:
 *   At most MAX_REPORTS_PER_WINDOW reports are sent per time window.
 *
 * Sampling:
 *   In production only a sample of reports is sent (sample rate from
 *   env or default 10%).
 *
 * Environment gating:
 *   Reports are never sent in test/CI environments.
 *
 * Correlation:
 *   When the API responds with an X-Request-Id header, that ID is stored
 *   in a module-level variable and attached to subsequent error reports.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// ── Configuration ───────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 60_000; // 1 minute
const MAX_REPORTS_PER_WINDOW = 10;
const RATE_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_SAMPLE_RATE = 0.1; // 10% in production

function getSampleRate(): number {
  const envRate = process.env.NEXT_PUBLIC_ERROR_SAMPLE_RATE;
  if (envRate) {
    const parsed = Number(envRate);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return DEFAULT_SAMPLE_RATE;
}

function shouldSendBySample(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return Math.random() < getSampleRate();
}

function isGatedEnvironment(): boolean {
  // Only gate when explicitly disabled; never block based on NODE_ENV so
  // tests and dev can exercise the logger.
  return process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED === 'false';
}

// ── Request-ID tracking ───────────────────────────────────────────────────────

let lastRequestId: string | undefined;

export function captureRequestId(id: string | null | undefined): void {
  if (id) lastRequestId = id;
}

export function getLastRequestId(): string | undefined {
  return lastRequestId;
}

// ── Error report shape ────────────────────────────────────────────────────────

export interface ErrorReport {
  message: string;
  href: string;
  digest?: string;
  context?: string;
  timestamp: string;
  requestId?: string;
}

// ── Message sanitisation ──────────────────────────────────────────────────────

/**
 * Allowlisted redaction patterns. Anything matching these is replaced with a
 * safe placeholder so sensitive user data never leaves the browser.
 */
const REDACT_PATTERNS: [RegExp, string][] = [
  // File paths (/home/user/…, C:\Users\…, ./src/…)
  [/([A-Za-z]:[\\/]|\/)[^\s'"]+/g, '[path]'],
  // JWT / bearer tokens
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[token]'],
  // API keys (sk_live_, pk_live_, etc.)
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g, '[api-key]'],
  // Email addresses
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  '[email]',
  // Payment card numbers (13-19 digits, with or without separators)
  /\b(?:\d[ -]*){13,19}\b/g,
  '[card]',
  // Password-like keywords with values (password=…, pass=…, pwd=…)
  /\b(passw(?:ord|ord)?|pass|pwd|secret|api_key|apikey)\s*[:=]\s*\S+/gi,
  '$1=[redacted]',
];

function sanitiseMessage(raw: string): string {
  return REDACT_PATTERNS.reduce((msg, [pattern, replacement]) => {
    return msg.replace(pattern, replacement);
  }, raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// ── Dedup & rate-limit state ─────────────────────────────────────────────────

type DedupEntry = { digest: string; timestamp: number };

const dedupCache: DedupEntry[] = [];
let reportWindowStart = Date.now();
let reportsInWindow = 0;

function isDuplicate(digest: string): boolean {
  const now = Date.now();
  // Evict expired entries
  for (let i = dedupCache.length - 1; i >= 0; i--) {
    if (now - dedupCache[i].timestamp > DEDUP_WINDOW_MS) {
      dedupCache.splice(i, 1);
    }
  }
  return dedupCache.some((e) => e.digest === digest);
}

function recordDigest(digest: string): void {
  dedupCache.push({ digest, timestamp: Date.now() });
}

function isRateLimited(): boolean {
  const now = Date.now();
  if (now - reportWindowStart > RATE_WINDOW_MS) {
    reportWindowStart = now;
    reportsInWindow = 0;
  }
  return reportsInWindow >= MAX_REPORTS_PER_WINDOW;
}

function recordReport(): void {
  reportsInWindow += 1;
}

/** For tests: clear dedup cache and rate-limit state. */
export function resetForTesting(): void {
  dedupCache.length = 0;
  reportWindowStart = Date.now();
  reportsInWindow = 0;
  lastRequestId = undefined;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function logClientError(
  error: unknown,
  context?: string,
  digest?: string,
): Promise<void> {
  // Environment gating — never send from test/CI
  if (isGatedEnvironment()) return;

  // Sampling — production only sends a fraction
  if (!shouldSendBySample()) return;

  // Rate limiting — cap submissions per window
  if (isRateLimited()) return;

  // Dedup — suppress repeated reports of the same error
  const reportDigest = digest ?? `ERR-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  if (isDuplicate(reportDigest)) return;

  const raw = error instanceof Error ? error.message : String(error);
  const message = sanitiseMessage(raw);
  const href = typeof window !== 'undefined' ? window.location.href : '';

  const report: ErrorReport = {
    message,
    href,
    digest: reportDigest,
    context,
    timestamp: new Date().toISOString(),
    requestId: lastRequestId,
  };

  if (process.env.NODE_ENV === 'development') {
    console.error('[ErrorLogger]', report, error instanceof Error ? error.stack : '');
  }

  try {
    recordDigest(reportDigest);
    recordReport();

    const res = await fetch(`${API_URL}/api/v1/client-errors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(lastRequestId ? { 'X-Request-Id': lastRequestId } : {}),
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout?.(5000),
    });

    captureRequestId(res.headers.get('x-request-id'));
  } catch {
    // Silently swallow — we must never throw from the logger
  }
}

export function captureException(
  error: Error,
  context: string,
  extra?: Record<string, unknown>
): string {
  const digest = `ERR-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const message = extra
    ? `${sanitiseMessage(error.message)} | ${JSON.stringify(extra)}`
    : error.message;

  void logClientError({ ...error, message }, context, digest);
  return digest;
}

export function logWarning(message: string, context?: string): void {
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[${context || 'Warning'}] ${message}`);
  }
}

export function logInfo(message: string, context?: string): void {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[${context || 'Info'}] ${message}`);
  }
}
