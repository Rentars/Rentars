import type { Property } from '@/types/property';
import PropertyCard from './PropertyCard';
import { PropertyListSkeleton } from '@/components/ui/loading-skeleton';
import { EmptyState, ErrorState, SkeletonRegion, StatusAnnouncer } from '@/components/ui/async-states';

interface PropertyGridProps {
  properties: Property[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void | Promise<unknown>;
}

/**
 * Search results grid with explicit loading / empty / error / success states.
 *
 * - Loading replaces the grid only when there is nothing to show yet; when
 *   results are already on screen (e.g. "Load more" pagination) they stay
 *   mounted so the layout never collapses and the user's place is preserved.
 * - Empty and error are distinct: empty means "the search succeeded and found
 *   nothing", error means "the request failed" and offers a retry guarded
 *   against double-activation.
 */
export default function PropertyGrid({
  properties,
  loading = false,
  error = null,
  onRetry
}: PropertyGridProps) {
  // ── Loading: only skeleton the grid when there are no results to keep ──────
  if (loading && properties.length === 0) {
    return (
      <SkeletonRegion label="Loading search results…">
        <PropertyListSkeleton count={6} />
      </SkeletonRegion>
    );
  }

  // ── Error (no data): request failed — retryable ────────────────────────────
  if (error && properties.length === 0) {
    return (
      <ErrorState
        title="Search Error"
        message={error}
        onRetry={onRetry}
        retryLabel="Try Again"
      />
    );
  }

  // ── Empty (request succeeded, nothing matched) ─────────────────────────────
  if (properties.length === 0) {
    return (
      <EmptyState
        title="No properties found"
        description="Try adjusting your search filters or check back later."
        icon={
          <svg
            className="w-16 h-16 mx-auto text-gray-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.21A4.003 4.003 0 003 15z" />
          </svg>
        }
      />
    );
  }

  // ── Success (with optional background refresh / pagination) ────────────────
  return (
    <div className="space-y-6">
      {loading && (
        <StatusAnnouncer message="Updating search results…" />
      )}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6"
        aria-busy={loading}
      >
        {properties.map((p) => (
          <PropertyCard key={p.id} property={p} />
        ))}
      </div>
      {error && properties.length > 0 && (
        <ErrorState
          variant="inline"
          message={`${error} Showing previously loaded results.`}
          onRetry={onRetry}
          retryLabel="Try Again"
        />
      )}
    </div>
  );
}
