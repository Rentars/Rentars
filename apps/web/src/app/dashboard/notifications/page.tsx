'use client';

import { useState } from 'react';
import { Bell, CheckCheck, Settings } from 'lucide-react';
import NotificationPreferences from '@/components/shared/NotificationPreferences';
import { type AppNotification, useNotifications } from '@/hooks/useNotifications';
import { ErrorDisplay } from '@/components/ui/error-display';
import { EmptyState, EmptyIcons } from '@/components/ui/empty-state';
import { NotificationSkeleton } from '@/components/ui/loading-skeleton';
import { Trash2 } from 'lucide-react';

// ── Notification type labels ──────────────────────────────────────────────────
// Centralised here so they can be replaced with i18n keys when the
// notifications namespace is added to the locale files (Issue 645).
const TYPE_LABELS: Record<string, string> = {
  booking_created:              'New Booking',
  booking_confirmed:            'Booking Confirmed',
  booking_cancelled:            'Booking Cancelled',
  booking_completed:            'Booking Completed',
  booking_disputed:             'Booking Disputed',
  booking_expired:              'Booking Expired',
  booking_modification_requested: 'Modification Requested',
  booking_modification_accepted:  'Modification Accepted',
  booking_modification_declined:  'Modification Declined',
  payment_received:             'Payment Received',
  booking_reminder:             'Booking Reminder',
  review_requested:             'Review Requested',
  review_submitted:             'New Review',
  host_response:                'Host Response',
  dispute_initiated:            'Dispute Initiated',
  new_property:                 'New Listing',
  system_alert:                 'System Alert',
  report_created:               'New Report',
  message_received:             'New Message',
};

type FilterType = 'all' | 'unread';

// ── Main page ─────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const {
    notifications,
    isLoading,
    error,
    unreadCount,
    markRead,
    markAllRead,
    removeNotification,
    refetch,
  } = useNotifications();

  const [filter, setFilter]           = useState<FilterType>('all');
  const [showSettings, setShowSettings] = useState(false);

  const displayed =
    filter === 'unread' ? notifications.filter((n) => !n.read) : notifications;

  return (
    <main className="max-w-3xl mx-auto px-4 py-6">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Bell size={24} className="text-gray-700 dark:text-gray-200" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Notifications
          </h1>
          {unreadCount > 0 && (
            <span
              aria-label={`${unreadCount} unread`}
              className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs font-semibold rounded-full"
            >
              {unreadCount} unread
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          aria-controls="notification-settings"
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          <Settings size={18} aria-hidden="true" />
          Settings
        </button>
      </div>

      {/* ── Settings panel ───────────────────────────────────────────────── */}
      {showSettings && (
        <div id="notification-settings" className="mb-8">
          <NotificationPreferences />
        </div>
      )}

      {/* ── Filter + mark-all-read toolbar ───────────────────────────────── */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div role="group" aria-label="Filter notifications" className="flex gap-2">
          {(['all', 'unread'] as FilterType[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
                ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
            >
              {f === 'all' ? 'All' : 'Unread'}
            </button>
          ))}
        </div>

        {unreadCount > 0 && !isLoading && (
          <button
            type="button"
            onClick={markAllRead}
            className="flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          >
            <CheckCheck size={16} aria-hidden="true" />
            Mark all read
          </button>
        )}
      </div>

      {/* ── Content area with aria-live so transitions are announced ─────── */}
      <div aria-live="polite" aria-atomic="false" className="space-y-2">

        {/* Loading state */}
        {isLoading && <NotificationSkeleton count={5} />}

        {/* Error state — retry does not duplicate mutations */}
        {!isLoading && error && (
          <div className="space-y-3">
            <ErrorDisplay
              title="Could not load notifications"
              message={error}
            />
            <div className="flex justify-center">
              <button
                type="button"
                onClick={refetch}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && displayed.length === 0 && (
          <EmptyState
            icon={EmptyIcons.Bell}
            heading={filter === 'unread' ? "You're all caught up!" : 'No notifications yet'}
            description={
              filter === 'unread'
                ? 'All notifications have been read.'
                : 'You will see booking updates, payment receipts, and messages here.'
            }
          />
        )}

        {/* Notification list */}
        {!isLoading && !error && displayed.length > 0 &&
          displayed.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              onRead={markRead}
              onRemove={removeNotification}
            />
          ))
        }
      </div>
    </main>
  );
}

// ── Notification item ─────────────────────────────────────────────────────────

interface NotificationItemProps {
  notification: AppNotification;
  onRead:   (id: string) => void;
  onRemove: (id: string) => void;
}

function NotificationItem({ notification: n, onRead, onRemove }: NotificationItemProps) {
  const typeLabel = TYPE_LABELS[n.type] ?? n.type;
  const dateLabel = new Date(n.created_at).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <article
      aria-label={`${typeLabel}${n.read ? '' : ', unread'}`}
      className={`flex items-start gap-3 p-4 rounded-xl border transition ${
        !n.read
          ? 'bg-blue-50 dark:bg-blue-950 border-blue-100 dark:border-blue-900'
          : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700'
      }`}
    >
      {/* Unread indicator */}
      {!n.read && (
        <span
          className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-blue-500"
          aria-hidden="true"
        />
      )}

      <div className="flex-1 min-w-0">
        {/* Make the whole content area a button when unread — clicking marks it read */}
        <button
          type="button"
          disabled={n.read}
          onClick={() => onRead(n.id)}
          aria-label={n.read ? undefined : `Mark "${typeLabel}" as read`}
          className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          <p className="text-sm font-semibold text-gray-900 dark:text-white">
            {typeLabel}
          </p>
          {n.data?.message && (
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-0.5 line-clamp-2">
              {String(n.data.message)}
            </p>
          )}
          <time
            dateTime={n.created_at}
            className="text-xs text-gray-400 mt-1 block"
          >
            {dateLabel}
          </time>
        </button>
      </div>

      {/* Remove */}
      <button
        type="button"
        onClick={() => onRemove(n.id)}
        aria-label={`Remove notification: ${typeLabel}`}
        className="shrink-0 p-1 text-gray-400 hover:text-red-500 transition rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </article>
  );
}
