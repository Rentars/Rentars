/**
 * Admin Least-Privilege Policy Inventory (Issue #116)
 *
 * Central inventory mapping every admin endpoint to its required scope,
 * permitted roles, owning team, risk tier, dual-approval requirement, and
 * operational runbook. Single source of truth for:
 * - Centralized policy enforcement (`canInvoke`).
 * - Immediate denial after role removal (`denyAfterRoleRemoval` — the
 *   request-time role is authoritative; no cached privilege survives it).
 * - Runbook linkage for moderation, refunds, reconciliation, account
 *   support, and emergency controls.
 *
 * Complements `adminScopes.ts` (scope definitions) and
 * `adminScope.middleware.ts` (request enforcement).
 */

import { type AdminRole, type AdminScope, roleHasScope } from './adminScopes.js';

export type RiskTier = 'low' | 'medium' | 'high';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AdminActionPolicy {
  /** e.g. 'POST /api/v1/admin/disputes/:id/resolve' */
  endpoint: string;
  method: HttpMethod;
  /** Path pattern, e.g. '/api/v1/admin/disputes/:id/resolve' */
  path: string;
  scope: AdminScope;
  /** Least-privilege roles permitted to invoke this operation. */
  allowedRoles: AdminRole[];
  owner: string;
  risk: RiskTier;
  /** Whether the operation requires an operator-supplied reason. */
  requiresReason: boolean;
  /** Whether the operation can be undone via a documented rollback. */
  reversible: boolean;
  runbook: string; // docs/admin-runbooks.md anchor
  preconditions: string[];
  rollback: string;
}

/**
 * Operation-to-role matrix. Every privileged admin route MUST appear here;
 * `getPolicyForEndpoint` is the single lookup used by middleware and
 * service mutations so that no route relies on a broad "is admin" check.
 *
 * Least-privilege capability summary:
 * - support:    read-only account support (view users, activate/unsuspend).
 * - moderator:  content moderation (suspend properties, resolve disputes,
 *               activate users) — no financial or account-destructive ops.
 * - finance:    refunds and reconciliation — no user/property moderation.
 * - admin:      full set, including high-risk destructive operations.
 */
export const ADMIN_ACTION_POLICIES: AdminActionPolicy[] = [
  {
    endpoint: 'POST /api/v1/admin/users/:id/suspend',
    method: 'POST',
    path: '/api/v1/admin/users/:id/suspend',
    scope: 'admin:users:suspend',
    allowedRoles: ['admin'],
    owner: 'trust-and-safety',
    risk: 'high',
    requiresReason: true,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-1--suspend-a-user',
    preconditions: ['Evidence ticket filed', 'Dual approval obtained'],
    rollback: 'POST /api/v1/admin/users/:id/activate',
  },
  {
    endpoint: 'POST /api/v1/admin/users/:id/activate',
    method: 'POST',
    path: '/api/v1/admin/users/:id/activate',
    scope: 'admin:users:activate',
    allowedRoles: ['admin', 'moderator', 'support'],
    owner: 'trust-and-safety',
    risk: 'medium',
    requiresReason: true,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-2--activate-unsuspend-a-user',
    preconditions: ['Suspension reason resolved'],
    rollback: 'POST /api/v1/admin/users/:id/suspend',
  },
  {
    endpoint: 'GET /api/v1/admin/users/:id',
    method: 'GET',
    path: '/api/v1/admin/users/:id',
    scope: 'admin:users:read',
    allowedRoles: ['admin', 'moderator', 'support'],
    owner: 'trust-and-safety',
    risk: 'low',
    requiresReason: false,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-8--account-support-lookup',
    preconditions: [],
    rollback: 'Read-only — no rollback needed',
  },
  {
    endpoint: 'POST /api/v1/admin/properties/:id/suspend',
    method: 'POST',
    path: '/api/v1/admin/properties/:id/suspend',
    scope: 'admin:properties:suspend',
    allowedRoles: ['admin', 'moderator'],
    owner: 'content-moderation',
    risk: 'medium',
    requiresReason: true,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-3--suspend-a-property-listing',
    preconditions: ['Active bookings checked'],
    rollback: 'POST /api/v1/admin/properties/:id/activate',
  },
  {
    endpoint: 'POST /api/v1/admin/properties/:id/activate',
    method: 'POST',
    path: '/api/v1/admin/properties/:id/activate',
    scope: 'admin:properties:activate',
    allowedRoles: ['admin', 'moderator'],
    owner: 'content-moderation',
    risk: 'low',
    requiresReason: false,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-3--suspend-a-property-listing',
    preconditions: [],
    rollback: 'POST /api/v1/admin/properties/:id/suspend',
  },
  {
    endpoint: 'POST /api/v1/admin/disputes/:id/resolve',
    method: 'POST',
    path: '/api/v1/admin/disputes/:id/resolve',
    scope: 'admin:disputes:resolve',
    allowedRoles: ['admin', 'moderator'],
    owner: 'disputes-team',
    risk: 'high',
    requiresReason: true,
    reversible: false,
    runbook: 'docs/admin-runbooks.md#runbook-4--resolve-a-dispute',
    preconditions: ['Investigation checklist complete', 'Dual approval obtained'],
    rollback: 'Irreversible on-chain settlement — manual refund runbook only',
  },
  {
    endpoint: 'POST /api/v1/admin/refunds/approve',
    method: 'POST',
    path: '/api/v1/admin/refunds/approve',
    scope: 'admin:refunds:approve',
    allowedRoles: ['admin', 'finance'],
    owner: 'finance',
    risk: 'high',
    requiresReason: true,
    reversible: false,
    runbook: 'docs/admin-runbooks.md#runbook-5--manual-refund-approval',
    preconditions: ['Amount <= total_price verified', 'Dual approval obtained'],
    rollback: 'Irreversible USDC transfer — no rollback',
  },
  {
    endpoint: 'GET /api/v1/admin/reconciliation',
    method: 'GET',
    path: '/api/v1/admin/reconciliation',
    scope: 'admin:reconciliation:read',
    allowedRoles: ['admin', 'finance'],
    owner: 'finance',
    risk: 'low',
    requiresReason: false,
    reversible: true,
    runbook: 'docs/admin-runbooks.md#runbook-7--reconciliation-review',
    preconditions: [],
    rollback: 'Read-only — no rollback needed',
  },
  {
    endpoint: 'GET /api/v1/admin/analytics',
    scope: 'admin:analytics:read',
    roles: ['admin'],
    owner: 'analytics',
    risk: 'low',
    runbook: 'docs/admin-runbooks.md#runbook-8--aggregate-analytics-review',
    preconditions: [
      'Aggregate-only response (cohorts below minimum size suppressed)',
      'Time window within approved bounds',
    ],
    rollback: 'Read-only — no rollback needed',
  },
  {
    endpoint: 'GET /api/v1/admin/analytics/raw',
    scope: 'admin:analytics:raw',
    roles: ['admin'],
    owner: 'analytics',
    risk: 'high',
    runbook: 'docs/admin-runbooks.md#runbook-9--elevated-raw-analytics-access',
    preconditions: [
      'Documented purpose recorded in access log',
      'Dual approval obtained',
      'Time window within approved bounds',
    ],
    rollback: 'Read-only — no rollback needed',
  },
];

