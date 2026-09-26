/**
 * Pagination validator middleware.
 *
 * Issue #663 — DB connection/query safeguards:
 *   • Hard maximum page size of MAX_PAGE_SIZE (100) enforced at the validator
 *     layer so no route handler can accidentally return an unbounded collection.
 *   • Requests that supply a page size above the cap receive a 400 with an
 *     explicit error — the cap is not silently applied so callers know their
 *     request was out-of-range.
 *   • Minimum page size of 1 enforced — page 0 or negative sizes are rejected.
 *   • Both `pageSize` and the legacy `limit` alias are accepted for
 *     backward compatibility; `pageSize` takes precedence.
 */

import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';

/** Absolute upper bound on page size. Never return more rows than this in one call. */
export const MAX_PAGE_SIZE = 100;

/** Default page size when the caller omits both pageSize and limit. */
export const DEFAULT_PAGE_SIZE = 20;

const paginationSchema = z.object({
  page: z
    .coerce
    .number()
    .int('page must be an integer')
    .positive('page must be a positive integer')
    .default(1),

  pageSize: z
    .coerce
    .number()
    .int('pageSize must be an integer')
    .positive('pageSize must be a positive integer')
    .max(MAX_PAGE_SIZE, `pageSize must not exceed ${MAX_PAGE_SIZE}`)
    .optional(),

  limit: z
    .coerce
    .number()
    .int('limit must be an integer')
    .positive('limit must be a positive integer')
    .max(MAX_PAGE_SIZE, `limit must not exceed ${MAX_PAGE_SIZE}`)
    .optional(),
});

export interface ParsedPagination {
  page: number;
  pageSize: number;
}

declare global {
  namespace Express {
    interface Request {
      parsedPagination?: ParsedPagination;
    }
  }
}

/**
 * Validate and normalise pagination query parameters.
 *
 * On success, attaches `req.parsedPagination` with normalised `page` and `pageSize`.
 * On failure, responds 400 immediately with a descriptive message listing every violation.
 *
 * Usage:
 *   router.get('/properties', validatePagination, listPropertiesHandler);
 */
export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const result = paginationSchema.safeParse(req.query);

  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    res.status(400).json({
      error: {
        code: 'INVALID_PAGINATION',
        message: `Invalid pagination parameters: ${messages}`,
        details: { maxPageSize: MAX_PAGE_SIZE, defaultPageSize: DEFAULT_PAGE_SIZE },
      },
    });
    return;
  }

  const rawSize = result.data.pageSize ?? result.data.limit ?? DEFAULT_PAGE_SIZE;

  // Double-safety cap — should never trigger given the schema .max() above,
  // but acts as a defensive backstop if the schema is ever loosened.
  const pageSize = Math.min(rawSize, MAX_PAGE_SIZE);

  req.parsedPagination = { page: result.data.page, pageSize };
  next();
}
