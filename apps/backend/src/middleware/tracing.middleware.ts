/**
 * Distributed tracing HTTP middleware.
 *
 * Extracts W3C trace context from incoming requests, creates a server-span
 * for the full HTTP request lifecycle, and injects trace context into outgoing
 * response headers so downstream services can continue the same trace.
 *
 * The span is ended on `res.finish` with the final HTTP status code attached.
 * All child spans created during the request (DB calls, RPC calls, cache ops)
 * inherit the trace context via AsyncLocalStorage in src/config/tracing.ts.
 */

import { type Request, type Response, type NextFunction } from 'express';
import {
  extractTraceContext,
  injectTraceContext,
  runWithTraceContext,
  startSpan,
  endSpan,
  SpanKind,
  type TraceContext,
  type Span,
} from '@/config/tracing.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TracedRequest extends Request {
  traceContext?: TraceContext;
  traceSpan?: Span;
}

// ── Paths that don't need a trace span ───────────────────────────────────────

const SKIP_PATHS = new Set(['/health', '/metrics', '/favicon.ico', '/api/v1/client-errors']);

// ── Middleware ────────────────────────────────────────────────────────────────

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  // ── 1. Extract or create trace context ────────────────────────────────────

  const incomingHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    incomingHeaders[key] = value;
  }

  const parentContext = extractTraceContext(incomingHeaders);

  const context: TraceContext = parentContext ?? {
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    sampled: Math.random() < 0.1,
  };

  // ── 2. Open a server span ─────────────────────────────────────────────────

  const span = startSpan(`${req.method} ${req.path}`, SpanKind.SERVER, {
    'http.method': req.method,
    'http.route': req.path,
    'http.target': req.url,
    'http.scheme': req.protocol,
    'http.host': req.get('host') ?? '',
    'http.user_agent': req.get('user-agent') ?? '',
    'net.host.port': req.socket.localPort ?? 0,
    'net.peer.ip': req.ip ?? '',
  });

  (req as TracedRequest).traceContext = context;
  (req as TracedRequest).traceSpan = span;

  // ── 3. Propagate trace context into the response headers ──────────────────
  //
  // Cast through `unknown` because Express types res.getHeaders() as
  // Record<string, number | string | readonly string[]> which is wider than
  // what injectTraceContext accepts; the values we write are always strings.

  injectTraceContext(context, res.getHeaders() as Record<string, string>);

  // ── 4. Run the rest of the request inside the trace context ───────────────

  runWithTraceContext(context, () => {
    res.on('finish', () => {
      if (span) {
        span.attributes['http.status_code'] = res.statusCode;

        if (res.statusCode >= 500) {
          endSpan(span, { code: 'error', message: `HTTP ${res.statusCode}` });
        } else {
          endSpan(span);
        }
      }
    });

    next();
  });
}

// ── Request-scoped trace context accessors ────────────────────────────────────

/** Returns the trace context attached to this request, if any. */
export function getRequestTraceContext(req: Request): TraceContext | undefined {
  return (req as TracedRequest).traceContext;
}

/** Returns just the traceId for quick log correlation. */
export function getRequestTraceId(req: Request): string | undefined {
  return (req as TracedRequest).traceContext?.traceId;
}
