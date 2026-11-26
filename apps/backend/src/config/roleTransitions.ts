/**
 * Role-transition policy for user role changes (#916).
 *
 * The server is the only authority for `users.role`. This module is a pure
 * policy: it decides whether a proposed change is allowed, given the actor's
 * server-side role and whether the actor is changing their own account.
 * Persistence and auditing live in roleAssignment.service.ts.
 *
 * Matrix (actor must be `admin`; checked against the database, not the JWT):
 *
 *   from \ to      | tenant | host | admin | moderator | support | finance
 *   tenant         |   -    |  ✓   |   ✓   |     ✓     |    ✓    |    ✓
 *   host           |   ✓    |  -   |   ✓   |     ✓     |    ✓    |    ✓
 *   admin          |   ✓    |  ✓   |   -   |     ✗     |    ✗    |    ✗
 *   moderator      |   ✓    |  ✓   |   ✗   |     -     |    ✗    |    ✗
 *   support        |   ✓    |  ✓   |   ✗   |     ✗     |    -    |    ✗
 *   finance        |   ✓    |  ✓   |   ✗   |     ✗     |    ✗    |    -
 *
 * Privileged roles can only be granted or removed by moving through a
 * non-privileged role, which keeps every privilege change a deliberate,
 * separately-audited step. Self-changes are always refused, and the last
 * remaining admin cannot be demoted.
 *
 * The DB `users_role_check` constraint (migration 00057) is the storage-level
 * allow-list. `both` from the web type is not stored by the backend.
 *
 * ---------------------------------------------------------------------------
 * Account suspension / restoration policy (#978)
 * ---------------------------------------------------------------------------
 *
 * Suspension is a reversible status transition, not a deletion. The effects of
 * `users.status = 'suspended'` are:
 *
 *   - Login: existing sessions are revoked and new logins are refused. The
 *     account cannot authenticate until it is restored.
 *   - Bookings: no new bookings may be created. Bookings that are already
 *     `active` are NOT cancelled automatically; they must be resolved by an
 *     operator (completed, cancelled, or refunded) before suspension is allowed,
 *     so guests and hosts are never stranded mid-stay.
 *   - Messages: the account can no longer send messages; existing threads are
 *     retained for dispute and audit purposes.
 *   - Payments: payouts to the account are paused. Funds already owed are held,
 *     not forfeited, and are released only after restoration clears policy.
 *
 * Restoration re-enables login and messaging and resumes payouts, but it must
 * never restore access to data or funds improperly. Restoration is blocked
 * while the account is party to an active dispute, so held funds cannot be
 * released before the dispute is resolved.
 *
 * Both decisions are pure functions: no I/O, no environment reads. Persistence
 * and auditing live in the user moderation service.
 */

export const ASSIGNABLE_ROLES = [
  'tenant',
  'host',
  'admin',
  'moderator',
  'support',
  'finance',
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const UNPRIVILEGED_ROLES: readonly AssignableRole[] = ['tenant', 'host'];
export const PRIVILEGED_ROLES: readonly AssignableRole[] = [
  'admin',
  'moderator',
  'support',
  'finance',
];

export type RoleTransitionDenial =
  | 'ACTOR_NOT_ADMIN'
  | 'SELF_ROLE_CHANGE'
  | 'UNKNOWN_ROLE'
  | 'NO_CHANGE'
  | 'PRIVILEGED_TO_PRIVILEGED'
  | 'LAST_ADMIN';

/** Account statuses relevant to moderation. */
export const MODERATABLE_STATUSES = ['active', 'suspended'] as const;

export type ModeratableStatus = (typeof MODERATABLE_STATUSES)[number];

export function isModeratableStatus(value: unknown): value is ModeratableStatus {
  return typeof value === 'string' && (MODERATABLE_STATUSES as readonly string[]).includes(value);
}

export type SuspensionDenial =
  | 'ACTOR_NOT_ADMIN'
  | 'SELF_SUSPENSION'
  | 'UNKNOWN_STATUS'
  | 'ALREADY_SUSPENDED'
  | 'ACTIVE_BOOKINGS'
  | 'REASON_REQUIRED';

export type RestorationDenial =
  | 'ACTOR_NOT_ADMIN'
  | 'SELF_RESTORATION'
  | 'UNKNOWN_STATUS'
  | 'NOT_SUSPENDED'
  | 'ACTIVE_DISPUTES'
  | 'REASON_REQUIRED';

export type ModerationDecision<Denial extends string> =
  | { allowed: true }
  | { allowed: false; code: Denial; message: string };

export interface SuspensionInput {
  actorRole: string | null | undefined;
  actorId: string;
  targetId: string;
  /** Current `users.status` of the target. */
  targetStatus: string | null | undefined;
  /** Number of bookings currently in an `active` state for the target. */
  activeBookingCount: number;
  /** Operator-supplied reason; must be non-blank. */
  reason: string | null | undefined;
}

export interface RestorationInput {
  actorRole: string | null | undefined;
  actorId: string;
  targetId: string;
  /** Current `users.status` of the target. */
  targetStatus: string | null | undefined;
  /** Number of disputes currently open involving the target. */
  activeDisputeCount: number;
  /** Operator-supplied reason; must be non-blank. */
  reason: string | null | undefined;
}

function hasReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length > 0;
}

