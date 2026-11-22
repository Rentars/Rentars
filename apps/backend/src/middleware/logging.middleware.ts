import { randomUUID } from 'node:crypto';
import { type Request, type Response, type NextFunction } from 'express';
import { env } from '../config/env.js';
import { getRequestContext, runWithRequestContext } from '../services/logging.service.js';
import { getTraceContext } from '../config/tracing.js';

// ── Log levels ────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  if (raw in LEVEL_PRIORITY) return raw as LogLevel;
  return 'info';
}

// ── Structured logger ─────────────────────────────────────────────────────────

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  service?: string;
  environment?: string;
  requestId?: string;
  userId?: string;
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

/**
 * Emit a structured JSON log line.
 *
 * Fields are merged in this order (later values win):
 *   1. The caller-supplied `entry`
 *   2. `requestId` / `userId` from the per-request AsyncLocalStorage context
 *      (so deep service calls don't need to thread `req` everywhere)
 *   3. `traceId` / `spanId` from the W3C trace context AsyncLocalStorage
 *      (set by `tracingMiddleware` and propagated to workers via
 *      `runWithWorkerContext`)
 *   4. `service` and `environment` defaults if the caller didn't set them
 *
 * In development the line is pretty-printed; in production it is a single-line
 * JSON object suitable for Loki / CloudWatch / any structured log pipeline.
 *
 * The log is suppressed when its level falls below the configured LOG_LEVEL.
 */
export function structuredLog(entry: LogEntry): void {
  const configuredLevel = getConfiguredLevel();
  if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[configuredLevel]) return;

  // Pull per-request correlation fields from AsyncLocalStorage so callers
  // deep inside services don't need direct access to `req`.
  const reqCtx = getRequestContext();

  // Pull trace context so every log line is linkable to a distributed trace.
  const traceCtx = getTraceContext();

  const merged: LogEntry = {
    service: 'rentars-api',
    environment: env.NODE_ENV,
    ...entry,
    // Request correlation — only override caller if they left it unset
    requestId: entry.requestId ?? reqCtx?.requestId,
    userId: entry.userId ?? reqCtx?.userId,
    // Trace correlation — fold in traceId/spanId when the trace context exists
    traceId: entry.traceId ?? traceCtx?.traceId,
    spanId: entry.spanId ?? traceCtx?.spanId,
  };

  // Drop undefined fields so the JSON payload stays clean.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }

  const line =
    env.NODE_ENV === 'development'
      ? JSON.stringify(merged, null, 2)
      : JSON.stringify(merged);

  if (merged.level === 'error') {
    console.error(line);
  } else if (merged.level === 'warn') {
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
 * The ID is read from the `X-Request-Id` header if the upstream proxy already
 * set one; otherwise a fresh UUID v4 is generated.  The final ID is echoed
 * back to the caller in `X-Request-Id`.
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

  (req as RequestWithId).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Bind the correlation id (and method/path) to the async context for the
  // rest of the request lifecycle so any log call made in controllers, services,
  // blockchain/Supabase calls can pick it up via `getRequestContext()`.
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
 * Emits one structured log entry per request on response finish containing:
 *   - ISO timestamp
 *   - service + environment
 *   - requestId for HTTP-level correlation
 *   - traceId + spanId for distributed-trace linkage
 *   - HTTP method, normalised path, status code, duration
 *   - Authenticated user-ID (if present on req.userId)
 *   - outcome: 'success' | 'client_error' | 'server_error'
 *
 * Paths in SKIP_PATHS are not logged (health, metrics, favicon).
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
    const durationMs = Date.now() - startMs;
    const level: LogLevel =
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    const outcome =
      res.statusCode >= 500
        ? 'server_error'
        : res.statusCode >= 400
          ? 'client_error'
          : 'success';

    structuredLog({
      level,
      message: `${req.method} ${req.path} ${res.statusCode}`,
      timestamp: new Date().toISOString(),
      requestId: typedReq.requestId,
      userId: typedReq.userId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      outcome,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  });

  next();
}
