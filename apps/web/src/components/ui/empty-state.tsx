import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export interface EmptyStateProps {
  /** SVG icon element or any node shown above the heading. */
  icon?: React.ReactNode;
  heading: string;
  description?: string;
  /** Primary action button label. */
  actionLabel?: string;
  /** Called when the primary action button is clicked. */
  onAction?: () => void;
  /** Secondary action button label. */
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
  className?: string;
}

/**
 * Generic empty-state panel used across search, dashboard, notifications,
 * wishlist, and any other async view that can yield zero results.
 *
 * Accessibility: the container has role="status" so screen readers announce
 * it without requiring a live-region parent. The heading is rendered as a
 * visually-prominent <p> rather than an <h*> to avoid disrupting page
 * outline hierarchy in contexts where it appears mid-page.
 */
export function EmptyState({
  icon,
  heading,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-label={heading}
      className={cn(
        'flex flex-col items-center justify-center text-center py-16 px-6',
        className,
      )}
    >
      {icon && (
        <div
          className="mb-5 text-gray-300 dark:text-gray-600"
          aria-hidden="true"
        >
          {icon}
        </div>
      )}

      <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
        {heading}
      </p>

      {description && (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
          {description}
        </p>
      )}

      {(actionLabel || secondaryLabel) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {actionLabel && onAction && (
            <Button onClick={onAction} variant="default" size="sm">
              {actionLabel}
            </Button>
          )}
          {secondaryLabel && onSecondaryAction && (
            <Button onClick={onSecondaryAction} variant="outline" size="sm">
              {secondaryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Preset icons ──────────────────────────────────────────────────────────────

export const EmptyIcons = {
  Bell: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
  Calendar: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  Home: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 9.75L12 3l9 6.75V21H3V9.75z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 21V12h6v9" />
    </svg>
  ),
  Search: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 12a7.5 7.5 0 0012.15 4.65z" />
    </svg>
  ),
  Wallet: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 12h5v3h-5a1.5 1.5 0 010-3z" />
    </svg>
  ),
  Heart: (
    <svg className="w-14 h-14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 016.364 0L12 7.636l1.318-1.318a4.5 4.5 0 116.364 6.364L12 20.364l-7.682-7.682a4.5 4.5 0 010-6.364z" />
    </svg>
  ),
};
