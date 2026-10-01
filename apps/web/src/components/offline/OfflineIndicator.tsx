'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, Wifi, WifiOff } from 'lucide-react';

interface OfflineIndicatorProps {
  isOnline: boolean;
  isStale?: boolean;
  isRetrying?: boolean;
  onRetry?: () => void;
}

export function OfflineIndicator({
  isOnline,
  isStale,
  isRetrying,
  onRetry,
}: OfflineIndicatorProps) {
  const [showIndicator, setShowIndicator] = useState(false);

  useEffect(() => {
    setShowIndicator(!isOnline || (isStale ?? false));
  }, [isOnline, isStale]);

  if (!showIndicator) return null;

  const isOffline = !isOnline;
  const isDegraded = isOnline && isStale;

  return (
    <div
      className={`fixed bottom-4 right-4 z-40 rounded-lg shadow-lg p-4 max-w-sm border ${
        isDegraded
          ? 'bg-yellow-50 border-yellow-200'
          : 'bg-red-50 border-red-200'
      }`}
      role="alert"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex gap-3 items-start">
        {isDegraded ? (
          <Wifi className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        ) : (
          <WifiOff className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        )}

        <div className="flex-1">
          <h3
            className={`font-semibold ${
              isDegraded ? 'text-yellow-900' : 'text-red-900'
            }`}
          >
            {isDegraded ? 'Data may be outdated' : 'You are offline'}
          </h3>
          <p
            className={`text-sm mt-1 ${
              isDegraded ? 'text-yellow-700' : 'text-red-700'
            }`}
          >
            {isDegraded
              ? 'This information was last updated a while ago. Refresh to get the latest.'
              : 'You can still view cached information, but changes cannot be saved.'}
          </p>

          {onRetry && (isOnline || isRetrying) && (
            <button
              onClick={onRetry}
              disabled={isRetrying}
              className="mt-3 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-busy={isRetrying}
            >
              {isRetrying ? 'Refreshing...' : 'Refresh now'}
            </button>
          )}
        </div>

        <button
          onClick={() => setShowIndicator(false)}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0 mt-0.5"
          aria-label="Dismiss notification"
        >
          <span className="text-lg">×</span>
        </button>
      </div>
    </div>
  );
}
