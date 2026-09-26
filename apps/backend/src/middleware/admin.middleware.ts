/**
 * @deprecated Use `requireAdminRole` from `adminScope.middleware.ts` instead.
 *
 * This file is kept for backwards compatibility. It re-exports `requireAdminRole`
 * (which accepts the full admin-family role set: admin | moderator | support | finance)
 * and the `AdminRequest` type from the new scoped middleware.
 *
 * Old single-role check (role === 'admin' only) has been replaced with the
 * multi-role system. Any route that was previously using `requireAdmin` should
 * be migrated to `requireAdminRole` + `requireScope(scope)`.
 */

export {
  requireAdminRole as requireAdmin,
  type AdminRequest,
} from './adminScope.middleware.js';
