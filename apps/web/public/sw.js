/**
 * Rentars Service Worker
 * 
 * Strategy:
 * - Static assets (JS, CSS, fonts, images): cache-first
 * - Navigation requests (HTML pages): network-first with offline fallback
 * - API calls: network-only (never serve stale data)
 *
 * Push (issue 074):
 * - `push`: render the notification the backend sent.
 * - `notificationclick`: focus an existing tab (or open one) at the payload URL.
 * - `pushsubscriptionchange`: the browser rotated our endpoint, so re-subscribe
 *   with the same application server key and tell the backend about it — the
 *   superseded endpoint must not keep receiving messages.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `rentars-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `rentars-runtime-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/offline.html',
  '/manifest.json',
];

// The application server key is not available inside a service worker, so the
// page that registers this script passes it on the script URL. See
// apps/web/src/app/layout.tsx.
const VAPID_PUBLIC_KEY = new URL(self.location.href).searchParams.get('vapidPublicKey') || '';

// Install: pre-cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Activate immediately without waiting for old SW to become idle
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== STATIC_CACHE && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  );
  // Take control of all clients immediately
  self.clients.claim();
});

// ── Push ──────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = {};

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Rentars', body: event.data.text() };
    }
  }

  const title = payload.title || 'Rentars';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/', ...(payload.data || {}) },
    tag: payload.data && payload.data.notificationId ? String(payload.data.notificationId) : undefined,
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).pathname === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // No matching tab: reuse any Rentars tab, otherwise open a new one.
      if (clients.length > 0 && 'focus' in clients[0]) {
        return clients[0].focus().then((focused) => focused && 'navigate' in focused
          ? focused.navigate(targetUrl)
          : focused);
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// The browser invalidated our subscription (key rotation, provider cleanup).
// Re-register with the same key and hand the backend the superseded endpoint.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(renewPushSubscription(event.newSubscription, event.oldSubscription));
});

async function renewPushSubscription(newSubscription, oldSubscription) {
  if (!VAPID_PUBLIC_KEY) {
    console.warn('[SW] Cannot renew push subscription: no application server key');
    return;
  }

  try {
    // Browsers may hand us the replacement subscription; otherwise subscribe
    // again with the same application server key.
    const subscription =
      newSubscription ||
      (await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      }));

    // The registration endpoint upserts by endpoint, so sending the superseded
    // endpoint lets the backend retire it in the same round trip.
    await fetch('/api/v1/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        previousEndpoint: oldSubscription ? oldSubscription.endpoint : undefined,
      }),
    });
  } catch (error) {
    console.error('[SW] Failed to renew push subscription:', error);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = self.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept API calls — always go to network
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // Static asset cache-first (JS, CSS, fonts, images, icons)
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Navigation requests: network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }
});

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/icons/') ||
    /\.(js|css|woff2?|ttf|otf|ico|png|jpg|jpeg|svg|webp|gif)$/.test(pathname)
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return nothing for failed static asset — browser handles gracefully
    return new Response('', { status: 408 });
  }
}

async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Try the runtime cache
    const cached = await caches.match(request);
    if (cached) return cached;

    // Fall back to offline page
    const offline = await caches.match('/offline.html');
    return offline || new Response('Offline', { status: 503 });
  }
}
