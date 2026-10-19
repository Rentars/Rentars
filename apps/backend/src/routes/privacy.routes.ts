/**
 * Privacy routes — data subject rights endpoints.
 *
 * POST /api/v1/privacy/export                        — request an async export (202)
 * GET  /api/v1/privacy/export/:exportId              — poll status; payload when completed
 * POST /api/v1/privacy/delete-account                — request deletion (password + confirmation)
 * GET  /api/v1/privacy/delete-account/:deletionId    — deletion status
 * POST /api/v1/privacy/delete-account/:deletionId/cancel — cancel within the 7-day window
 *
 * All endpoints are authenticated and rate-limited.
 */

import { type AuthRequest, authenticate } from '@/middleware/auth.middleware.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';
import {
  DeletionBlockedError,
  cancelAccountDeletion,
  getDataExportStatus,
  getDeletionRequest,
  processDataExport,
  requestAccountDeletion,
  requestDataExport,
  verifyUserPassword,
} from '@/services/privacy.service.js';
import { Router } from 'express';
import type { Response } from 'express';

const router = Router();

/** Max one export request per user per hour. */
const exportLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyPrefix: 'rl:privacy:export',
});

/** Max three deletion attempts per user per day (covers wrong-password retries). */
const deletionLimiter = createUserRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyPrefix: 'rl:privacy:delete',
});

/** Exact phrase the client must send to confirm an irreversible action. */
const DELETION_CONFIRMATION = 'DELETE MY ACCOUNT';

// ── Data export ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/privacy/export
 *
 * Queues an export and returns 202 immediately. The payload is generated in the
 * background and retrieved via GET /export/:exportId.
 */
router.post(
  '/export',
  authenticate,
  exportLimiter,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const request = await requestDataExport(userId, req.ip ?? 'unknown');

    void processDataExport(userId, request.id).catch((err: unknown) => {
      console.error(
        '[privacy] export generation crashed',
        request.id,
        err instanceof Error ? err.message : err
      );
    });

    res.status(202).json({
      export_id: request.id,
      status: request.status,
      expires_at: request.expires_at,
      poll_url: `/api/v1/privacy/export/${request.id}`,
    });
  }
);

/**
 * GET /api/v1/privacy/export/:exportId
 */
router.get(
  '/export/:exportId',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const exportRecord = await getDataExportStatus(userId, req.params.exportId as string);
    if (!exportRecord) {
      res.status(404).json({ error: 'Export not found' });
      return;
    }

    if (exportRecord.status === 'pending') {
      res.status(202).json({ export_id: exportRecord.id, status: 'pending' });
      return;
    }

    if (exportRecord.status === 'failed') {
      res.status(500).json({
        export_id: exportRecord.id,
        status: 'failed',
        error: 'Export generation failed. Please request a new export.',
      });
      return;
    }

    if (new Date(exportRecord.expires_at) < new Date()) {
      res.status(410).json({ error: 'Export has expired. Please request a new export.' });
      return;
    }

    res.json({
      export_id: exportRecord.id,
      status: exportRecord.status,
      expires_at: exportRecord.expires_at,
      data: exportRecord.export_payload ?? null,
    });
  }
);

// ── Account deletion ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/privacy/delete-account
 *
 * Body: { password: string, confirmation: "DELETE MY ACCOUNT" }
 *
 * - Re-verifies the password (fresh proof of possession, not just a session).
 * - Refuses (409) while the user has open bookings, escrow, or disputes.
 * - Opens a 7-day cancellation window. Anonymisation runs after it closes.
 */
router.post(
  '/delete-account',
  authenticate,
  deletionLimiter,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { password, confirmation } = (req.body ?? {}) as {
      password?: unknown;
      confirmation?: unknown;
    };

    if (confirmation !== DELETION_CONFIRMATION) {
      res.status(400).json({ error: `Send confirmation: "${DELETION_CONFIRMATION}"` });
      return;
    }

    if (typeof password !== 'string' || password.length === 0) {
      res.status(400).json({ error: 'Password is required to delete your account' });
      return;
    }

    if (!(await verifyUserPassword(userId, password))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const deletion = await requestAccountDeletion(userId, req.ip ?? 'unknown');
      res.status(202).json({
        deletion_id: deletion.id,
        status: deletion.status,
        cancel_expires_at: deletion.cancel_expires_at,
        message:
          'Your account will be anonymised when the cancellation window closes. You can cancel until then.',
        retained_data: [
          'Booking and payment records (7-year legal retention)',
          'Audit log entries (7-year legal retention)',
          'Blockchain records on the Stellar ledger (permanent — cannot be deleted)',
        ],
      });
    } catch (err) {
      if (err instanceof DeletionBlockedError) {
        res.status(409).json({
          error:
            'Account deletion is blocked by open bookings or disputes. Resolve them and try again.',
          code: err.code,
          open_bookings: err.obligations.map((o) => ({
            booking_id: o.booking_id,
            status: o.status,
            role: o.role,
          })),
        });
        return;
      }
      console.error('[privacy] deletion request failed', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not start account deletion. Please try again.' });
    }
  }
);

/**
 * GET /api/v1/privacy/delete-account/:deletionId
 */
router.get(
  '/delete-account/:deletionId',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const deletion = await getDeletionRequest(userId, req.params.deletionId as string);
    if (!deletion) {
      res.status(404).json({ error: 'Deletion request not found' });
      return;
    }

    res.json({
      deletion_id: deletion.id,
      status: deletion.status,
      requested_at: deletion.requested_at,
      cancel_expires_at: deletion.cancel_expires_at,
      completed_at: deletion.completed_at ?? null,
      last_blocked_reason: deletion.last_blocked_reason ?? null,
    });
  }
);

/**
 * POST /api/v1/privacy/delete-account/:deletionId/cancel
 */
router.post(
  '/delete-account/:deletionId/cancel',
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const cancelled = await cancelAccountDeletion(
      userId,
      req.params.deletionId as string,
      req.ip ?? 'unknown'
    );
    if (!cancelled) {
      res
        .status(409)
        .json({ error: 'Deletion cannot be cancelled (not pending, or the window has closed)' });
      return;
    }

    res.json({ status: 'cancelled' });
  }
);

export default router;