/** High-risk = high tier (all require dual approval via middleware). */
export function isHighRisk(policy: AdminActionPolicy): boolean {
  return policy.risk === 'high';
}

/**
 * Centralized enforcement: true only if `role` is listed for the endpoint
 * AND holds the required scope. Role removal takes effect immediately
 * because callers must pass the current role on every request.
 */
export function canInvoke(
  endpoint: string,
  role: string,
): { allowed: boolean; reason?: string } {
  const policy = ADMIN_ACTION_POLICIES.find((p) => p.endpoint === endpoint);
  if (!policy) return { allowed: false, reason: 'Unknown admin endpoint.' };
  if (!(policy.allowedRoles as string[]).includes(role)) {
    return { allowed: false, reason: `Role ${role} is not permitted for ${endpoint}.` };
  }
  if (!roleHasScope(role, policy.scope)) {
    return { allowed: false, reason: `Role ${role} lacks scope ${policy.scope}.` };
  }
  return { allowed: true };
}

/**
 * Scope-level check: true only if `role` is explicitly granted `scope`.
 * Used by service mutations that are not tied to a single HTTP endpoint.
 */
export function canInvokeScope(
  role: string,
  scope: AdminScope,
): { allowed: boolean; reason?: string } {
  if (!roleHasScope(role, scope)) {
    return { allowed: false, reason: `Role ${role} lacks scope ${scope}.` };
  }
  return { allowed: true };
}

/**
 * Resolve the policy for a concrete request. Matches on HTTP method plus
 * path pattern (with `:param` segments matching any single segment).
 * Returns `undefined` for unknown routes so callers can fail closed.
 */
export function getPolicyForEndpoint(
  method: string,
  path: string,
): AdminActionPolicy | undefined {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.split('?')[0].replace(/\/+$/, '') || '/';
  return ADMIN_ACTION_POLICIES.find((policy) => {
    if (policy.method !== normalizedMethod) return false;
    const patternSegments = policy.path.split('/');
    const pathSegments = normalizedPath.split('/');
    if (patternSegments.length !== pathSegments.length) return false;
    return patternSegments.every((segment, i) => {
      if (segment.startsWith(':')) return pathSegments[i].length > 0;
      return segment === pathSegments[i];
    });
  });
}
