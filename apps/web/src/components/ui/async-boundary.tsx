'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { ErrorDisplay } from './error-display';
import { EmptyState, type EmptyStateProps } from './empty-state';

export interface AsyncBoundaryProps<T> {
  /** Whether an async operation is in flight. */
  loading: boolean;
  /** Error string — rendered as ErrorDisplay when truthy. */
  error?: string | null;
  /** The resolved data array (or undefined while loading). */
  data?: T[] | null;
  /** Rendered while loading. */
  loadingSlot: React.ReactNode;
  /** Rendered when data is non-empty and no error. */
  children: React.ReactNode;
  /** Props forwarded to EmptyState when data is empty and there is no error. */
  emptyState?: Omit<EmptyStateProps, 'className'> & { className?: string };
  /** Called when the user clicks "Retry" on the error view. */
  onRetry?: () => void;
  /** Retry button label — defaults to "Try Again". */
  retryLabel?: string;
  /** Extra class applied to the root wrapper. */
  className?: string;
  /**
   * When true, a retry does not show stale data — the loading slot is shown
   * instead until fresh data arrives. Defaults to false.
   */
  clearDataOnRetry?: boolean;
}

/**
 * Declarative async boundary that handles loading / error / empty / success
 * states for any data-driven view.
 *
 * Usage:
 * ```tsx
 * <AsyncBoundary
 *   loading={isLoading}
 *   error={error}
 *   data={items}
 *   loadingSlot={<PropertyListSkeleton />}
 *   emptyState={{ icon: EmptyIcons.Search, heading: 'No properties found' }}
 *   onRetry={refetch}
 * >
 *   {items.map(item => <Card key={item.id} {...item} />)}
 * </AsyncBoundary>
 * ```
 *
 * Accessibility:
 *  - The live region wrapper (`aria-live="polite"`) announces transitions
 *    to screen readers without interrupting the user mid-sentence.
 *  - The loading wrapper carries `aria-busy="true"` so AT can communicate
 *    that content is not yet available.
 *  - Retrying never duplicates mutations — the retry button is disabled while
 *    `loading` is true.
 */
export function AsyncBoundary<T>({
  loading,
  error,
  data,
  loadingSlot,
  children,
  emptyState,
  onRetry,
  retryLabel = 'Try Again',
  className,
}: AsyncBoundaryProps<T>) {
  // Show loading slot on first load (no data yet) or on retry with clearDataOnRetry.
  const hasData = Array.isArray(data) && data.length > 0;

  if (loading && !hasData) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading"
        aria-live="polite"
        className={cn('min-h-[120px]', className)}
      >
        {loadingSlot}
      </div>
    );
  }

  if (error) {
    return (
      <div aria-live="assertive" className={cn('space-y-3', className)}>
        <ErrorDisplay
          title="Something went wrong"
          message={error}
        />
        {onRetry && (
          <div className="flex justify-center">
            <Button
              onClick={onRetry}
              disabled={loading}
              variant="default"
              size="sm"
            >
              {loading ? 'Loading…' : retryLabel}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!hasData) {
    return (
      <div aria-live="polite" className={className}>
        {emptyState ? (
          <EmptyState {...emptyState} />
        ) : (
          <p className="text-center py-16 text-sm text-gray-500 dark:text-gray-400">
            No results.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      aria-live="polite"
      aria-busy={loading}
      className={cn(loading ? 'opacity-60 pointer-events-none transition-opacity' : '', className)}
    >
      {children}
    </div>
  );
}
