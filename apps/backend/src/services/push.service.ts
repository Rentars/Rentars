/**
 * Push notification service — stores browser push subscriptions and delivers
 * Web Push messages. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT
 * in .env to enable delivery. Falls back to a no-op when keys are not configured.
 */
import { createHmac, createSign, randomBytes } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { NotificationType } from './notification.service.js';

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface StoredPushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  data?: Record<string, unknown>;
}

const VAPID_TOKEN_EXPIRATION_HOURS = 12;

export async function savePushSubscription(
  userId: string,
  subscription: PushSubscription
): Promise<ServiceResponse<StoredPushSubscription>> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      { onConflict: 'user_id,endpoint' }
    )
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as StoredPushSubscription };
}

export async function getUserPushSubscriptions(
  userId: string
): Promise<ServiceResponse<StoredPushSubscription[]>> {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as StoredPushSubscription[] };
}

export async function removePushSubscription(
  userId: string,
  endpoint: string
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', endpoint);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

function buildVapidToken(endpoint: string): string | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@rentars.app';

  if (!publicKey || !privateKey) return null;

  const origin = new URL(endpoint).origin;
  const expiration = Math.floor(Date.now() / 1000) + VAPID_TOKEN_EXPIRATION_HOURS * 3600;

  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ aud: origin, exp: expiration, sub: subject })
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;

  try {
    const sign = createSign('SHA256');
    sign.update(signingInput);
    const signature = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');
    const jwt = `${signingInput}.${signature}`;
    return `vapid t=${jwt},k=${publicKey}`;
  } catch {
    return null;
  }
}

async function checkPushPreferences(
  userId: string,
  notificationType?: NotificationType
): Promise<boolean> {
  const { data: prefs, error } = await supabase
    .from('notification_preferences')
    .select('push_notifications, notification_types')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !prefs) {
    return true;
  }

  if (!prefs.push_notifications) {
    return false;
  }

  if (notificationType && prefs.notification_types) {
    const typeEnabled = (prefs.notification_types as Record<string, boolean>)[notificationType];
    return typeEnabled !== false;
  }

  return true;
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  notificationType?: NotificationType
): Promise<ServiceResponse<number>> {
  const hasPreference = await checkPushPreferences(userId, notificationType);
  if (!hasPreference) {
    console.log(
      `[PushService] Push notifications disabled for user ${userId} (type: ${notificationType ?? 'generic'})`
    );
    return { success: true, data: 0 };
  }

  const subsResult = await getUserPushSubscriptions(userId);
  if (!subsResult.success) return { success: false, error: subsResult.error };

  const subscriptions = subsResult.data ?? [];
  if (subscriptions.length === 0) return { success: true, data: 0 };

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log(
      `[PushService] VAPID keys not configured — skipping push notification for user ${userId}`
    );
    return { success: true, data: 0 };
  }

  const body = JSON.stringify(payload);
  let sent = 0;

  for (const sub of subscriptions) {
    const authorization = buildVapidToken(sub.endpoint);
    if (!authorization) continue;

    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          TTL: '86400',
        },
        body,
      });

      if (res.status === 410 || res.status === 404) {
        await removePushSubscription(userId, sub.endpoint);
      } else if (res.ok) {
        sent++;
      }
    } catch (err) {
      console.error(`[PushService] Failed to send push to ${sub.endpoint}:`, err);
    }
  }

  return { success: true, data: sent };
}

export function validatePushSubscription(subscription: unknown): string | null {
  if (!subscription || typeof subscription !== 'object') {
    return 'Invalid subscription object';
  }

  const sub = subscription as Record<string, unknown>;

  if (!sub.endpoint || typeof sub.endpoint !== 'string') {
    return 'endpoint is required and must be a string';
  }

  const endpoint = sub.endpoint.trim();
  if (!endpoint) {
    return 'endpoint cannot be blank';
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') {
      return 'endpoint must use HTTPS protocol';
    }
  } catch {
    return 'endpoint must be a valid HTTPS URL';
  }

  if (!sub.keys || typeof sub.keys !== 'object') {
    return 'keys object is required';
  }

  const keys = sub.keys as Record<string, unknown>;
  if (!keys.p256dh || typeof keys.p256dh !== 'string') {
    return 'keys.p256dh is required and must be a string';
  }

  if (!keys.auth || typeof keys.auth !== 'string') {
    return 'keys.auth is required and must be a string';
  }

  return null;
}

export { randomBytes, createHmac };
