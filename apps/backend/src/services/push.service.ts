/**
 * Push notification service — stores browser push subscriptions and delivers
 * Web Push messages. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT
 * in .env to enable delivery. Falls back to a no-op when keys are not configured.
 *
 * Subscription lifecycle (issue 074):
 *   - register   → `savePushSubscription` upserts by endpoint, so re-registering
 *                  a device transfers it to the account that is using it now.
 *   - replace    → `replacePushSubscription` retires the previous endpoint and
 *                  registers the new one when a browser rotates its endpoint.
 *   - remove     → `removePushSubscription` (one device) and
 *                  `removeAllPushSubscriptions` (logout / account deletion).
 *   - cleanup    → endpoints the push service rejects are retired automatically;
 *                  endpoints that have not been seen for months are collected by
 *                  the retention job (`purgeStalePushSubscriptions`).
 */
import { createHmac, createSign, randomBytes } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { NotificationType } from './notification.service.js';
import {
  decryptPushKey,
  encryptPushKey,
  toPublicSubscription,
  type PublicPushSubscription,
  type StoredSubscriptionRow,
} from './push-crypto.js';

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
  user_agent?: string | null;
  permission?: PushPermission | null;
  expiration_time?: string | null;
  last_seen_at?: string | null;
  created_at?: string;
}

/** Notification permission reported by the browser: `Notification.permission`. */
export type PushPermission = 'granted' | 'denied' | 'default';

export interface PushSubscriptionMetadata {
  userAgent?: string | null;
  permission?: PushPermission | null;
  /** `PushSubscription.expirationTime` (epoch ms) when the browser provides one. */
  expirationTime?: number | null;
}

export interface PushSubscriptionStatus {
  /** True when the given endpoint (or any endpoint) is registered for this user. */
  has_subscription: boolean;
  subscription_count: number;
  endpoint: string | null;
  permission: PushPermission | null;
  last_seen_at: string | null;
  subscription: PublicPushSubscription | null;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
  data?: Record<string, unknown>;
}

const VAPID_TOKEN_EXPIRATION_HOURS = 12;

/** Endpoints are long-lived URLs; anything beyond this is malformed or hostile. */
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_KEY_LENGTH = 512;

/**
 * Consecutive transient failures allowed before an endpoint is retired. Push
 * services return 5xx/429 for outages and rate limits, so a single failure must
 * not cost the user their notifications — a persistently failing endpoint does.
 */
export const MAX_TRANSIENT_FAILURES = 5;

/** Providers use these to say "this endpoint is gone, stop using it". */
const PERMANENT_FAILURE_STATUSES = new Set([400, 401, 403, 404, 410, 413]);

/**
 * Providers we must never POST to on a user's behalf. Registration is
 * user-controlled, so without this check any account could turn the push
 * worker into a request forwarder against internal services (SSRF).
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

const KEY_CHARSET = /^[A-Za-z0-9\-_+/=]+$/;

/**
 * In-memory tally of consecutive transient delivery failures per endpoint.
 * Deliberately not persisted: it only has to outlive a provider outage, and a
 * process restart legitimately gives an endpoint a fresh chance.
 */
const transientFailures = new Map<string, number>();

/** Test seam — clears the in-process failure tally. */
export function resetTransientPushFailures(): void {
  transientFailures.clear();
}

export function getTransientPushFailureCount(endpoint: string): number {
  return transientFailures.get(endpoint) ?? 0;
}

export async function savePushSubscription(
  userId: string,
  subscription: PushSubscription,
  metadata: PushSubscriptionMetadata = {}
): Promise<ServiceResponse<PublicPushSubscription>> {
  const validationError = validatePushSubscription(subscription);
  if (validationError) return { success: false, error: validationError };

  const endpoint = subscription.endpoint.trim();
  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint,
        // Encrypted at rest when PUSH_KEY_ENCRYPTION_SECRET is configured.
        p256dh: encryptPushKey(subscription.keys.p256dh.trim()),
        auth: encryptPushKey(subscription.keys.auth.trim()),
        user_agent: metadata.userAgent ?? null,
        permission: metadata.permission ?? null,
        expiration_time: toIsoString(metadata.expirationTime),
        last_seen_at: new Date().toISOString(),
      },
      // `endpoint` is globally unique: a device that signs in as somebody else
      // transfers its subscription instead of leaving the old account able to
      // push to it.
      { onConflict: 'endpoint' }
    )
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  transientFailures.delete(endpoint);
  return { success: true, data: toPublicSubscription(data as StoredSubscriptionRow) };
}

/**
 * Swaps a device's previous endpoint for a new one. Browsers hand out a new
 * endpoint when a subscription is refreshed (`pushsubscriptionchange`), and
 * without this the abandoned endpoint would keep receiving messages.
 */
export async function replacePushSubscription(
  userId: string,
  previousEndpoint: string | null | undefined,
  subscription: PushSubscription,
  metadata: PushSubscriptionMetadata = {}
): Promise<ServiceResponse<PublicPushSubscription>> {
  const nextEndpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : '';

  if (previousEndpoint && previousEndpoint.trim() && previousEndpoint.trim() !== nextEndpoint) {
    await removePushSubscription(userId, previousEndpoint.trim());
  }

  return savePushSubscription(userId, subscription, metadata);
}

/** Removes one device. Idempotent: an endpoint that is already gone is success. */
export async function removePushSubscription(
  userId: string,
  endpoint: string
): Promise<ServiceResponse<void>> {
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (!trimmed) return { success: false, error: 'endpoint is required' };

  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('endpoint', trimmed);

  if (error) return { success: false, error: error.message };
  transientFailures.delete(trimmed);
  return { success: true };
}

