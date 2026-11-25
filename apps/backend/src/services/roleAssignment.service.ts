/**
 * Server-side role assignment (#916).
 *
 * Every role change goes through `changeUserRole`, which:
 *  1. re-reads the actor's role from the database (a JWT role claim can be stale),
 *  2. evaluates the transition matrix in config/roleTransitions.ts,
 *  3. writes with a compare-and-set on the previous role, so a concurrent
 *     change cannot be silently overwritten,
 *  4. records an audit event for allowed AND denied attempts, with actor,
 *     target, old role, new role, and the request correlation ID. No tokens
 *     or secrets are written.
 */

import {
  type AssignableRole,
  type RoleTransitionDenial,
  evaluateRoleTransition,
} from '@/config/roleTransitions.js';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from '@/services/auditLogger.service.js';

export type ChangeRoleResult =
  | { ok: true; userId: string; oldRole: string; newRole: AssignableRole }
  | {
      ok: false;
      status: 403 | 404 | 409 | 422 | 500;
      code:
        | RoleTransitionDenial
        | 'NOT_FOUND'
        | 'CONCURRENT_UPDATE'
        | 'DB_ERROR'
        | 'INVALID_REASON';
      message: string;
    };

export interface ChangeRoleParams {
  actorId: string;
  targetId: string;
  toRole: AssignableRole;
  /** Operator-supplied justification. Required and validated server-side. */
  reason: string;
  requestId?: string;
  ip?: string;
}

/** Minimum length for an operator-supplied reason. */
export const MIN_REASON_LENGTH = 10;
/** Maximum stored length; longer reasons are rejected rather than truncated. */
export const MAX_REASON_LENGTH = 500;

/**
 * Validates an operator-supplied reason. Returns a normalized reason or an
 * error message. Whitespace-only or too-short reasons are rejected so the
 * audit trail always carries a meaningful justification.
 */
export function validateReason(
  reason: unknown,
): { ok: true; reason: string } | { ok: false; message: string } {
  if (typeof reason !== 'string') {
    return { ok: false, message: 'A reason is required for role changes.' };
  }
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      message: `Reason must be at least ${MIN_REASON_LENGTH} characters.`,
    };
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      message: `Reason must be at most ${MAX_REASON_LENGTH} characters.`,
    };
  }
  return { ok: true, reason: trimmed };
}

const STATUS_BY_CODE: Partial<Record<RoleTransitionDenial, 403 | 409 | 422>> = {
  ACTOR_NOT_ADMIN: 403,
  SELF_ROLE_CHANGE: 403,
  UNKNOWN_ROLE: 422,
  NO_CHANGE: 409,
  PRIVILEGED_TO_PRIVILEGED: 409,
  LAST_ADMIN: 409,
};

export async function changeUserRole(params: ChangeRoleParams): Promise<ChangeRoleResult> {
  const { actorId, targetId, toRole, requestId, ip } = params;

  const auditBase = {
    actorId,
    action: 'admin.user_role_change' as const,
    resourceType: 'user' as const,
    resourceId: targetId,
    correlationId: requestId,
    ip,
  };

  // Reason is validated before anything else so a missing justification is
  // never silently dropped from the audit trail.
  const reasonCheck = validateReason(params.reason);
  if (!reasonCheck.ok) {
    await auditLogger.log({
      ...auditBase,
      action: 'admin.user_role_change_denied',
      success: false,
      error: 'INVALID_REASON',
      meta: { new_role: toRole, reason: 'INVALID_REASON' },
    });
    return { ok: false, status: 422, code: 'INVALID_REASON', message: reasonCheck.message };
  }
  const reason = reasonCheck.reason;

  const { data: actor, error: actorErr } = await supabase
    .from('users')
    .select('role')
    .eq('id', actorId)
    .maybeSingle();
  if (actorErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Could not verify actor.' };
  }

  const { data: target, error: targetErr } = await supabase
    .from('users')
    .select('id, role')
    .eq('id', targetId)
    .maybeSingle();
  if (targetErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Could not load target user.' };
  }
  if (!target) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'User not found.' };
  }

  const { count: adminCount } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin');

  const decision = evaluateRoleTransition({
    actorRole: (actor as { role?: string } | null)?.role ?? null,
    actorId,
    targetId,
    fromRole: target.role,
    toRole,
    adminCount: adminCount ?? 0,
  });

  if (!decision.allowed) {
    await auditLogger.log({
      ...auditBase,
      action: 'admin.user_role_change_denied',
      success: false,
      error: decision.code,
      meta: { old_role: target.role, new_role: toRole, reason, denial: decision.code },
    });
    return {
      ok: false,
      status: STATUS_BY_CODE[decision.code] ?? 403,
      code: decision.code,
      message: decision.message,
    };
  }

  // Compare-and-set: the update only applies if the role is still what we read.
  const { data: updated, error: updateErr } = await supabase
    .from('users')
    .update({ role: toRole })
    .eq('id', targetId)
    .eq('role', target.role)
    .select('id')
    .maybeSingle();

  if (updateErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Role update failed.' };
  }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      code: 'CONCURRENT_UPDATE',
      message: 'The user role changed while this request was processing. Reload and try again.',
    };
  }

  await auditLogger.log({
    ...auditBase,
    success: true,
    meta: { old_role: target.role, new_role: toRole, reason },
  });

  return { ok: true, userId: targetId, oldRole: target.role, newRole: toRole };
}
