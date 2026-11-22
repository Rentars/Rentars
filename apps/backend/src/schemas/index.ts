/**
 * Shared API schemas barrel export.
 *
 * Import from here to access all canonical request/response Zod schemas and
 * their inferred TypeScript types.  The contract tests, backend validators,
 * and the frontend runtime-parse helpers all import from this module.
 *
 * Usage (backend):
 *   import { BookingDetailSchema, AdvancedSearchResponseSchema } from '@/schemas/index.js';
 *
 * Usage (frontend web mirror at apps/web/src/lib/api-schemas/index.ts):
 *   import { BookingDetailSchema } from '@/lib/api-schemas';
 */

export * from './auth.schema.js';
export * from './booking.schema.js';
export * from './notification.schema.js';
export * from './payment.schema.js';
export * from './profile.schema.js';
export * from './property.schema.js';

/**
 * Parse a raw API response body with the given Zod schema.  Returns the typed
 * value on success.  On failure throws a `SchemaParseError` with a structured
 * diff — the caller decides whether to surface it to the user or fall back to
 * a safe default.
 *
 * This is the preferred approach at API response boundaries: validate once,
 * use typed data everywhere downstream, and reject malformed critical responses
 * before they propagate into the UI state.
 */
import { z, type ZodTypeAny, type ZodError } from 'zod';

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

/**
 * Parse `data` with `schema`, throwing `SchemaParseError` on failure.
 *
 * @param schema     - Any Zod schema.
 * @param data       - Raw unknown value (e.g. fetch response JSON).
 * @param schemaName - Human-readable name used in error messages.
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
 * schema fails.  Useful for non-critical response fields where degraded UI is
 * preferable to an error boundary.
 */
export function parseApiResponseSafe<T extends ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