/**
 * Removes every device the user has registered. Used on logout and account
 * deletion so the browser cannot keep receiving pushes for that account.
 */
export async function removeAllPushSubscriptions(
  userId: string
): Promise<ServiceResponse<void>> {
  const { error } = await supabase.from('push_subscriptions').delete().eq('user_id', userId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Alias kept for the privacy (account deletion) flow. */
export const purgeUserPushSubscriptions = removeAllPushSubscriptions;

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

export function getActivePushSubscriptions(
  subscriptions: StoredPushSubscription[]
): StoredPushSubscription[] {
  return subscriptions.filter((subscription) => !isRetiredSubscription(subscription));
}

/** Rows written before the lifecycle migration have no `retired_at`: they are live. */
function isRetiredSubscription(subscription: StoredPushSubscription): boolean {
  const retiredAt = (subscription as { retired_at?: string | null }).retired_at;
  return typeof retiredAt === 'string' && retiredAt.length > 0;
}

/**
 * Subscription state for the current user, optionally scoped to the endpoint
 * their browser is actually holding. `has_subscription: false` for a held
 * endpoint is what lets the UI say "this device is out of sync — re-enable it".
 */
export async function getPushSubscriptionStatus(
  userId: string,
  endpoint?: string | null
): Promise<ServiceResponse<PushSubscriptionStatus>> {
  const result = await getUserPushSubscriptions(userId);
  if (!result.success) return { success: false, error: result.error };

  const active = getActivePushSubscriptions(result.data ?? []);
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  const match = trimmed ? active.find((row) => row.endpoint === trimmed) : undefined;
  const reference = match ?? active[0];

  return {
    success: true,
    data: {
      has_subscription: trimmed ? Boolean(match) : active.length > 0,
      subscription_count: active.length,
      endpoint: reference?.endpoint ?? null,
      permission: (reference?.permission as PushPermission | null | undefined) ?? null,
      last_seen_at: reference?.last_seen_at ?? null,
      subscription: toPublicSubscription((match ?? null) as StoredSubscriptionRow | null),
    },
  };
}

/**
 * Retires an endpoint after delivery failure. Permanent rejections retire
 * immediately; transient ones retire once they have failed `MAX_TRANSIENT_FAILURES`
 * times in a row. Returns true when the endpoint was retired.
 */
async function handleDeliveryFailure(
  userId: string,
  endpoint: string,
  status: number
): Promise<boolean> {
  if (PERMANENT_FAILURE_STATUSES.has(status)) {
    await removePushSubscription(userId, endpoint);
    console.log(`[PushService] Retired rejected endpoint ${endpoint} (status ${status})`);
    return true;
  }

  const failures = (transientFailures.get(endpoint) ?? 0) + 1;

  if (failures >= MAX_TRANSIENT_FAILURES) {
    await removePushSubscription(userId, endpoint);
    console.log(
      `[PushService] Retired endpoint ${endpoint} after ${failures} consecutive delivery failures (status ${status})`
    );
    return true;
  }

  transientFailures.set(endpoint, failures);
  return false;
}

function toIsoString(epochMs: number | null | undefined): string | null {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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

  const subscriptions = getActivePushSubscriptions(subsResult.data ?? []);
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

    // Decrypt just in time: the keys never leave memory in plaintext.
    try {
      decryptPushKey(sub.p256dh);
      decryptPushKey(sub.auth);
    } catch (err) {
      console.error(`[PushService] Unreadable keys for ${sub.endpoint}:`, err);
      await removePushSubscription(userId, sub.endpoint);
      continue;
    }

    let status = 0;

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

      status = res.status;

      if (res.ok) {
        transientFailures.delete(sub.endpoint);
        sent++;
        continue;
      }
    } catch (err) {
      console.error(`[PushService] Failed to send push to ${sub.endpoint}:`, err);
    }

    await handleDeliveryFailure(userId, sub.endpoint, status);
  }

  return { success: true, data: sent };
}

/**
 * Validates an incoming subscription payload. Returns null when valid, or the
 * reason it was rejected. Security-relevant: `endpoint` is fetched by this
 * server when delivering a push, so internal and private hosts are refused.
 */
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

  let url: URL;
  try {
    url = new URL(endpoint);
    if (url.protocol !== 'https:') {
      return 'endpoint must use HTTPS protocol';
    }
  } catch {
    return 'endpoint must be a valid HTTPS URL';
  }

  if (endpoint.length > MAX_ENDPOINT_LENGTH) {
    return `endpoint must be at most ${MAX_ENDPOINT_LENGTH} characters`;
  }

  const blockedHost = blockedEndpointHost(url.hostname);
  if (blockedHost) {
    return `endpoint host is not allowed: ${blockedHost}`;
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

  const p256dh = keys.p256dh.trim();
  const auth = keys.auth.trim();

  const p256dhError = validateSubscriptionKey('keys.p256dh', p256dh);
  if (p256dhError) return p256dhError;

  const authError = validateSubscriptionKey('keys.auth', auth);
  if (authError) return authError;

  return null;
}

function validateSubscriptionKey(label: string, value: string): string | null {
  if (value.length > MAX_KEY_LENGTH) {
    return `${label} must be at most ${MAX_KEY_LENGTH} characters`;
  }

  if (!KEY_CHARSET.test(value)) {
    return `${label} must be a valid base64 encoded key`;
  }

  return null;
}

/** Returns the offending hostname when an endpoint must not be contacted. */
export function blockedEndpointHost(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return hostname;

  if (BLOCKED_HOSTNAMES.has(host)) return host;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return host;

  // IPv6 loopback / unspecified / unique-local ranges.
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return host;
  }

  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) return host;

  return null;
}

export { randomBytes, createHmac };
