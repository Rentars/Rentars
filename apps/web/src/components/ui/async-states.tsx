import * as React from "react"
import { AlertCircle, Inbox, Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { Skeleton } from "./loading-skeleton"

// ─── Status announcer ─────────────────────────────────────────────────────────

interface StatusAnnouncerProps {
  /** Message to announce. Empty string clears the region. */
  message: string
  className?: string
}

/**
 * Visually-hidden polite live region for async status updates.
 *
 * Mount once per view and feed it human-readable status text ("Searching…",
 * "3 bookings loaded", "Selected Beach House"). Screen readers announce
 * changes without any visual movement, so nothing in the layout shifts and no
 * controls are covered on mobile.
 */
export function StatusAnnouncer({ message, className }: StatusAnnouncerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn("sr-only", className)}
    >
      {message}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  title: string
  description?: string
  /** Optional call-to-action rendered under the description. */
  action?: React.ReactNode
  icon?: React.ReactNode
  className?: string
}

/**
 * "No data, but the request succeeded" — deliberately distinct from
 * `ErrorState` so users are never told "nothing found" by a failed request or
 * shown a scary error when the answer is simply "empty".
 *
 * Rendered as a `role="status"` region (polite) with a stable minimum height
 * so swapping between loading → empty → results does not reflow the page.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-3 text-gray-400" aria-hidden="true">
        {icon ?? <Inbox className="h-10 w-10" />}
      </div>
      <p className="text-lg font-medium text-gray-900 dark:text-gray-100">{title}</p>
      {description && (
        <p className="mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

// ─── Error state ──────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  message: string
  title?: string
  /** When provided, renders a retry button guarded against double-activation. */
  onRetry?: () => void | Promise<unknown>
  retryLabel?: string
  /** Externally-controlled pending flag (e.g. from `useAsyncAction`). */
  retrying?: boolean
  /** Compact, banner-like variant for inline use above existing content. */
  variant?: "block" | "inline"
  className?: string
}

/**
 * "The request failed" — announced via `role="alert"` and, when `onRetry` is
 * given, offers a safe retry: the button disables itself synchronously and
 * stays disabled until the retry promise settles, so impatient double clicks
 * cannot fire the request (or mutation) twice.
 */
export function ErrorState({
  message,
  title = "Something went wrong",
  onRetry,
  retryLabel = "Try again",
  retrying = false,
  variant = "block",
  className,
}: ErrorStateProps) {
  const [isRetrying, setIsRetrying] = React.useState(false)
  // Synchronous guard: state updates land a tick late, so a fast double click
  // could otherwise fire two retries before the button re-renders as disabled.
  const retryInFlightRef = React.useRef(false)
  const busy = isRetrying || retrying

  const handleRetry = React.useCallback(async () => {
    if (retryInFlightRef.current || busy || !onRetry) return
    retryInFlightRef.current = true
    setIsRetrying(true)
    try {
      await onRetry()
    } catch {
      // The caller is responsible for surfacing the failure (usually by
      // keeping the ErrorState visible); never let it become an unhandled
      // rejection from the click handler.
    } finally {
      retryInFlightRef.current = false
      setIsRetrying(false)
    }
  }, [busy, onRetry])

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn(
          "flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
          className,
        )}
      >
        <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{message}</span>
        {onRetry && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            aria-busy={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-1.5 font-medium hover:bg-red-100 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-700 dark:hover:bg-red-900/40"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}
            {retryLabel}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex min-h-[240px] flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50 px-6 py-12 text-center dark:border-red-800 dark:bg-red-950",
        className,
      )}
    >
      <AlertCircle
        size={32}
        className="mb-3 text-red-500"
        aria-hidden="true"
      />
      <p className="text-lg font-medium text-red-800 dark:text-red-200">{title}</p>
      <p className="mt-2 max-w-md text-sm text-red-700 dark:text-red-300">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={handleRetry}
          disabled={busy}
          aria-busy={busy}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-red-400 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-red-950"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={16} aria-hidden="true" />
          )}
          {retryLabel}
        </button>
      )}
    </div>
  )
}

// ─── Loading skeletons (fixed dimensions — no layout shift) ───────────────────

interface SkeletonRegionProps {
  /** Accessible status label announced while the skeleton is shown. */
  label: string
  children: React.ReactNode
  className?: string
}

/**
 * Wraps a skeleton in a `role="status"` region so assistive technology is told
 * the view is loading, without injecting any moving content over interactive
 * controls (skeletons are in-flow, never absolutely positioned).
 */
export function SkeletonRegion({ label, children, className }: SkeletonRegionProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn("min-h-[240px]", className)}
    >
      {children}
      <span className="sr-only">{label}</span>
    </div>
  )
}

interface DashboardSummarySkeletonProps {
  count?: number
  className?: string
}

/** 4 stat cards, fixed h-28 — mirrors DashboardSummaryCards exactly. */
export function DashboardSummarySkeleton({ count = 4, className }: DashboardSummarySkeletonProps) {
  return (
    <div
      className={cn("grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4", className)}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  )
}

interface TableRowsSkeletonProps {
  rows?: number
  /** Fixed height per row so the container never changes size mid-load. */
  rowClassName?: string
  className?: string
}

/** Fixed-height placeholder rows for list/table surfaces. */
export function TableRowsSkeleton({ rows = 3, rowClassName, className }: TableRowsSkeletonProps) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-xl", rowClassName ?? "h-16")} />
      ))}
    </div>
  )
}

interface BookingListSkeletonProps {
  count?: number
  className?: string
}

/** Stacked booking-card placeholders matching BookingHistory card height. */
export function BookingListSkeleton({ count = 3, className }: BookingListSkeletonProps) {
  return (
    <div className={cn("space-y-4", className)} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-32 w-full rounded-lg border border-border" />
      ))}
    </div>
  )
}
