/**
 * Trust Risk Controller
 *
 * HTTP handlers for the trust risk case management endpoints.
 * All routes require admin or moderator role (enforced at the route layer).
 */

import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  listCases,
  getCaseById,
  getCasesForUser,
  assignCase,
  resolveCase,
  overrideCase,
  runRiskEvaluation,
  recordChargebackSignal,
  recordFailedIdentitySignal,
  getUserActiveAction,
  type CaseStatus,
  type RiskLevel,
  type OverrideAction,
} from '../services/trustRisk.service.js';

// ─── List cases ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/trust/cases
 * Query params: status, risk_level, user_id, limit, offset
 */
export async function listTrustCases(req: AuthRequest, res: Response): Promise<void> {
  const { status, risk_level, user_id, limit, offset } = req.query as Record<string, string>;

  const result = await listCases({
    status:    status    as CaseStatus | undefined,
    riskLevel: risk_level as RiskLevel | undefined,
    userId:    user_id   as string | undefined,
    limit:     limit  ? Number(limit)  : undefined,
    offset:    offset ? Number(offset) : undefined,
  });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Get single case ──────────────────────────────────────────────────────────

/** GET /api/v1/trust/cases/:id */
export async function getTrustCase(req: AuthRequest, res: Response): Promise<void> {
  const result = await getCaseById(req.params.id);
  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Cases for a specific user ────────────────────────────────────────────────

/** GET /api/v1/trust/users/:userId/cases */
export async function getUserTrustCases(req: AuthRequest, res: Response): Promise<void> {
  const result = await getCasesForUser(req.params.userId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Active action for a user ─────────────────────────────────────────────────

/** GET /api/v1/trust/users/:userId/active-action */
export async function getActiveAction(req: AuthRequest, res: Response): Promise<void> {
  const result = await getUserActiveAction(req.params.userId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Assign case ──────────────────────────────────────────────────────────────

/** POST /api/v1/trust/cases/:id/assign */
export async function assignTrustCase(req: AuthRequest, res: Response): Promise<void> {
  const actorId = req.userId;
  if (!actorId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { moderator_id } = req.body as { moderator_id?: string };
  const assignTo = moderator_id ?? actorId; // default: assign to self

  const result = await assignCase(req.params.id, assignTo);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Resolve case ─────────────────────────────────────────────────────────────

/** POST /api/v1/trust/cases/:id/resolve */
export async function resolveTrustCase(req: AuthRequest, res: Response): Promise<void> {
  const actorId = req.userId;
  if (!actorId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { resolution_note } = req.body as { resolution_note?: string };
  if (!resolution_note?.trim()) {
    res.status(400).json({ error: 'resolution_note is required' });
    return;
  }

  const result = await resolveCase(req.params.id, actorId, resolution_note);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Override case ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/trust/cases/:id/override
 * Body: { action: 'lifted' | 'escalated' | 'suspended' | 'cleared', reason: string }
 *
 * 'suspended' requires admin role (enforced in the route via requireRole('admin')).
 * All other actions are available to admin and moderator.
 */
export async function overrideTrustCase(req: AuthRequest, res: Response): Promise<void> {
  const actorId = req.userId;
  if (!actorId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { action, reason } = req.body as { action?: string; reason?: string };

  const validActions: OverrideAction[] = ['lifted', 'escalated', 'suspended', 'cleared'];
  if (!action || !validActions.includes(action as OverrideAction)) {
    res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
    return;
  }
  if (!reason?.trim()) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }

  // 'suspended' is a high-risk action — only admins may apply it.
  if (action === 'suspended' && req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: only admins may apply a suspension override' });
    return;
  }

  const result = await overrideCase(req.params.id, actorId, action as OverrideAction, reason);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Manual signal injection (admin) ─────────────────────────────────────────

/**
 * POST /api/v1/trust/users/:userId/evaluate
 * Triggers a full signal collection pass for the given user.
 * Useful after a manual review or when support suspects fraudulent activity.
 */
export async function triggerRiskEvaluation(req: AuthRequest, res: Response): Promise<void> {
  const result = await runRiskEvaluation(req.params.userId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ case: result.data ?? null, message: result.data ? 'Risk case created/updated.' : 'Score below threshold — no case created.' });
}

/**
 * POST /api/v1/trust/users/:userId/signals/chargeback
 * Body: { source_id?: string }
 */
export async function injectChargebackSignal(req: AuthRequest, res: Response): Promise<void> {
  const { source_id } = req.body as { source_id?: string };
  const result = await recordChargebackSignal(req.params.userId, source_id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ case: result.data ?? null });
}

/**
 * POST /api/v1/trust/users/:userId/signals/identity-fail
 * Body: { source_id?: string }
 */
export async function injectIdentityFailSignal(req: AuthRequest, res: Response): Promise<void> {
  const { source_id } = req.body as { source_id?: string };
  const result = await recordFailedIdentitySignal(req.params.userId, source_id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ case: result.data ?? null });
}
