/**
 * Admin Routes
 *
 * Every route in this file is protected by TWO middleware layers:
 *
 *   1. requireAdminRole  — validates a JWT with an admin-family role claim
 *      (admin | moderator | support | finance).
 *
 *   2. requireScope(scope) — verifies the caller's role includes the specific
 *      capability required by that endpoint.  HIGH-RISK scopes also require
 *      the X-Approval-Actor header (dual approval).
 *
 * See: src/config/adminScopes.ts   — scope definitions and role→scope mapping
 *      src/middleware/adminScope.middleware.ts — enforcement logic
 *      docs/admin-runbooks.md       — operational runbooks for each action
 *
 * Role capabilities at a glance:
 *   admin      — all scopes
 *   moderator  — content, disputes, analytics (no finance)
 *   support    — read-only lookup (no mutations)
 *   finance    — refund approval, reconciliation (dual-approval required)
 */

import { Router } from 'express';
import { requireAdminRole, requireScope } from '@/middleware/adminScope.middleware.js';
import {
  getRateLimitSummary,
  setFeaturedHandler,
  clearFeaturedHandler,
  getTopQueriesHandler,
  getZeroResultQueriesHandler,
  getSearchVolumeHandler,
  getRawAnalyticsHandler,
  // User management
  listUsers,
  getUserDetail,
  suspendUser,
  activateUser,
  changeUserRoleHandler,
  // Property management
  listAdminProperties,
  suspendProperty,
  activateProperty,
  // Bookings
  listAdminBookings,
  getEscrowReconciliationHandler,
  // Disputes
  listDisputes,
  resolveDispute,
  // Dashboard
  getDashboard,
  // Audit logs
  getAuditLogsHandler,
} from '@/controllers/admin.controller.js';
import emailAdminRoutes from './emailAdmin.routes.js';
import notificationMonitorRoutes from './notificationMonitor.routes.js';

const router = Router();

/**
 * All routes first verify the actor holds an admin-family role JWT.
 * Individual routes then check the specific scope required.
 */
router.use(requireAdminRole);

// ── Dashboard ─────────────────────────────────────────────────────────────────
// Scope: admin:dashboard:read
// Roles: admin, moderator
router.get('/dashboard', requireScope('admin:dashboard:read'), getDashboard);

// ── User management ───────────────────────────────────────────────────────────
// Scope: admin:users:read      → admin, moderator, support
// Scope: admin:users:suspend   → admin only (HIGH-RISK — dual approval required)
// Scope: admin:users:activate  → admin, moderator
router.get('/users', requireScope('admin:users:read'), listUsers);
router.get('/users/:id', requireScope('admin:users:read'), getUserDetail);
router.post('/users/:id/suspend', requireScope('admin:users:suspend'), suspendUser);
router.post('/users/:id/activate', requireScope('admin:users:activate'), activateUser);
// Scope: admin:users:role → admin only. Actor role is re-checked against the DB in the service.
router.patch('/users/:id/role', requireScope('admin:users:role'), changeUserRoleHandler);

// ── Property management ───────────────────────────────────────────────────────
// Scope: admin:properties:read     → admin, moderator, support
// Scope: admin:properties:suspend  → admin, moderator
// Scope: admin:properties:activate → admin, moderator
// Scope: admin:properties:feature  → admin, moderator
router.get('/properties', requireScope('admin:properties:read'), listAdminProperties);
router.post('/properties/:id/suspend', requireScope('admin:properties:suspend'), suspendProperty);
router.post('/properties/:id/activate', requireScope('admin:properties:activate'), activateProperty);
router.put('/properties/:id/featured', requireScope('admin:properties:feature'), setFeaturedHandler);
router.delete('/properties/:id/featured', requireScope('admin:properties:feature'), clearFeaturedHandler);
// POST /api/v1/admin/properties/:id/images/:imageId/moderation — approve | reject | remove (#922)
router.post(
  '/properties/:id/images/:imageId/moderation',
  requireScope('admin:properties:moderate_images'),
  moderateImage,
);

// ── Bookings (admin view) ─────────────────────────────────────────────────────
// Scope: admin:bookings:read → admin, moderator, support, finance
router.get('/bookings', requireScope('admin:bookings:read'), listAdminBookings);
router.get(
  '/bookings/:id/escrow-reconciliation',
  requireScope('admin:reconciliation:read'),
  getEscrowReconciliationHandler,
);

