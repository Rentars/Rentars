/**
 * Role and status types shared across backend services and middleware.
 *
 * The admin family is intentionally split into least-privilege roles:
 *  - `admin`      : full administrator, can perform every privileged operation.
 *  - `moderator`  : content/moderation operations (disputes, moderation actions).
 *  - `support`    : read-mostly support operations (inspect users, limited interventions).
 *  - `finance`    : payment/refund related operations.
 *
 * The permission matrix (see `permissions.ts`) maps each admin operation to the
 * roles allowed to perform it. These types are the single source of truth for
 * role names used by services, middleware, and route guards.
 */

/** Roles that grant access to the admin surface. */
export const ADMIN_ROLES = ['admin', 'moderator', 'support', 'finance'] as const;

/** All roles recognized by the system, including non-admin roles. */
export const USER_ROLES = ['user', 'admin', 'moderator', 'support', 'finance'] as const;

/** Lifecycle status of a user account. */
export const USER_STATUSES = ['active', 'suspended', 'deleted'] as const;

/** An admin-family role. */
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Any role a user account may hold. */
export type UserRole = (typeof USER_ROLES)[number];

/** The lifecycle status of a user account. */
export type UserStatus = (typeof USER_STATUSES)[number];

/** Type guard: is the given value an admin-family role? */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

/** Type guard: is the given value a recognized user role? */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Type guard: is the given value a recognized user status? */
export function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === 'string' && (USER_STATUSES as readonly string[]).includes(value);
}