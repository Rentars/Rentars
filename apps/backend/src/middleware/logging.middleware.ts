import { randomUUID } from 'node:crypto';
import { type Request, type Response, type NextFunction } from 'express';
import { env } from '../config/env.js';
import { getRequestContext, runWithRequestContext } from '../services/logging.service.js';

// ── Log levels ────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const raw = (env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVEL_PRIORITY) return raw as LogLevel;
  return 'info';
}

// ── Redaction ─────────────────────────────────────────────────────────────────

/**
 * Regex matching keys that must never appear in logs in plain form.
 * Covers: tokens, secrets, passwords, seeds, private keys, PII identifiers.
 */
const SENSITIVE_KEY_RE =
  /token|secret|password|seed|private_?key|pin|cvv|ssn|card_?num|signature|api_?key|auth|bearer/i;

/**
 * Regex matching values that look like secrets regardless of key name:
 * JWTs, Stellar secret keys (S…), long hex strings.
 */
const SENSITIVE_VALUE_RE =
  /^(eyJ[A-Za-z0-9_-]{20,}\.eyJ|S[A-Z2-7]{55}$|[0-9a-f]{40,}$)/;

/**
 * Recursively redact sensitive fields from an arbitrary log payload.
 * Mutates nothing — returns a new object.
 *
 * Limits recursion depth to 8 to prevent pathological inputs from
 * stacking the call stack on deeply nested objects.
 */
export function redactLogPayload(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]';

  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactLogPayload(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else if (typeof v === 'string' && SENSITIVE_VALUE_RE.test(v)) {
        out[k] = '[REDACTED]';
      } else if (typeof v === 'string' && v.length > 1024) {
        out[k] = v.slice(0, 1024) + '…[TRUNCATED]';
      } else {
        out[k] = redactLogPayload(v, depth + 1);
      }
    }
    return out;
  }

  if (typeof value === 'string' && SENSITIVE_VALUE_RE.test(value)) {
    return '[REDACTED]';
  }

  return value;
}

// ── Structured logger ─────────────────────────────────────────────────────────

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  /** Correlation ID carried through the full async chain of one request. */
  requestId?: string;
  userId?: string;
  /**
   * Logical service name: "api", "worker", "scheduler", "blockchain", etc.
   * Defaults to "api" when not specified.
   */
  service?: string;
  /** Deployment environment propagated from NODE_ENV. */
  environment?: string;
  /** Semver of the running binary, from DEPLOYMENT_VERSION. */
  version?: string;
  [key: string]: unknown;
}

/** Shape every log entry must satisfy for downstream aggregation. */
export interface NormalisedLogEntry extends LogEntry {
  service: string;
  environment: string;
  timestamp: string;
}

// Package-level constants computed once at startup.
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'api';
const DEPLOYMENT_VERSION = env.DEPLOYMENT_VERSION ?? 'unknown';
const NODE_ENV = env.NODE_ENV;

/**
 * Emit a structured JSON log line.
 *
 * - In development: pretty-printed for human readability.
 * - In production: single-line JSON for aggregation pipelines (Loki, CloudWatch, Datadog).
 *
 * Every emitted entry is guaranteed to contain:
 *   timestamp, level, message, service, environment, requestId (when in a request context).
 *
 * Sensitive fields are redacted before serialisation so secrets/PII
 * can never leak through log pipelines regardless of call-site discipline.
 */
export function structuredLog(entry: LogEntry): void {
  const configuredLevel = getConfiguredLevel();
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[configuredLevel]) return;

  // Fall back to the AsyncLocalStorage-backed request context for any field
  // the caller didn't set explicitly, so log calls made deep inside services
  // (with no direct access to `req`) still carry the correlation id.
  const context = getRequestContext();

  const base: NormalisedLogEntry = {
    ...entry,
    service: entry.service ?? SERVICE_NAME,
    environment: entry.environment ?? NODE_ENV,
    version: entry.version ?? DEPLOYMENT_VERSION,
    requestId: entry.requestId ?? context?.requestId,
    userId: entry.userId ?? context?.userId,
    // Ensure timestamp is always present and valid ISO-8601
    timestamp: entry.timestamp ?? new Date().toISOString(),
  };

  // Deep-redact the whole payload — protects against accidental secret leakage
  // from any field, including nested objects passed as extra context.
  const safe = redactLogPayload(base) as NormalisedLogEntry;

  const line =
    NODE_ENV === 'development'
      ? JSON.stringify(safe, null, 2)
      : JSON.stringify(safe);

  if (safe.level === 'error') {
    console.error(line);
  } else if (safe.level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ── Request-ID injection ──────────────────────────────────────────────────────

/**
 * Attach a unique request-ID to every incoming request so that all log
 * entries emitted during that request can be correlated in a dashboard.
 *
 * The ID is read from the `X-Request-Id` header if the upstream proxy
 * already set one; otherwise a fresh UUID v4 is generated.
 * The final ID is echoed back to the caller in `X-Request-Id`.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && incomingId.length > 0
      ? incomingId
      : randomUUID();

  // Attach to the request object for downstream middleware and controllers
  (req as RequestWithId).requestId = requestId;

  // Echo back so the client can correlate responses
  res.setHeader('X-Request-Id', requestId);

  // Bind the correlation id (and method/path) to the async context for the
  // rest of the request lifecycle, so any log call made further down the
  // stack — controllers, services, blockchain/Supabase calls — can pick it
  // up via `getRequestContext()` without `req` being passed around.
  runWithRequestContext({ requestId, method: req.method, path: req.path }, next);
}

// ── Typed request extension ───────────────────────────────────────────────────

export interface RequestWithId extends Request {
  requestId?: string;
  userId?: string;
}

// ── HTTP request logging middleware ──────────────────────────────────────────

/**
 * Structured HTTP request/response logger.
 *
 * Emits a single structured log entry per request on response finish, containing:
 *   - ISO timestamp
 *   - Request-ID for correlation
 *   - HTTP method, normalised path, status code, duration
 *   - Authenticated user-ID (if present on req.userId)
 *   - service, environment, version fields for aggregation routing
 *
 * Paths matching SKIP_PATHS are not logged (e.g. /health, /metrics).
 */
const SKIP_PATHS = new Set(['/health', '/metrics', '/favicon.ico']);

export function requestLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const startMs = Date.now();
  const typedReq = req as RequestWithId;

  res.on('finish', () => {
    const duration = Date.now() - startMs;
    const level: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    structuredLog({
      level,
      message: `${req.method} ${req.path} ${res.statusCode}`,
      timestamp: new Date().toISOString(),
      service: 'api',
      requestId: typedReq.requestId,
      userId: typedReq.userId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      // User-Agent and IP are safe operational metadata, not PII in this context.
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  });

  next();
}