/**
 * Decide whether the target account may be suspended.
 * Pure function: no I/O, no environment reads.
 */
export function evaluateSuspension(input: SuspensionInput): ModerationDecision<SuspensionDenial> {
  if (input.actorRole !== 'admin') {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ADMIN',
      message: 'Only administrators can suspend accounts.',
    };
  }
  if (input.actorId === input.targetId) {
    return {
      allowed: false,
      code: 'SELF_SUSPENSION',
      message: 'You cannot suspend your own account.',
    };
  }
  if (!isModeratableStatus(input.targetStatus)) {
    return { allowed: false, code: 'UNKNOWN_STATUS', message: 'Unknown account status.' };
  }
  if (input.targetStatus === 'suspended') {
    return { allowed: false, code: 'ALREADY_SUSPENDED', message: 'Account is already suspended.' };
  }
  if (input.activeBookingCount > 0) {
    return {
      allowed: false,
      code: 'ACTIVE_BOOKINGS',
      message:
        'This account has active bookings. Resolve or cancel them before suspending the account.',
    };
  }
  if (!hasReason(input.reason)) {
    return { allowed: false, code: 'REASON_REQUIRED', message: 'A reason is required.' };
  }
  return { allowed: true };
}

/**
 * Decide whether the target account may be restored from suspension.
 * Restoration must not release held funds or data while a dispute is open.
 * Pure function: no I/O, no environment reads.
 */
export function evaluateRestoration(
  input: RestorationInput,
): ModerationDecision<RestorationDenial> {
  if (input.actorRole !== 'admin') {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ADMIN',
      message: 'Only administrators can restore accounts.',
    };
  }
  if (input.actorId === input.targetId) {
    return {
      allowed: false,
      code: 'SELF_RESTORATION',
      message: 'You cannot restore your own account.',
    };
  }
  if (!isModeratableStatus(input.targetStatus)) {
    return { allowed: false, code: 'UNKNOWN_STATUS', message: 'Unknown account status.' };
  }
  if (input.targetStatus !== 'suspended') {
    return { allowed: false, code: 'NOT_SUSPENDED', message: 'Account is not suspended.' };
  }
  if (input.activeDisputeCount > 0) {
    return {
      allowed: false,
      code: 'ACTIVE_DISPUTES',
      message:
        'This account is party to an active dispute. Resolve the dispute before restoring access.',
    };
  }
  if (!hasReason(input.reason)) {
    return { allowed: false, code: 'REASON_REQUIRED', message: 'A reason is required.' };
  }
  return { allowed: true };
}

export type RoleTransitionDecision =
  | { allowed: true }
  | { allowed: false; code: RoleTransitionDenial; message: string };

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

export interface RoleTransitionInput {
  actorRole: string | null | undefined;
  actorId: string;
  targetId: string;
  fromRole: string | null | undefined;
  toRole: unknown;
  /** Number of accounts currently holding the `admin` role. */
  adminCount: number;
}

/**
 * Decide whether `fromRole` -> `toRole` is allowed for this actor.
 * Pure function: no I/O, no environment reads.
 */
export function evaluateRoleTransition(input: RoleTransitionInput): RoleTransitionDecision {
  if (input.actorRole !== 'admin') {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ADMIN',
      message: 'Only administrators can change roles.',
    };
  }
  if (input.actorId === input.targetId) {
    return {
      allowed: false,
      code: 'SELF_ROLE_CHANGE',
      message: 'You cannot change your own role.',
    };
  }
  if (!isAssignableRole(input.toRole) || !isAssignableRole(input.fromRole)) {
    return { allowed: false, code: 'UNKNOWN_ROLE', message: 'Unknown role.' };
  }
  const from = input.fromRole;
  const to = input.toRole;
  if (from === to) {
    return { allowed: false, code: 'NO_CHANGE', message: 'User already has this role.' };
  }
  const fromPriv = (PRIVILEGED_ROLES as readonly string[]).includes(from);
  const toPriv = (PRIVILEGED_ROLES as readonly string[]).includes(to);
  if (fromPriv && toPriv) {
    return {
      allowed: false,
      code: 'PRIVILEGED_TO_PRIVILEGED',
      message: 'Change this user to a non-privileged role first, then to the new role.',
    };
  }
  if (from === 'admin' && input.adminCount <= 1) {
    return {
      allowed: false,
      code: 'LAST_ADMIN',
      message: 'The last administrator cannot be demoted.',
    };
  }
  return { allowed: true };
}
