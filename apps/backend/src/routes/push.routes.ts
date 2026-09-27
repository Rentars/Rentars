import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  getPushStatus,
  listPushSubscriptions,
  registerPushSubscription,
  unregisterAllPushSubscriptions,
  unregisterPushSubscription,
} from '../controllers/push.controller.js';

const router = Router();

// POST /api/push/subscribe — register a push subscription.
// Passing `previousEndpoint` retires the device's old endpoint in the same call,
// which is what a browser that refreshed its subscription needs.
router.post('/subscribe', authenticate, registerPushSubscription);

// POST /api/push/unsubscribe — unregister a push subscription
router.post('/unsubscribe', authenticate, unregisterPushSubscription);

// POST /api/push/unsubscribe-all — unregister every device (logout)
router.post('/unsubscribe-all', authenticate, unregisterAllPushSubscriptions);

// GET /api/push/subscriptions — list user's push subscriptions
router.get('/subscriptions', authenticate, listPushSubscriptions);

// GET /api/push/status?endpoint=... — lifecycle state for this device
router.get('/status', authenticate, getPushStatus);

export default router;
