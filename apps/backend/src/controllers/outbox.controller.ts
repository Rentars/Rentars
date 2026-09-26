/**
 * Outbox Controller — admin endpoints for the notification outbox.
 *
 * Routes:
 *   GET    /api/v1/admin/outbox/stats          — counts by status
 *   GET    /api/v1/admin/outbox/dead-letters   — list dead-letter rows
 *   POST   /api/v1/admin/outbox/:id/retry      — reset dead-letter to pending
 *   DELETE /api/v1/admin/outbox/:id            — permanently discard
 */

import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  getOutboxStats,
  listDeadLetters,
  retryDeadLetter,
  discardDeadLetter,
} from '../services/notificationOutbox.service.js';

export async function outboxStats(_req: AuthRequest, res: Response): Promise<void> {
  const result = await getOutboxStats();
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function listDeadLetterRows(req: AuthRequest, res: Response): Promise<void> {
  const limit  = Number(req.query.limit  ?? 50);
  const offset = Number(req.query.offset ?? 0);
  const result = await listDeadLetters(limit, offset);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function retryDeadLetterRow(req: AuthRequest, res: Response): Promise<void> {
  const result = await retryDeadLetter(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function discardDeadLetterRow(req: AuthRequest, res: Response): Promise<void> {
  const actorId = req.userId;
  if (!actorId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { reason } = req.body as { reason?: string };
  if (!reason?.trim()) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }

  const result = await discardDeadLetter(req.params.id, actorId, reason);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(204).send();
}
