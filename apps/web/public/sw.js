/**
 * Rentars Service Worker
 *
 * Privacy-aware cache policy:
 * - Static assets (JS, CSS, fonts, images): cache-first (public, non-user-specific)
 * - Approved public pages: network-first with cached fallback (public content only)
 * - Authenticated / private pages (dashboards, bookings, profile): network-only,
 *   never written to persistent caches
 * - API calls: network-only (never serve stale data, never cached)
 *
 * User-specific caches are purged on logout / account switch via message events.
 * When offline, stale cached content is marked and unsafe mutations are disabled.
 */

// Version identifier. A build step may inject a concrete value by replacing the
// fallback below (e.g. `const CACHE_VERSION = 'v1.2.3';`). When no injection
// happens we fall back to a static version so the SW still works.
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `rentars-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `rentars-runtime-${CACHE_VERSION}`;
const PUBLIC_PAGE_CACHE = `rentars-public-pages-${CACHE_VERSION}`;

// Caches that may contain user-specific data and must be purged on logout/switch.
const USER_CACHES = [RUNTIME_CACHE, PUBLIC_PAGE_CACHE];

// When set (e.g. injected by a build), tells the page that an immediate reload
// is required for compatibility with the backend. Empty string means no forced
// reload is needed.
const REQUIRED_MIN_VERSION = '';

const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.json',
];

// Approved public pages that are safe to cache and serve offline.
// These must never contain authenticated or user-specific content.
const PUBLIC_PAGE_PATHS = [
  '/',
  '/about',
  '/contact',
  '/terms',
  '/privacy',
  '/offline.html',
];

// Path prefixes that are considered authenticated/private. Requests to these
// are always network-only and are never written to any cache.
const PRIVATE_PATH_PREFIXES = [
  '/dashboard',
  '/bookings',
  '/booking',
  '/profile',
  '/account',
  '/settings',
  '/admin',
  '/my-',
];

// Install: pre-cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(STATIC_ASSETS);
      } catch (err) {
        // Precache failed (e.g. flaky network). Abort the install so the
        // previous working version and its caches are retained.
        throw err;
      }
    })()
  );
});

// Activate: clean up obsolete caches, then take control of clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(
            (name) =>
              name !== STATIC_CACHE &&
              name !== RUNTIME_CACHE &&
              name !== PUBLIC_PAGE_CACHE
          )
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Message handler: lets the page request activation (SKIP_WAITING) and query
// the running version / compatibility requirements (GET_VERSION).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION') {
    const reply = {
      type: 'VERSION',
      version: CACHE_VERSION,
      requiredMinVersion: REQUIRED_MIN_VERSION,
      forceReload: Boolean(REQUIRED_MIN_VERSION),
    };
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
    } else if (event.source && event.source.postMessage) {
      event.source.postMessage(reply);
    }
  }
});

// Message handling: purge user-specific caches on logout / account switch.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const type = data.type;

  if (type === 'PURGE_USER_CACHES' || type === 'LOGOUT' || type === 'ACCOUNT_SWITCH') {
    event.waitUntil(
      purgeUserCaches().then(() => {
        if (event.source && event.source.postMessage) {
          event.source.postMessage({ type: 'USER_CACHES_PURGED' });
        }
      })
    );
  }
});

async function purgeUserCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => USER_CACHES.includes(name))
      .map((name) => caches.delete(name))
  );
}

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept API calls — always go to network, never cache
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // Never intercept non-GET requests (mutations) — always go to network
  if (request.method !== 'GET') {
    return;
  }

  // Private/authenticated paths: network-only, never cached
  if (isPrivatePath(url.pathname)) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Static asset cache-first (JS, CSS, fonts, images, icons)
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Approved public pages: network-first with cached fallback
  if (request.mode === 'navigate' && isPublicPage(url.pathname)) {
    event.respondWith(networkFirstPublicPage(request));
    return;
  }

  // All other navigation requests: network-only with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkOnlyWithOfflineFallback(request));
    return;
  }
});

function isPrivatePath(pathname) {
  return PRIVATE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isPublicPage(pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return PUBLIC_PAGE_PATHS.includes(normalized);
}

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

// Network-only: never read from or write to any cache.
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallbackResponse();
  }
}

// Network-only with offline fallback for non-public navigations.
async function networkOnlyWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallbackResponse();
  }
}

// Network-first for approved public pages, with cached fallback marked stale.
async function networkFirstPublicPage(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(PUBLIC_PAGE_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return markStale(cached);
    }
    return offlineFallbackResponse();
  }
}

// Clone a cached response and add a header marking it as stale/offline.
async function markStale(response) {
  const headers = new Headers(response.headers);
  headers.set('X-Rentars-Stale', 'true');
  headers.set('X-Rentars-Offline', 'true');
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function offlineFallbackResponse() {
  const offline = await caches.match('/offline.html');
  if (offline) {
    return markStale(offline);
  }
  return new Response('Offline', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain',
      'X-Rentars-Offline': 'true',
    },
  });
}
