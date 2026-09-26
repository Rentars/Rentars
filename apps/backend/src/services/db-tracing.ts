/**
 * Database instrumentation for distributed tracing.
 *
 * Issue #663 — DB connection/query safeguards:
 *   • Every query is timed; slow queries (> DB_SLOW_QUERY_THRESHOLD_MS) emit
 *     a structured WARN so they surface in aggregation dashboards with enough
 *     context to identify an owner and remediation path.
 *   • Query duration is recorded both as a span attribute and in the
 *     structured log entry, giving two independent capture paths.
 *   • AbortError from the timeout-fetch in config/supabase.ts is caught and
 *     re-surfaced as a clear "query timed out" error rather than a generic
 *     network error.
 *   • Row counts on SELECT results are recorded so unbounded collection
 *     returns are visible in traces.
 */

import { supabase } from '@/config/supabase.js';
import { DB_SLOW_QUERY_THRESHOLD_MS } from '@/config/supabase.js';
import {
  startSpan,
  endSpan,
  addSpanAttribute,
  addSpanEvent,
  recordSpanError,
  SpanKind,
} from '@/config/tracing.js';
import { structuredLog } from '@/middleware/logging.middleware.js';
import { getRequestContext } from '@/services/logging.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueryOptions {
  table?: string;
  operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | 'rpc';
  query?: string;
  params?: unknown;
}

// ── Core traced-query wrapper ─────────────────────────────────────────────────

/**
 * Execute a Supabase query inside a trace span.
 *
 * Beyond tracing, this wrapper:
 *   1. Records wall-clock duration on every query.
 *   2. Emits a structured WARN when duration exceeds DB_SLOW_QUERY_THRESHOLD_MS.
 *   3. Translates AbortError (fetch timeout) into a descriptive error.
 *   4. Records row count so unbounded results are visible in traces.
 */
export async function tracedQuery<T>(
  operation: QueryOptions['operation'],
  table: string,
  fn: () => Promise<{ data: T | null; error: Error | null }>,
  options: Partial<QueryOptions> = {},
): Promise<{ data: T | null; error: Error | null }> {
  const context = getRequestContext();
  const startMs = Date.now();

  const span = startSpan(`db.${operation}`, SpanKind.CLIENT, {
    'db.system': 'postgresql',
    'db.operation': operation,
    'db.table': table,
    'db.statement': options.query ?? '',
  });

  addSpanEvent('db.query.start', { table, operation });

  try {
    const result = await fn();

    const durationMs = Date.now() - startMs;
    addSpanAttribute('db.duration_ms', durationMs);

    // ── Slow-query detection ───────────────────────────────────────────────
    if (durationMs >= DB_SLOW_QUERY_THRESHOLD_MS) {
      structuredLog({
        level: 'warn',
        message: `Slow DB query detected: ${operation} on ${table}`,
        timestamp: new Date().toISOString(),
        service: 'db',
        dbOperation: operation,
        dbTable: table,
        durationMs,
        slowQueryThresholdMs: DB_SLOW_QUERY_THRESHOLD_MS,
        requestId: context?.requestId,
        userId: context?.userId,
        // Safe identifier for dashboard triage — no raw SQL values
        queryId: `${table}:${operation}`,
      });
    }

    if (result.error) {
      span.attributes['db.error'] = result.error.message;
      span.status = { code: 'error', message: result.error.message };
      addSpanEvent('db.query.error', { error: result.error.message, durationMs });
    } else {
      const rowCount = Array.isArray(result.data) ? result.data.length : (result.data !== null ? 1 : 0);
      addSpanEvent('db.query.end', { rowCount, durationMs });
      addSpanAttribute('db.row_count', rowCount);

      // Instrument unbounded collection returns at debug level so they're
      // visible without flooding the aggregation pipeline.
      if (rowCount > 500 && operation === 'select') {
        structuredLog({
          level: 'warn',
          message: `Large result set returned: ${rowCount} rows from ${table}`,
          timestamp: new Date().toISOString(),
          service: 'db',
          dbTable: table,
          rowCount,
          requestId: context?.requestId,
          userId: context?.userId,
        });
      }
    }

    endSpan(span);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startMs;

    // Translate AbortError (timeout-fetch fired) into a clear message
    const isTimeout =
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'));

    const wrappedErr = isTimeout
      ? new Error(`DB query timed out after ${durationMs} ms (${operation} on ${table})`)
      : (err instanceof Error ? err : new Error(String(err)));

    structuredLog({
      level: 'error',
      message: isTimeout
        ? `DB query timeout: ${operation} on ${table}`
        : `DB query exception: ${operation} on ${table}`,
      timestamp: new Date().toISOString(),
      service: 'db',
      dbOperation: operation,
      dbTable: table,
      durationMs,
      error: wrappedErr.message,
      requestId: context?.requestId,
      userId: context?.userId,
    });

    recordSpanError(wrappedErr);
    endSpan(span, { code: 'error', message: wrappedErr.message });
    throw wrappedErr;
  }
}

// ── Convenience facade ────────────────────────────────────────────────────────

export const tracedSupabase = {
  from: (table: string) => {
    const builder = supabase.from(table);

    const wrapMethod = (method: string) => {
      const original = (builder as any)[method].bind(builder);
      return async (...args: unknown[]) => {
        return tracedQuery(
          method as QueryOptions['operation'],
          table,
          () => original(...args),
          { table, operation: method as QueryOptions['operation'] },
        );
      };
    };

    return {
      ...builder,
      select: wrapMethod('select'),
      insert: wrapMethod('insert'),
      update: wrapMethod('update'),
      delete: wrapMethod('delete'),
      upsert: wrapMethod('upsert'),
    };
  },

  rpc: async (fnName: string, params?: unknown) => {
    return tracedQuery(
      'rpc',
      fnName,
      () => supabase.rpc(fnName, params as any),
      { table: fnName, operation: 'rpc', query: `rpc:${fnName}` },
    );
  },
};

export function addDbAttributes(attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    addSpanAttribute(`db.${key}`, value);
  }
}
