'use client';

import { useCallback, useEffect, useState } from 'react';

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** `Notification.permission`, plus `unsupported` for browsers without push. */
export type PushPermissionState = 'unsupported' | 'denied' | 'default' | 'granted';

/**
 * What the UI needs to say about this device:
 *   checking           — reading the browser + server state
 *   unsupported        — no service worker or Push API
 *   permission_denied  — the user blocked notifications in the browser
 *   permission_required— notification permission has not been asked for yet
 *   subscribed         — this device is registered and the server agrees
 *   not_subscribed     — no subscription for this device
 *   out_of_sync        — the browser holds a subscription the server retired
 *                        (for example after repeated delivery failures)
 *   error              — the last operation failed; `error` has the detail
 */
export type PushSubscriptionState =
  | 'checking'
  | 'unsupported'
  | 'permission_denied'
  | 'permission_required'
  | 'subscribed'
  | 'not_subscribed'
  | 'out_of_sync'
  | 'error';

export interface UsePushNotificationsReturn {
  isSupported: boolean;
  isSubscribed: boolean;
  isLoading: boolean;
  permission: PushPermissionState;
  status: PushSubscriptionState;
  endpoint: string | null;
  error: string | null;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePushNotifications(): UsePushNotificationsReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [permission, setPermission] = useState<PushPermissionState>('unsupported');
  const [status, setStatus] = useState<PushSubscriptionState>('checking');
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Reads the browser's state and checks it against the server's records. */
  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setIsSupported(false);
      setPermission('unsupported');
      setStatus('unsupported');
      setIsSubscribed(false);
      return;
    }

    setIsSupported(true);

    const browserPermission: PushPermissionState =
      typeof Notification === 'undefined' ? 'default' : (Notification.permission as PushPermissionState);
    setPermission(browserPermission);

    if (browserPermission === 'denied') {
      setStatus('permission_denied');
      setIsSubscribed(false);
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        setEndpoint(null);
        setIsSubscribed(false);
        setStatus('not_subscribed');
        return;
      }

      setEndpoint(subscription.endpoint);
      setIsSubscribed(true);
      setStatus('subscribed');

      // The browser can hold a subscription the server has already retired, so
      // confirm the endpoint is still on file before claiming we are in sync.
      const response = await fetch(
        `/api/v1/push/status?endpoint=${encodeURIComponent(subscription.endpoint)}`,
        { credentials: 'include' }
      );

      if (!response.ok) return;

      const body = (await response.json()) as { has_subscription?: boolean };
      if (body.has_subscription === false) {
        setStatus('out_of_sync');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read push subscription';
      setError(message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    if (!isSupported) {
      setError('Push notifications are not supported in this browser');
      setStatus('unsupported');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      let browserPermission =
        typeof Notification === 'undefined' ? 'default' : Notification.permission;

      if (browserPermission === 'denied') {
        setPermission('denied');
        setStatus('permission_denied');
        throw new Error('Notifications are blocked for this site in your browser settings');
      }

      if (browserPermission === 'default') {
        browserPermission = await Notification.requestPermission();
        setPermission(browserPermission as PushPermissionState);

        if (browserPermission !== 'granted') {
          setStatus('permission_denied');
          throw new Error('Notification permission was not granted');
        }
      }

      const registration = await navigator.serviceWorker.ready;
      const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

      if (!vapidPublicKey) {
        throw new Error('VAPID public key is not configured');
      }

      // Any endpoint we already hold is superseded by the new one, and the
      // server retires it so the old endpoint cannot keep pushing.
      const existing = await registration.pushManager.getSubscription();

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const response = await fetch('/api/v1/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          previousEndpoint: existing && existing.endpoint !== subscription.endpoint
            ? existing.endpoint
            : undefined,
          permission: browserPermission,
          expirationTime: subscription.expirationTime,
        }),
        credentials: 'include',
      });

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new Error(detail ?? `Failed to register subscription: ${response.statusText}`);
      }

      setEndpoint(subscription.endpoint);
      setIsSubscribed(true);
      setStatus('subscribed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to subscribe to push notifications';
      setError(message);
      setStatus((current) => (current === 'permission_denied' ? current : 'error'));
      console.error('[PushNotifications] Subscribe error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  const unsubscribe = useCallback(async () => {
    if (!isSupported) {
      setError('Push notifications are not supported in this browser');
      setStatus('unsupported');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        setIsSubscribed(false);
        setStatus('not_subscribed');
        return;
      }

      const response = await fetch('/api/v1/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        credentials: 'include',
      });

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new Error(detail ?? `Failed to unregister subscription: ${response.statusText}`);
      }

      // The browser subscription is dropped last: if the server call fails we
      // still know about this device and can retry the cleanup.
      await subscription.unsubscribe();

      setEndpoint(null);
      setIsSubscribed(false);
      setStatus('not_subscribed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to unsubscribe from push notifications';
      setError(message);
      setStatus('error');
      console.error('[PushNotifications] Unsubscribe error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  return {
    isSupported,
    isSubscribed,
    isLoading,
    permission,
    status,
    endpoint,
    error,
    subscribe,
    unsubscribe,
    refresh,
  };
}

async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: string | { message?: string } };
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error.message === 'string') return body.error.message;
    return null;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