// ── Disputes ──────────────────────────────────────────────────────────────────
// Scope: admin:disputes:read    → admin, moderator, support, finance
// Scope: admin:disputes:resolve → admin, moderator (HIGH-RISK — dual approval required)
router.get('/disputes', requireScope('admin:disputes:read'), listDisputes);
router.post('/disputes/:id/resolve', requireScope('admin:disputes:resolve'), resolveDispute);

// ── Rate-limit summary ────────────────────────────────────────────────────────
// Scope: admin:ratelimits:read → admin, support
router.get('/rate-limits', requireScope('admin:ratelimits:read'), getRateLimitSummary);

// ── Search analytics (aggregate-only) ─────────────────────────────────────────
// Scope: admin:analytics:read → admin, moderator
//
// Privacy contract (#983 / Issue 088):
//   - These endpoints return AGGREGATE data only. Cohorts below the approved
//     minimum aggregation size are suppressed by the analytics service.
//   - Responses must never include raw IPs, exact coordinates, or full query
//     strings; only normalized/aggregated fields are exposed.
//   - Time windows are bounded by the service (no unbounded historical scans).
//   - Raw event data is NOT served here. It is only reachable through the
//     documented elevated process (see /analytics/raw below), which requires a
//     separate high-risk scope and dual approval.
router.get('/analytics/search/top-queries', requireScope('admin:analytics:read'), getTopQueriesHandler);
router.get('/analytics/search/zero-results', requireScope('admin:analytics:read'), getZeroResultQueriesHandler);
router.get('/analytics/search/volume', requireScope('admin:analytics:read'), getSearchVolumeHandler);

// ── Raw analytics events (ELEVATED — documented process only) ─────────────────
// Scope: admin:analytics:raw → admin only (HIGH-RISK — dual approval required)
//
// This is the ONLY route that may return user-level event data. Access is
// gated by a dedicated high-risk scope (dual approval via X-Approval-Actor),
// every request is written to the audit log, and the handler enforces a
// bounded time window plus a documented-purpose requirement. Do not widen
// this scope to moderator/support/finance roles.
router.get('/analytics/raw', requireScope('admin:analytics:raw'), getRawAnalyticsHandler);

// ── Audit log ─────────────────────────────────────────────────────────────────
// Scope: admin:audit:read → admin only (narrow role; audit records are sensitive)
// Ordinary update/delete routes are intentionally absent — audit is append-only.
router.get('/audit-logs', requireScope('admin:audit:read'), getAuditLogsHandler);

// ── Refund approval (finance) ─────────────────────────────────────────────────
// Scope: admin:refunds:approve → admin, finance (HIGH-RISK — dual approval required)
// Body: { booking_id: string, refund_amount: number, reason: string }
import { approveRefundHandler } from '@/controllers/admin.controller.js';
import { moderateImage } from '@/controllers/propertyImage.controller.js';
router.post('/refunds/approve', requireScope('admin:refunds:approve'), approveRefundHandler);

// ── Email delivery tracking ───────────────────────────────────────────────────
// Scoped sub-router — all routes inside require admin:email:read
// Mounted at /api/v1/admin/email/*
// Defense in depth: the mount itself also enforces the scope so a sub-router
// that forgets a per-route check cannot be reached by an under-privileged role.
router.use('/email', requireScope('admin:email:read'), emailAdminRoutes);

// ── Notification monitoring ───────────────────────────────────────────────────
// Scoped sub-router — all routes inside require admin:notifications:read
// Mounted at /api/v1/admin/notifications/*
router.use('/notifications', requireScope('admin:notifications:read'), notificationMonitorRoutes);

// ── Reconciliation operations (#772) ─────────────────────────────────────────
// Scoped sub-router — read requires admin:reconciliation:read,
//                     write requires admin:reconciliation:write
// Mounted at /api/v1/admin/reconciliation/*
// Defense in depth: the mount enforces the read scope; the sub-router enforces
// the write scope on mutating routes.
import reconciliationRoutes from './reconciliation.routes.js';
router.use('/reconciliation', requireScope('admin:reconciliation:read'), reconciliationRoutes);

export default router;
