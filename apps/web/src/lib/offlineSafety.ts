/**
 * Offline safety utilities - prevent unsafe mutations when offline.
 * Only safe read operations (search, view, filter) are allowed offline.
 */

const SAFE_OFFLINE_ACTIONS = ['search', 'view', 'read', 'filter', 'list', 'detail'];
const UNSAFE_OFFLINE_ACTIONS = ['book', 'pay', 'message', 'update', 'delete', 'create'];

export function canPerformOfflineAction(
  action: string,
  isOnline: boolean
): boolean {
  if (isOnline) {
    return true;
  }

  const normalizedAction = action.toLowerCase();
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
  message: 'Messages cannot be sent offline.',
  update: 'Updates require an internet connection.',
  delete: 'Deletions require an internet connection.',
  create: 'This cannot be created offline.',
} as const;
