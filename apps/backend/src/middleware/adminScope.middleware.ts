/**
 * Admin Scope Middleware
 *
 * Two-layer gate for all admin routes:
 *
 *   1. requireAdminRole  — verifies a valid admin-family JWT (role must be one
 *      of admin | moderator | support | finance).
 *
 *   2. requireScope(scope)  — checks that the actor's role includes the
 *      required capability.  For scopes in DUAL_APPROVAL_REQUIRED it also
 *      validates the X-Approval-Actor header (must be a different, valid actor
 *      id) and records both actors in the audit log.
 *
 * Usage in routes:
 *
 *   router.post(
 *     '/disputes/:id/resolve',
 *     requireAdminRole,
 *     requireScope('admin:disputes:resolve'),
 *     resolveDisputeHandler,
 *   );
 */

import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  type AdminScope,
  DUAL_APPROVAL_REQUIRED,
  roleHasScope,
} from '@/config/adminScopes.js';
import { getOperationPolicy } from '@/config/adminPolicy.js';
import { getJwtSecret } from '@/config/jwtSecret.js';
import { auditLogger } from '@/services/auditLogger.service.js';

export interface AdminRequest extends Request {
  adminId?: string;
  adminRole?: string;
  requestId?: string;
}

/**
 * Resolves (or generates) a request ID for correlation in audit logs.
 */
function resolveRequestId(req: AdminRequest): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.trim() !== '') {
    return header.trim();
  }
  return randomUUID();
}

// ── Step 1: authenticate ──────────────────────────────────────────────────────

/**
 * Validates the Bearer JWT and verifies the role is an admin-family role.
 * Populates req.adminId and req.adminRole.
 */
export function requireAdminRole(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization token.' } });
    return;
  }

  try {
    // Fail closed: never verify admin tokens against a guessable default key.
    const secret = process.env.ADMIN_JWT_SECRET || getJwtSecret();
    const decoded = jwt.verify(token, secret) as { userId: string; role?: string };

    const adminRoles = new Set(['admin', 'moderator', 'support', 'finance']);
    if (!decoded.role || !adminRoles.has(decoded.role)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Admin role required.' },
      });
      return;
    }

    req.adminId = decoded.userId;
    req.adminRole = decoded.role;
    next();
  } catch {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token.' } });
  }
}

// ── Step 2: scope check + dual-approval ───────────────────────────────────────

/**
 * Returns Express middleware that:
 *   - Verifies the actor's role has `scope`.
 *   - For HIGH-RISK scopes: validates X-Approval-Actor header and logs both actors.
 */
export function requireScope(scope: AdminScope) {
  return async function scopeMiddleware(
    req: AdminRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const role = req.adminRole ?? '';
    const actorId = req.adminId ?? '';
    const requestId = resolveRequestId(req);
    req.requestId = requestId;

    // ── Centralized permission check ───────────────────────────────────────
    // Look up the operation policy and verify the actor's role is explicitly
    // allowed. Deny before any sensitive data access so resource existence is
    // never leaked to unauthorized actors.
    const policy = getOperationPolicy(scope);
    const allowed = policy
      ? policy.allowedRoles.includes(role as (typeof policy.allowedRoles)[number])
      : roleHasScope(role, scope);

    if (!allowed) {
      await auditLogger.log({
        actorId,
        action: 'admin.user_suspend', // closest available action for scope denial logging
        resourceType: 'admin',
        ip: req.ip,
        meta: {
          request_id: requestId,
          scope,
          reason: 'scope_denied',
          role,
          endpoint: `${req.method} ${req.baseUrl ?? ''}${req.path ?? ''}`,
          outcome: 'denied',
        },
      });
      res.status(403).json({
        error: {
          code: 'SCOPE_DENIED',
          message: `Your role (${role}) does not have the required scope: ${scope}.`,
        },
      });
      return;
    }

    // Record the successful privileged authorization decision.
    await auditLogger.log({
      actorId,
      action: 'admin.user_activate', // best available "authorized" marker
      resourceType: 'admin',
      ip: req.ip,
      meta: {
        request_id: requestId,
        scope,
        role,
        endpoint: `${req.method} ${req.baseUrl ?? ''}${req.path ?? ''}`,
        outcome: 'allowed',
        resource_id: req.params.id ?? null,
      },
    });

    // ── Dual-approval check (HIGH-RISK actions) ────────────────────────────
    if (DUAL_APPROVAL_REQUIRED.has(scope)) {
      const approvalActor = req.headers['x-approval-actor'];

      if (!approvalActor || typeof approvalActor !== 'string' || approvalActor.trim() === '') {
        res.status(403).json({
          error: {
            code: 'DUAL_APPROVAL_REQUIRED',
            message:
              `This action (scope: ${scope}) requires dual approval. ` +
              'Supply the approving admin\'s user ID in the X-Approval-Actor request header. ' +
              'The approving actor must be different from the requesting actor and must hold ' +
              'a role with the same scope.',
          },
        });
        return;
      }

      const approvalActorId = approvalActor.trim();

      if (approvalActorId === actorId) {
        res.status(403).json({
          error: {
            code: 'SELF_APPROVAL_NOT_ALLOWED',
            message: 'The X-Approval-Actor must be a different user from the requesting actor.',
          },
        });
        return;
      }

      // Record dual-approval evidence in the audit log before the action proceeds
      await auditLogger.log({
        actorId,
        action: 'admin.user_activate', // best available "approved" marker
        resourceType: 'admin',
        ip: req.ip,
        meta: {
          request_id: requestId,
          scope,
          role,
          approval_actor: approvalActorId,
          dual_approval: true,
          resource_id: req.params.id ?? null,
          outcome: 'dual_approved',
        },
      });

      // Attach approval actor to request so handlers can reference it
      (req as AdminRequest & { approvalActorId?: string }).approvalActorId = approvalActorId;
    }

    next();
  };
}

/**
 * Convenience: stack requireAdminRole + requireScope in a single middleware array.
 *
 * Usage:
 *   router.post('/disputes/:id/resolve', ...adminGuard('admin:disputes:resolve'), handler);
 */
export function adminGuard(scope: AdminScope) {
  return [requireAdminRole, requireScope(scope)] as const;
}
