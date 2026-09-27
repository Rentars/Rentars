import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Base Skeleton pulse block.
 * Every skeleton that wraps multiple Skeleton elements should carry
 * aria-busy="true" and aria-label on its root container so screen readers
 * announce that content is loading — not each individual block.
 */
const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('animate-pulse rounded-md bg-muted', className)}
    {...props}
  />
));
Skeleton.displayName = 'Skeleton';

// ── Property Card ─────────────────────────────────────────────────────────────

interface PropertyCardSkeletonProps {
  className?: string;
}

export function PropertyCardSkeleton({ className }: PropertyCardSkeletonProps) {
  return (
    <div
      className={cn('rounded-lg border border-border overflow-hidden', className)}
      aria-hidden="true"   // parent list carries aria-busy; individual cards are decorative
    >
      <Skeleton className="h-48 w-full" />
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="flex gap-2 pt-2">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      </div>
    </div>
  );
}

// ── Property List ─────────────────────────────────────────────────────────────

interface PropertyListSkeletonProps {
  count?: number;
  className?: string;
}

export function PropertyListSkeleton({ count = 6, className }: PropertyListSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading properties"
      aria-live="polite"
      className={cn('grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4', className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <PropertyCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ── Booking Card ──────────────────────────────────────────────────────────────

interface BookingSkeletonProps {
  className?: string;
}

export function BookingSkeleton({ className }: BookingSkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('rounded-lg border border-border p-4 space-y-3', className)}
    >
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/3" />
      <div className="flex gap-2 pt-2">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  );
}

// ── Booking List ──────────────────────────────────────────────────────────────

interface BookingListSkeletonProps {
  count?: number;
  className?: string;
}

/**
 * Used on dashboard "My Bookings" and tenant booking list views.
 * Matches the stable height of a BookingCard so there is no layout shift.
 */
export function BookingListSkeleton({ count = 4, className }: BookingListSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading bookings"
      aria-live="polite"
      className={cn('space-y-3', className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <BookingSkeleton key={i} />
      ))}
    </div>
  );
}

// ── Wallet / Escrow ───────────────────────────────────────────────────────────

interface WalletSkeletonProps {
  className?: string;
}

/**
 * Mirrors the shape of WalletConnectionModal and USDCEscrowFlow while
 * wallet state is being checked on mount (auto-reconnect).
 */
export function WalletSkeleton({ className }: WalletSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading wallet status"
      aria-live="polite"
      className={cn('rounded-lg border border-border p-6 space-y-4', className)}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-5 w-40" />
      </div>
      {/* Address line */}
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      {/* Action button */}
      <Skeleton className="h-10 w-full rounded-lg" />
      {/* Network badge */}
      <div className="flex justify-center">
        <Skeleton className="h-4 w-32 rounded-full" />
      </div>
    </div>
  );
}

// ── Notification ──────────────────────────────────────────────────────────────

interface NotificationSkeletonProps {
  count?: number;
  className?: string;
}

/**
 * Used in the notifications dashboard page while the notification list loads.
 * Stable dimensions prevent layout shift when real items replace the skeleton.
 */
export function NotificationSkeleton({ count = 5, className }: NotificationSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading notifications"
      aria-live="polite"
      className={cn('space-y-2', className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-start gap-3 p-4 rounded-xl border border-border bg-card"
        >
          {/* Unread dot placeholder */}
          <Skeleton className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          {/* Remove button placeholder */}
          <Skeleton className="h-6 w-6 rounded flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ── Dashboard Overview ────────────────────────────────────────────────────────

interface DashboardSkeletonProps {
  className?: string;
}

/**
 * Skeleton for the host/tenant dashboard overview page.
 * Matches the stats cards + recent-activity layout without knowing real values,
 * so the page height is stable during data fetch.
 */
export function DashboardSkeleton({ className }: DashboardSkeletonProps) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading dashboard"
      aria-live="polite"
      className={cn('space-y-8', className)}
    >
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="rounded-lg border border-border p-4 space-y-2"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>

      {/* Recent activity section */}
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <BookingListSkeleton count={3} />
      </div>

      {/* Properties section (host only placeholder) */}
      <div aria-hidden="true" className="space-y-3">
        <Skeleton className="h-6 w-36" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <PropertyCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Property Detail ───────────────────────────────────────────────────────────

interface PropertyDetailSkeletonProps {
  className?: string;
}

/**
 * Layout-matching skeleton for the property detail page.
 * Mirrors the exact grid / spacing / sizing of PropertyDetail so there is
 * no cumulative layout shift when real content swaps in.
 */
export function PropertyDetailSkeleton({ className }: PropertyDetailSkeletonProps) {
  return (
    <div
      className={cn('max-w-6xl mx-auto px-6 py-8', className)}
      aria-busy="true"
      aria-label="Loading property details"
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div className="space-y-2 flex-1 mr-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-10 w-10 rounded-full" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-8">
        {/* Main column */}
        <div className="col-span-2 space-y-8">
          {/* Hero gallery */}
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="w-full h-96 rounded-lg" />
            <div className="flex gap-2 overflow-hidden">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="flex-shrink-0 w-16 h-12 rounded" />
              ))}
            </div>
          </div>

          {/* Description */}
          <div aria-hidden="true" className="rounded-lg border border-border p-6 space-y-3">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>

          {/* Amenities */}
          <div aria-hidden="true" className="rounded-lg border border-border p-6 space-y-4">
            <Skeleton className="h-7 w-36" />
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-5 w-36" />
              ))}
            </div>
          </div>

          {/* Map */}
          <div aria-hidden="true" className="space-y-4">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="w-full h-64 rounded-lg" />
          </div>

          {/* Calendar */}
          <div aria-hidden="true" className="space-y-4">
            <Skeleton className="h-7 w-40" />
            <div className="rounded-lg border border-border p-4 space-y-3">
              <div className="flex justify-between items-center">
                <Skeleton className="h-5 w-8" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-8" />
              </div>
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: 35 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 rounded" />
                ))}
              </div>
            </div>
          </div>

          {/* Reviews */}
          <div aria-hidden="true" className="space-y-4">
            <Skeleton className="h-7 w-24" />
            <div className="rounded-lg border border-border p-6 space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Host */}
          <div aria-hidden="true" className="rounded-lg border border-border p-6">
            <Skeleton className="h-7 w-40 mb-4" />
            <div className="flex items-center gap-4">
              <Skeleton className="h-16 w-16 rounded-full flex-shrink-0" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="col-span-1">
          <div
            aria-hidden="true"
            className="rounded-lg border border-border p-6 space-y-4 sticky top-8"
          >
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-4 w-20" />
            </div>
            <Skeleton className="h-12 w-full rounded-lg" />
            <div className="space-y-3">
              <div className="flex justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-14" />
              </div>
              <div className="flex justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-14" />
              </div>
              <div className="border-t border-border pt-3 flex justify-between">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}

export { Skeleton };
