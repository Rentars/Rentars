/**
 * Frontend API schema barrel.
 *
 * Import canonical Zod schemas and their inferred TypeScript types from here
 * instead of from ad-hoc type files. The runtime parse helpers guard every
 * critical API response boundary so malformed data is caught before it enters
 * React state.
 *
 * Usage:
 *   import { BookingDetailSchema, parseApiResponse } from '@/lib/api-schemas';
 *   const booking = parseApiResponse(BookingDetailSchema, json, 'BookingDetail');
 */

export * from './auth.schema';
export * from './booking.schema';
export * from './notification.schema';
export * from './payment.schema';
export * from './profile.schema';
export * from './property.schema';

import { z, type ZodTypeAny, type ZodError } from 'zod';

// ── Schema parse error ────────────────────────────────────────────────────────

/**
 * Thrown by `parseApiResponse` when a response body fails Zod validation.
 * The `issues` array mirrors `ZodError.issues` for structured downstream
 * handling; `raw` holds the original untyped value for logging.
 */
export class SchemaParseError extends Error {
  public readonly issues: ZodError['issues'];
  public readonly raw: unknown;

  constructor(schemaName: string, issues: ZodError['issues'], raw: unknown) {
    super(
      `[SchemaParseError] ${schemaName} — ${issues.length} issue(s):\n` +
        issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
    this.name = 'SchemaParseError';
    this.issues = issues;
    this.raw = raw;
  }
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

/**
 * Parse `data` with `schema`, throwing `SchemaParseError` on failure.
 *
 * Use this at the fetch-response boundary for critical workflows (booking
 * creation, payment status, auth tokens).  An error boundary or error state
 * in the calling component should catch it and display a recoverable error
 * rather than crashing the whole page.
 */
export function parseApiResponse<T extends ZodTypeAny>(
  schema: T,
  data: unknown,
  schemaName: string,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SchemaParseError(schemaName, result.error.issues, data);
  }
  return result.data;
}

/**
 * Like `parseApiResponse` but returns `null` instead of throwing when the
 * schema fails.  Suitable for non-critical display data (e.g. price histogram)
 * where the UI can degrade gracefully.
 */
export function parseApiResponseSafe<T extends ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Assert that `data` satisfies `schema` and return the typed result.
 * Logs a console.warn on failure (never throws) so stale schemas do not break
 * production pages — but the warning will surface in monitoring.
 */
export function parseApiResponseWarn<T extends ZodTypeAny>(
  schema: T,
  data: unknown,
  schemaName: string,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    console.warn(`[api-schema] ${schemaName} parse warning: ${issues}`);
    return null;
  }
  return result.data;
}
