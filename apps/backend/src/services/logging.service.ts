import { AsyncLocalStorage } from 'node:async_hooks';
import { supabase } from '@/config/supabase.js';
import { structuredLog, redactLogPayload } from '@/middleware/logging.middleware.js';

// ─── Request correlation context ──────────────────────────────────────────────

/**
 * Per-request context propagated via AsyncLocalStorage so that any log call
 * made during a request's async call chain (controllers, services, blockchain
 * calls, Supabase queries) can be tagged with the same correlation id without
 * threading `req` through every function signature.
 */
export interface RequestLogContext {
  requestId: string;
  method?: string;
  path?: string;
  userId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestLogContext>();

/**
 * Run `callback` with `context` bound to the current async execution chain.
 * Called once per request by `requestIdMiddleware`.
 */
export function runWithRequestContext<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return requestContextStorage.run(context, callback);
}

/** Returns the correlation context for the in-flight request, if any. */
export function getRequestContext(): RequestLogContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Attach the authenticated user id to the current request context once auth
 * middleware resolves it, so subsequent log calls in the same request include it.
 */
export function setRequestContextUserId(userId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.userId = userId;
}

// ─── Blockchain operation logger ──────────────────────────────────────────────

export interface BlockchainOperationLog {
  operation: string;
  userId?: string;
  bookingId?: string;
  propertyId?: string;
  txHash?: string;
  escrowId?: string;
  error?: string;
  [key: string]: unknown;
}

class LoggingService {
  /**
   * Record a Stellar/Soroban blockchain operation.
   *
   * Persists to the blockchain_logs table (best-effort) and emits a
   * structured JSON log entry via structuredLog so the record is always
   * captured by the aggregation pipeline even when the DB write fails.
   *
   * Sensitive fields are redacted before emission.
   */
  async logBlockchainOperation(
    operation: string,
    input: Record<string, unknown>,
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    const context = getRequestContext();

    // Persist to Supabase (best-effort — never throws)
    try {
      const { error: dbError } = await supabase
        .from('blockchain_logs')
        .insert({
          operation,
          input_json: input,
          result_json: result ?? null,
          error_message: error ?? null,
        });

      if (dbError) {
        structuredLog({
          level: 'warn',
          message: `Failed to persist blockchain operation log: ${operation}`,
          timestamp: new Date().toISOString(),
          service: 'blockchain',
          dbError: dbError.message,
          requestId: context?.requestId,
        });
      }
    } catch (err) {
      structuredLog({
        level: 'warn',
        message: `Exception persisting blockchain operation log: ${operation}`,
        timestamp: new Date().toISOString(),
        service: 'blockchain',
        error: err instanceof Error ? err.message : String(err),
        requestId: context?.requestId,
      });
    }

    // Always emit a structured entry to stdout regardless of DB outcome.
    // redactLogPayload handles secret fields (private keys, tx signatures, etc.)
    const safeInput = redactLogPayload(input) as Record<string, unknown>;
    const safeResult = result ? (redactLogPayload(result) as Record<string, unknown>) : undefined;

    structuredLog({
      level: error ? 'error' : 'info',
      message: `blockchain:${operation}`,
      timestamp: new Date().toISOString(),
      service: 'blockchain',
      requestId: context?.requestId,
      userId: context?.userId,
      method: context?.method,
      path: context?.path,
      input: safeInput,
      ...(safeResult ? { result: safeResult } : {}),
      ...(error ? { error } : {}),
    });
  }
}

export const loggingService = new LoggingService();

// ─── Security event logger ────────────────────────────────────────────────────

type SecurityEvent =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'register_success'
  | 'token_revoked'
  | 'unauthorized_access'
  | 'rate_limit_exceeded';

class SecurityLogger {
  /**
   * Record an authentication / security event.
   *
   * Emits via structuredLog so entries have the same shape and redaction
   * guarantees as all other log lines. Persists to security_logs (best-effort).
   */
  async logAuthEvent(
    event: SecurityEvent,
    userId?: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const context = getRequestContext();

    const isFailure = event === 'login_failure' || event === 'unauthorized_access';

    structuredLog({
      level: isFailure ? 'warn' : 'info',
      message: `security:${event}`,
      timestamp: new Date().toISOString(),
      service: 'api',
      event,
      userId: userId ?? context?.userId,
      requestId: context?.requestId,
      method: context?.method,
      path: context?.path,
      // redactLogPayload is applied inside structuredLog so meta is safe
      ...(meta ? { meta } : {}),
    });

    // Persist to Supabase (best-effort — DB table may not exist yet in dev)
    try {
      await supabase.from('security_logs').insert({
        event,
        user_id: userId ?? null,
        meta_json: meta ?? null,
      });
    } catch {
      // Non-fatal: missing table or transient error must not break auth flows.
    }
  }
}

export const securityLogger = new SecurityLogger();
