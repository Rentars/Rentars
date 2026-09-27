import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  getPushSubscriptionStatus,
  getUserPushSubscriptions,
  removeAllPushSubscriptions,
  removePushSubscription,
  replacePushSubscription,
  savePushSubscription,
  validatePushSubscription,
  type PushPermission,
  type PushSubscription,
  type PushSubscriptionMetadata,
} from '../services/push.service.js';
import { toPublicSubscription } from '../services/push-crypto.js';

const PERMISSIONS = new Set<PushPermission>(['granted', 'denied', 'default']);

interface SubscribeBody {
  subscription?: unknown;
  /** Endpoint the browser is replacing, when it refreshed its subscription. */
  previousEndpoint?: unknown;
  /** `Notification.permission` as reported by the browser. */
  permission?: unknown;
  expirationTime?: unknown;
}

/**
 * Reads the optional, client-reported metadata attached to a registration.
 * Unknown permission values are dropped rather than rejected: a browser that
 * reports something new must not be unable to subscribe.
 */
function readMetadata(req: AuthRequest, body: SubscribeBody): PushSubscriptionMetadata {
  const userAgent = req.headers['user-agent'];
  const permission = typeof body.permission === 'string' ? (body.permission as PushPermission) : null;

  return {
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    permission: permission && PERMISSIONS.has(permission) ? permission : null,
    expirationTime: typeof body.expirationTime === 'number' ? body.expirationTime : null,
  };
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'Unauthorized' });
}

export async function registerPushSubscription(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const body = (req.body ?? {}) as SubscribeBody;
  const { subscription } = body;
  if (!subscription) {
    res.status(400).json({ error: 'subscription object is required' });
    return;
  }

  const validationError = validatePushSubscription(subscription);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const metadata = readMetadata(req, body);
  const previousEndpoint = typeof body.previousEndpoint === 'string' ? body.previousEndpoint : null;

  const result = previousEndpoint
    ? await replacePushSubscription(userId, previousEndpoint, subscription as PushSubscription, metadata)
    : await savePushSubscription(userId, subscription as PushSubscription, metadata);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json({
    message: 'Push subscription registered successfully',
    subscription: result.data,
    previousEndpointRetired: Boolean(previousEndpoint),
  });
}

export async function unregisterPushSubscription(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const { endpoint } = req.body;
  if (!endpoint || typeof endpoint !== 'string') {
    res.status(400).json({ error: 'endpoint (string) is required' });
    return;
  }

  const result = await removePushSubscription(userId, endpoint);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ message: 'Push subscription removed successfully' });
}

/**
 * POST /api/push/unsubscribe-all — used on logout so the device stops
 * receiving notifications for the account that just signed out.
 */
export async function unregisterAllPushSubscriptions(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const result = await removeAllPushSubscriptions(userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ message: 'All push subscriptions removed successfully' });
}

export async function listPushSubscriptions(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const result = await getUserPushSubscriptions(userId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  // Subscription secrets are never returned: clients already store them.
  const subscriptions = (result.data ?? [])
    .map((row) => toPublicSubscription(row))
    .filter((row) => row !== null);

  res.json({
    subscriptions,
    count: subscriptions.length,
  });
}

/**
 * GET /api/push/status[?endpoint=...] — lets the UI distinguish "this device is
 * subscribed" from "the browser holds a subscription the server no longer
 * knows about", which is what a device retired for failing delivery looks like.
 */
export async function getPushStatus(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : null;

  const result = await getPushSubscriptionStatus(userId, endpoint);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json(result.data);
}
