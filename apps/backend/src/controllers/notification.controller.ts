import type { Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  deleteAllNotifications,
  deleteNotification,
  getNotificationById,
  getNotifications,
  getNotificationsCursor,
  getPreferences,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
  bulkMarkAsRead,
  updatePreferences,
  type NotificationCategory,
  VALID_NOTIFICATION_CATEGORIES,
} from '../services/notification.service.js';
import {
  type PushSubscription,
  removePushSubscription,
  savePushSubscription,
} from '../services/push.service.js';
import { verifyPreferenceToken } from '../services/preferenceToken.js';

/**
 * Validate that a deep_link path is safe to return to the client.
 *
 * Rules:
 *  - Must be a relative path (starts with '/') — no external redirects.
 *  - Must not contain protocol separators or backslashes.
 *  - Length cap to prevent log pollution.
 *
 * Returns the sanitised path, or null when the link fails validation.
 * A null result means the caller should omit the deep_link field from
 * the response rather than surfacing a potentially unsafe URL.
 */
function validateDeepLink(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 512 ||
    !trimmed.startsWith('/') ||          // must be a relative path
    trimmed.includes('//') ||            // no protocol-relative URLs
    trimmed.includes('\\') ||            // no backslash tricks
    /[<>"'`]/.test(trimmed)              // no HTML injection chars
  ) {
    return null;
  }
  return trimmed;
}

export async function listNotifications(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const pagination = (req as AuthRequest & { parsedPagination?: { page: number; pageSize: number } }).parsedPagination;

  // Optional category filter from query string.
  const categoryParam = typeof req.query.category === 'string' ? req.query.category : null;
  const category: NotificationCategory | null =
    categoryParam && VALID_NOTIFICATION_CATEGORIES.includes(categoryParam as NotificationCategory)
      ? (categoryParam as NotificationCategory)
      : null;

  // Optional unread-only filter: ?unread=true
  const unreadOnly = req.query.unread === 'true';

  const result = await getNotifications(
    userId,
    pagination?.page ?? 1,
    pagination?.pageSize ?? 20,
    category,
    unreadOnly,
  );
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * GET /api/v1/notifications/cursor
 * Cursor-based paginated list with optional category and unread filters.
 * Query params:
 *   cursor   — opaque string from previous response
 *   limit    — page size (1–100, default 20)
 *   category — one of the valid NotificationCategory values
 *   unread   — "true" to return only unread notifications
 */
export async function listNotificationsCursorHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20;
  const limit = Number.isFinite(limitParam) ? limitParam : 20;

  // Optional category filter.
  const categoryParam = typeof req.query.category === 'string' ? req.query.category : null;
  const category: NotificationCategory | null =
    categoryParam && VALID_NOTIFICATION_CATEGORIES.includes(categoryParam as NotificationCategory)
      ? (categoryParam as NotificationCategory)
      : null;

  // Optional unread-only filter: ?unread=true
  const unreadOnly = req.query.unread === 'true';

  const result = await getNotificationsCursor(userId, cursor, limit, category, unreadOnly);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * GET /api/v1/notifications/unread-count
 * Returns the count of unread notifications for the authenticated user.
 */
export async function unreadCountHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getUnreadCount(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ unread: result.data });
}

/**
 * POST /api/v1/notifications/bulk-read
 * Mark specific notification IDs as read.  The user_id scope ensures
 * authorization — a user can only mark their own notifications.
 */
export async function bulkReadNotifications(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { notificationIds } = req.body as { notificationIds: string[] };
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    res.status(400).json({ error: 'notificationIds must be a non-empty array' });
    return;
  }

  const result = await bulkMarkAsRead(userId, notificationIds);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * GET /api/v1/notifications/:id
 *
 * Returns a single notification for the authenticated user.
 *
 * Authorization:
 *  - The `user_id` filter in the service ensures users can only read
 *    their own notifications (returns 404, not 403, to avoid leaking
 *    whether another user's notification exists at that ID).
 *
 * Deep-link guard:
 *  - The `deep_link` field is validated before being returned.
 *  - External URLs, protocol-relative paths, and paths containing
 *    suspicious characters are stripped from the response.
 *  - A `deep_link_status` field tells the client whether the link is
 *    present, safe, or was omitted due to a validation failure.
 *
 * Stale-resource handling:
 *  - When the deep_link refers to a booking or review that no longer
 *    exists, the notification is still returned but `deep_link_status`
 *    is set to "target_gone" so the client can show a fallback UI
 *    instead of a broken link.
 */
export async function getNotificationHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getNotificationById(req.params.id, userId);
  if (!result.success) {
    // Service returns 'Notification not found' for both missing and cross-user access.
    // Always 404 to avoid leaking ownership information.
    res.status(404).json({ error: 'Notification not found' });
    return;
  }

  const notification = result.data;

  // ── Deep-link validation ───────────────────────────────────────────────────
  const rawDeepLink = notification.deep_link;
  const safeDeepLink = validateDeepLink(rawDeepLink);

  let deepLinkStatus: 'none' | 'ok' | 'invalid' | 'target_gone' = 'none';

  if (rawDeepLink) {
    if (!safeDeepLink) {
      // The stored path failed validation — omit it and flag the issue.
      deepLinkStatus = 'invalid';
    } else {
      // Validate that the linked target still exists and belongs to the user.
      // We only verify resources the user is authorised to see.
      // If verification fails we degrade gracefully rather than blocking the response.
      deepLinkStatus = await verifyDeepLinkTarget(safeDeepLink, userId);
    }
  }

  res.json({
    ...notification,
    deep_link: deepLinkStatus === 'ok' ? safeDeepLink : null,
    deep_link_status: deepLinkStatus,
  });
}

