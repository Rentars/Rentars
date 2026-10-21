import { Router } from 'express';
import {
  clearAllNotifications,
  getNotificationPreferences,
  getNotificationHandler,
  getPreferencesByToken,
  listNotifications,
  listNotificationsCursorHandler,
  unreadCountHandler,
  bulkReadNotifications,
  readAllNotifications,
  readNotification,
  registerPushSubscription,
  removeNotification,
  unregisterPushSubscription,
  updateNotificationPreferences,
  updatePreferencesByToken,
} from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validatePagination } from '../validators/pagination.validator.js';
import { bulkMarkAsReadSchema } from '../validators/notification.validator.js';
import { validateBody } from '../validators/booking.validator.js';

const router = Router();

// ─── Static paths must be registered before /:id ─────────────────────────────
// Express matches routes in order of registration. Any literal path segment
// that could be confused with a UUID param (cursor, unread-count, preferences,
// manage-preferences, bulk-read, read-all, clear-all, push/*) must be declared
// before the wildcard GET /:id route.

// GET /api/v1/notifications  (supports ?category=, ?unread=true, ?page=, ?pageSize=)
router.get('/', authenticate, validatePagination, listNotifications);

// GET /api/v1/notifications/cursor  (cursor pagination; ?category=, ?unread=true, ?limit=)
router.get('/cursor', authenticate, listNotificationsCursorHandler);

// GET /api/v1/notifications/unread-count
router.get('/unread-count', authenticate, unreadCountHandler);

// POST /api/v1/notifications/bulk-read
router.post('/bulk-read', authenticate, validateBody(bulkMarkAsReadSchema), bulkReadNotifications);

// PATCH /api/v1/notifications/read-all
router.patch('/read-all', authenticate, readAllNotifications);

// DELETE /api/v1/notifications/clear-all
router.delete('/clear-all', authenticate, clearAllNotifications);

// GET /api/v1/notifications/preferences  (authenticated)
router.get('/preferences', authenticate, getNotificationPreferences);

// PATCH /api/v1/notifications/preferences  (authenticated)
router.patch('/preferences', authenticate, updateNotificationPreferences);

// GET  /api/v1/notifications/manage-preferences?token=...  (token-based, no login)
router.get('/manage-preferences', getPreferencesByToken);

// PATCH /api/v1/notifications/manage-preferences?token=...  (token-based, no login)
router.patch('/manage-preferences', updatePreferencesByToken);

// POST /api/v1/notifications/push/subscribe
router.post('/push/subscribe', authenticate, registerPushSubscription);

// POST /api/v1/notifications/push/unsubscribe
router.post('/push/unsubscribe', authenticate, unregisterPushSubscription);

// ─── Parameterised routes (after all static paths) ────────────────────────────

// GET /api/v1/notifications/:id
// Ownership-scoped single fetch with deep-link validation and target-existence check.
// Returns 404 for both missing and cross-user notifications to prevent info leakage.
router.get('/:id', authenticate, getNotificationHandler);

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', authenticate, readNotification);

// DELETE /api/v1/notifications/:id
router.delete('/:id', authenticate, removeNotification);

export default router;
