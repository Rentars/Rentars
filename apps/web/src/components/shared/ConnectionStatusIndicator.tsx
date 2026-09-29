'use client';

import type { ConnectionStatus } from '@/hooks/useRealTimeUpdates';
import { CloudOff, RefreshCw, Wifi, WifiOff } from 'lucide-react';

interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus;
  /** If true, show a text label beside the icon. Defaults to false. */
  showLabel?: boolean;
  className?: string;
  /**
   * Consecutive reconnect attempts made. When supplied alongside a
   * `reconnecting` status, the label shows the attempt counter.
   */
  retryAttempt?: number;
  /** Retries left before automatic reconnection stops. */
  retriesRemaining?: number;
}

const CONFIG = {
  connected: {
    icon: Wifi,
    label: 'Live',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    title: 'Real-time updates connected',
  },
  stale: {
    icon: CloudOff,
    label: 'Syncing…',
    dot: 'bg-sky-400',
    text: 'text-sky-600 dark:text-sky-400',
    title: 'Reconnected — catching up on missed updates',
  },
  reconnecting: {
    icon: RefreshCw,
    label: 'Reconnecting…',
    dot: 'bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    title: 'Reconnecting to real-time updates',
  },
  disconnected: {
    icon: WifiOff,
    label: 'Offline',
    dot: 'bg-gray-400',
    text: 'text-gray-500 dark:text-gray-400',
    title: 'Real-time updates disconnected',
  },
} as const satisfies Record<ConnectionStatus, object>;

/**
 * Subtle pill/icon that reflects the current real-time channel state.
 *
 * Usage:
 * ```tsx
 * const { connectionStatus, retryAttempt, retriesRemaining } = useRealTimeUpdates({ userId });
 * <ConnectionStatusIndicator status={connectionStatus} showLabel retryAttempt={retryAttempt} />
 * ```
 */
export function ConnectionStatusIndicator({
  status,
  showLabel = false,
  className = '',
  retryAttempt,
  retriesRemaining,
}: ConnectionStatusIndicatorProps) {
  const cfg = CONFIG[status];
  const Icon = cfg.icon;
  const isSpinning = status === 'reconnecting';
  const attemptSuffix =
    status === 'reconnecting' && typeof retryAttempt === 'number' && retryAttempt > 0
      ? ` (${retryAttempt}${typeof retriesRemaining === 'number' ? `/${retryAttempt + retriesRemaining}` : ''})`
      : '';

  const title = attemptSuffix ? `${cfg.title} — attempt ${attemptSuffix.trim()}` : cfg.title;

  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      className={`inline-flex items-center gap-1.5 ${className}`}
    >
      {/* Pulsing dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {status === 'connected' && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
            aria-hidden="true"
          />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${cfg.dot}`}
          aria-hidden="true"
        />
      </span>

      {/* Icon */}
      <Icon
        size={13}
        aria-hidden="true"
        className={`${cfg.text} ${isSpinning ? 'animate-spin' : ''}`}
      />

      {/* Optional label */}
      {showLabel && (
        <span className={`text-xs font-medium leading-none ${cfg.text}`}>
          {cfg.label}
          {attemptSuffix}
        </span>
      )}
    </span>
  );
}
