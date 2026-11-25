/**
 * Offline safety utilities - prevent unsafe mutations when offline.
 * Only safe read operations (search, view, filter) are allowed offline.
 * 
 * CACHEABLE DATA:
 * - Property search results (public, 5min TTL)
 * - Property details (public, 5min TTL)
 * - User preferences (user-scoped, session TTL)
 * 
 * NEVER CACHED (require online):
 * - Bookings, payments, refunds, wallet transactions
 * - Financial information and pricing
 * - Real-time availability
 */

const SAFE_OFFLINE_ACTIONS = ['search', 'view', 'read', 'filter', 'list', 'detail'];
const UNSAFE_OFFLINE_ACTIONS = ['book', 'pay', 'message', 'update', 'delete', 'create', 'refund', 'wallet', 'transaction'];

export interface OfflineCacheMetadata {
  scope: 'public' | 'user' | 'session';
  version: number;
  userId?: string;
  timestamp: number;
}

export function canPerformOfflineAction(
  action: string,
  isOnline: boolean
): boolean {
  if (isOnline) {
    return true;
  }

  const normalizedAction = action.toLowerCase();
  
  // Block all unsafe actions
  if (UNSAFE_OFFLINE_ACTIONS.some(unsafe => normalizedAction.includes(unsafe))) {
    return false;
  }
  
  // Allow only safe read operations
  return SAFE_OFFLINE_ACTIONS.some(safe => normalizedAction.includes(safe));
}

export function validateOnlineAction(
  action: string,
  isOnline: boolean,
  onError?: (message: string) => void
): boolean {
  if (!canPerformOfflineAction(action, isOnline)) {
    const message = `You cannot ${action} while offline. Please connect to the internet and try again.`;
    onError?.(message);
    return false;
  }

  return true;
}

export function getOfflineActionReason(action: string): string | null {
  if (UNSAFE_OFFLINE_ACTIONS.some(unsafe => action.includes(unsafe))) {
    return 'This action requires an internet connection for your security.';
  }

  return null;
}

export const OfflineActionMessages = {
  book: 'Booking requires an active internet connection.',
  pay: 'Payment transactions cannot be completed while offline.',
  refund: 'Refunds require an active internet connection.',
  wallet: 'Wallet transactions require an active internet connection.',
  transaction: 'Financial transactions cannot be completed while offline.',
  message: 'Messages cannot be sent offline.',
  update: 'Updates require an internet connection.',
  delete: 'Deletions require an internet connection.',
  create: 'This cannot be created offline.',
} as const;

/**
 * Validates if data is safe to cache based on type
 */
export function isCacheableData(dataType: string): boolean {
  const cacheableTypes = ['property-search', 'property-detail', 'user-preferences'];
  return cacheableTypes.includes(dataType);
}

/**
 * Creates cache metadata for offline storage
 */
export function createCacheMetadata(
  scope: 'public' | 'user' | 'session',
  userId?: string
): OfflineCacheMetadata {
  return {
    scope,
    version: 1,
    userId,
    timestamp: Date.now(),
  };
}

/**
 * Validates cache metadata for user scope
 */
export function validateCacheScope(
  metadata: OfflineCacheMetadata,
  currentUserId?: string
): boolean {
  // Public cache is always valid
  if (metadata.scope === 'public') {
    return true;
  }
  
  // User and session scope require matching user ID
  if (metadata.scope === 'user' || metadata.scope === 'session') {
    return metadata.userId === currentUserId;
  }
  
  return false;
}

/**
 * Calculates cache age in milliseconds
 */
export function getCacheAge(metadata: OfflineCacheMetadata): number {
  return Date.now() - metadata.timestamp;
}

/**
 * Determines if cache is stale based on TTL
 */
export function isCacheStale(metadata: OfflineCacheMetadata, ttlMs: number): boolean {
  return getCacheAge(metadata) > ttlMs;
}

// ─── Booking draft persistence ────────────────────────────────────────────────

/**
 * Fields that may be preserved as a local draft while the user is offline or
 * between sessions.  Payment data is intentionally excluded — card numbers,
 * wallet private keys, and XDR transactions must never be stored in localStorage.
 */
export interface BookingDraft {
  /** Storage key that also acts as an idempotency key once the user submits. */
  idempotencyKey: string;
  propertyId: string;
  checkIn: string;   // ISO date string YYYY-MM-DD
  checkOut: string;  // ISO date string YYYY-MM-DD
  guestCount: number;
  /** Unix ms when this draft was last saved. Used to detect staleness. */
  savedAt: number;
}

/** localStorage key prefix. The property ID is appended to scope drafts per listing. */
const DRAFT_KEY_PREFIX = 'rntr_booking_draft_';

/** Drafts older than 24 hours are considered stale and are discarded on load. */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a booking draft to localStorage.
 * Never call this with any payment or wallet data.
 */
export function saveDraft(draft: BookingDraft): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${DRAFT_KEY_PREFIX}${draft.propertyId}`, JSON.stringify(draft));
  } catch {
    // localStorage quota exceeded — silently ignore; the draft is advisory only.
  }
}

/**
 * Load the most recent draft for a given property.
 * Returns null if no draft exists or if it has exceeded DRAFT_TTL_MS.
 * Automatically removes an expired draft so it does not accumulate.
 */
export function loadDraft(propertyId: string): BookingDraft | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${propertyId}`);
    if (!raw) return null;
    const draft = JSON.parse(raw) as BookingDraft;
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${propertyId}`);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/**
 * Remove the draft for a property — call this after a successful submission
 * or when the user explicitly clears the form.
 */
export function clearDraft(propertyId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${propertyId}`);
  } catch {
    // ignore
  }
}

// ─── Stale-data marker ────────────────────────────────────────────────────────

/**
 * Mark cached availability / pricing data as stale so components that render
 * it can show an appropriate warning.  Uses sessionStorage so it clears on tab
 * close but persists across a disconnect/reconnect within the same session.
 */
const STALE_MARKER_KEY = 'rntr_data_stale';

export function markCachedDataStale(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(STALE_MARKER_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

export function clearStaleMarker(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(STALE_MARKER_KEY);
  } catch {
    // ignore
  }
}

export function isCachedDataStale(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(STALE_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}
