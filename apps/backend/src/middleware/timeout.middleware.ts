/**
 * Request timeout middleware
 *
 * Starts a per-request timer.  If the handler has not sent a response before
 * the deadline expires the middleware responds with HTTP 504 and a stable
 * machine-readable error code, then sets a flag on `res.locals` so that the
 * error middleware (and any late-arriving handler) knows not to write a second
 * response.
 *
 * Configuration (environment variables):
 *   REQUEST_TIMEOUT_MS        – default timeout for all routes (default: 30 000)
 *   REQUEST_TIMEOUT_UPLOAD_MS – timeout override for upload routes (default: 120 000)
 *
 * Abort signal:
 *   req.locals.signal (AbortSignal) is populated so that abortable upstream
 *   calls (Stellar RPC, geocoding HTTP, etc.) can be cancelled when the
 *   request times out.
 */

import type { Request, Response, NextFunction } from 'express';

// ─── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 30_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_UPLOAD_MS ?? 120_000);

/** Routes whose path starts with one of these prefixes get the upload timeout. */
const UPLOAD_PREFIXES = ['/api/v1/properties/images', '/api/v1/uploads'];

// ─── Helpers ───────────────────────────────────────────────────────────────

function isUploadRoute(path: string): boolean {
  return UPLOAD_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// ─── Middleware factory ────────────────────────────────────────────────────

/**
 * Returns the timeout middleware.
 * Accepts an optional `timeoutMs` override (useful in tests).
 */
export function createTimeoutMiddleware(timeoutMs?: number) {
  return function timeoutMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ms =
      timeoutMs ??
      (isUploadRoute(req.path) ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

    // ── AbortController so upstream callers can be cancelled ──────────────
    const controller = new AbortController();

    // Expose the signal on res.locals for downstream handlers / services
    // (also on req so it's accessible inside route handlers directly)
    res.locals.signal = controller.signal;
    try {
      Object.defineProperty(req, 'signal', {
        value: controller.signal,
        configurable: true,
        writable: true,
      });
    } catch {
      // Ignore if req.signal is non-configurable
    }

    // ── Timer ─────────────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      // Abort any in-flight upstream calls
      controller.abort();

      // Guard against double-send: if the response has already been flushed
      // (headersSent) we must not write again.
      if (res.headersSent) {
        return;
      }

      // Mark as timed-out so the error middleware skips further processing
      res.locals.timedOut = true;

      res.status(504).json({
        error: {
          code: 'REQUEST_TIMEOUT',
          message: 'The request timed out. Please try again.',
        },
      });
    }, ms);

    // ── Cleanup ───────────────────────────────────────────────────────────
    // Clear the timer once the response has finished so Node can exit cleanly.
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  };
}

/** Default export — middleware with env-driven timeout values. */
export const timeoutMiddleware = createTimeoutMiddleware();
