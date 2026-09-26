/**
 * Trust & Risk Routes
 *
 * All routes require an admin-family role (admin or moderator).
 * 'suspended' override requires admin role specifically (dual-gated below).
 *
 * Route map:
 *   GET    /api/v1/trust/cases                          — list cases (filter by status/level/user)
 *   GET    /api/v1/trust/cases/:id                      — get a single case
 *   POST   /api/v1/trust/cases/:id/assign               — assign to a moderator
 *   POST   /api/v1/trust/cases/:id/resolve              — resolve with note
 *   POST   /api/v1/trust/cases/:id/override             — override automated action
 *   GET    /api/v1/trust/users/:userId/cases            — all cases for a user
 *   GET    /api/v1/trust/users/:userId/active-action    — active automated action for a user
 *   POST   /api/v1/trust/users/:userId/evaluate         — trigger manual risk evaluation
 *   POST   /api/v1/trust/users/:userId/signals/chargeback     — inject chargeback signal
 *   POST   /api/v1/trust/users/:userId/signals/identity-fail  — inject ID-check failure signal
 */

import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  listTrustCases,
  getTrustCase,
  getUserTrustCases,
  getActiveAction,
  assignTrustCase,
  resolveTrustCase,
  overrideTrustCase,
  triggerRiskEvaluation,
  injectChargebackSignal,
  injectIdentityFailSignal,
} from '../controllers/trustRisk.controller.js';

const router = Router();

// All trust routes require authentication + admin or moderator role.
router.use(authenticate, requireRole('admin', 'moderator'));

// ── Case queries ───────────────────────────────────────────────────────────────
router.get('/cases',                      listTrustCases);
router.get('/cases/:id',                  getTrustCase);
router.get('/users/:userId/cases',        getUserTrustCases);
router.get('/users/:userId/active-action', getActiveAction);

// ── Case mutations ─────────────────────────────────────────────────────────────
router.post('/cases/:id/assign',    assignTrustCase);
router.post('/cases/:id/resolve',   resolveTrustCase);

// Override: 'suspended' action is admin-only; all others allow moderator.
// We handle this at the controller level by checking req.user.role for 'suspended'.
router.post('/cases/:id/override',  overrideTrustCase);

// ── Manual signal injection (admin-only) ───────────────────────────────────────
router.post(
  '/users/:userId/evaluate',
  requireRole('admin'),
  triggerRiskEvaluation,
);
router.post(
  '/users/:userId/signals/chargeback',
  requireRole('admin'),
  injectChargebackSignal,
);
router.post(
  '/users/:userId/signals/identity-fail',
  requireRole('admin'),
  injectIdentityFailSignal,
);

export default router;