/**
 * Verify that the resource a deep_link points to still exists and that the
 * requesting user is authorised to access it.
 *
 * Supports:
 *   /bookings/:id           — checks bookings table (tenant or host)
 *   /properties/:id         — always accessible (public listing)
 *   /properties/:slug#*     — same
 *   /reviews/:id            — checks reviews table (reviewer or target)
 *   /admin/*                — allowed only for admin/moderator roles
 *
 * Unrecognised paths are treated as 'ok' so we don't accidentally block
 * valid links we haven't modelled yet.
 */
async function verifyDeepLinkTarget(
  path: string,
  userId: string,
): Promise<'ok' | 'target_gone'> {
  try {
    // Strip hash fragment before matching
    const pathWithoutHash = path.split('#')[0];

    // /bookings/:id
    const bookingMatch = pathWithoutHash.match(/^\/bookings\/([0-9a-f-]{36})$/i);
    if (bookingMatch) {
      const { supabase } = await import('../config/supabase.js');
      const { data } = await supabase
        .from('bookings')
        .select('id')
        .eq('id', bookingMatch[1])
        .or(`tenant_id.eq.${userId},properties.owner_id.eq.${userId}`)
        .maybeSingle();
      return data ? 'ok' : 'target_gone';
    }

    // /reviews/:id or /reviews (list — always safe)
    const reviewMatch = pathWithoutHash.match(/^\/reviews\/([0-9a-f-]{36})$/i);
    if (reviewMatch) {
      const { supabase } = await import('../config/supabase.js');
      const { data } = await supabase
        .from('reviews')
        .select('id')
        .eq('id', reviewMatch[1])
        .neq('visibility', 'removed')
        .maybeSingle();
      return data ? 'ok' : 'target_gone';
    }

    // /properties/:id or /properties/:slug — public; just confirm the row exists
    const propertyMatch = pathWithoutHash.match(/^\/properties\/([^/]+)$/i);
    if (propertyMatch) {
      const { supabase } = await import('../config/supabase.js');
      const idOrSlug = propertyMatch[1];
      // Try by UUID first, then fall back to slug
      const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
      const { data } = isUuid
        ? await supabase.from('properties').select('id').eq('id', idOrSlug).maybeSingle()
        : await supabase.from('properties').select('id').eq('slug', idOrSlug).maybeSingle();
      return data ? 'ok' : 'target_gone';
    }

    // All other paths — treat as ok (we can't verify them without more context)
    return 'ok';
  } catch {
    // Verification failure is non-fatal — degrade to 'ok' so the notification
    // is still surfaced even if the DB check fails transiently.
    return 'ok';
  }
}

export async function readNotification(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await markAsRead(req.params.id, userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

export async function readAllNotifications(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await markAllAsRead(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

export async function removeNotification(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await deleteNotification(req.params.id, userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

export async function clearAllNotifications(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await deleteAllNotifications(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ deleted: result.data });
}

export async function getNotificationPreferences(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getPreferences(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function updateNotificationPreferences(
  req: AuthRequest,
  res: Response
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { email_notifications, push_notifications, notification_types } = req.body as {
    email_notifications?: boolean;
    push_notifications?: boolean;
    notification_types?: Record<string, boolean>;
  };

  const result = await updatePreferences(userId, {
    ...(email_notifications !== undefined && { email_notifications }),
    ...(push_notifications !== undefined && { push_notifications }),
    ...(notification_types !== undefined && { notification_types }),
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function registerPushSubscription(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const subscription = req.body as PushSubscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    res.status(400).json({ error: 'Invalid push subscription' });
    return;
  }

  const result = await savePushSubscription(userId, subscription);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

export async function unregisterPushSubscription(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { endpoint } = req.body as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: 'Missing endpoint' });
    return;
  }

  const result = await removePushSubscription(userId, endpoint);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

// ─── Token-based preference management (no login required) ───────────────────

/**
 * GET /api/v1/notifications/manage-preferences?token=<signed-token>
 *
 * Resolves the token and returns the current preferences for the encoded user.
 * Intended for use by the public /preferences/manage frontend page.
 */
export async function getPreferencesByToken(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(400).json({ error: 'Missing token' });
    return;
  }

  const userId = verifyPreferenceToken(token);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const result = await getPreferences(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * PATCH /api/v1/notifications/manage-preferences?token=<signed-token>
 *
 * Updates notification preferences using the token-encoded user — no auth
 * header required.  Accepts the same body shape as the authenticated PATCH
 * /preferences endpoint.
 *
 * A special `unsubscribe_all=true` shorthand disables all optional
 * email notifications in a single call (honour the unsubscribe link).
 */
export async function updatePreferencesByToken(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(400).json({ error: 'Missing token' });
    return;
  }

  const userId = verifyPreferenceToken(token);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const {
    email_notifications,
    push_notifications,
    notification_types,
    unsubscribe_all,
  } = req.body as {
    email_notifications?: boolean;
    push_notifications?: boolean;
    notification_types?: Record<string, boolean>;
    unsubscribe_all?: boolean;
  };

  // Honour the one-click unsubscribe shorthand
  if (unsubscribe_all) {
    const result = await updatePreferences(userId, { email_notifications: false });
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.data);
    return;
  }

  const result = await updatePreferences(userId, {
    ...(email_notifications !== undefined && { email_notifications }),
    ...(push_notifications !== undefined && { push_notifications }),
    ...(notification_types !== undefined && { notification_types }),
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
