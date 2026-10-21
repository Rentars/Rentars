'use client';

import { useEffect, useRef } from 'react';
import type { Property } from '@/types/property';
import { EmptyState, SkeletonRegion, StatusAnnouncer } from '@/components/ui/async-states';

export type ListSelectSource = 'list' | 'map-keyboard';

export interface MapResultsListProps {
  properties: Property[];
  /** Currently selected property id (synchronised with the map pin). */
  selectedId?: string;
  /**
   * Fired when a listing is activated. `source` tells the parent whether to
   * move focus (keyboard map selection) or leave it in place (pointer/list).
   */
  onSelect: (id: string, source: ListSelectSource) => void;
  /** Fired when the user asks to open the listing's detail page. */
  onOpen?: (id: string) => void;
  /**
   * Focus request emitted by the map: `{ id, nonce }`. When `nonce` changes,
   * the matching list button receives DOM focus so keyboard users who
   * activated a pin land on a real control they can continue from.
   */
  focusRequest?: { id: string; nonce: number } | null;
  loading?: boolean;
  className?: string;
}

/**
 * MapResultsList — the non-map path for map-based discovery.
 *
 * Renders every mapped property as a focusable list button exposing the same
 * information a pin popup does (title, location, price, availability), so:
 *
 * - all visible results can be reached and selected without a pointer;
 * - selection is synchronised with the map (`aria-current` + `aria-pressed`
 *   on the pin) in both directions;
 * - activating a listing announced the selected details via a polite live
 *   region instead of moving or overlapping any other control.
 */
export default function MapResultsList({
  properties,
  selectedId,
  onSelect,
  onOpen,
  focusRequest,
  loading = false,
  className = '',
}: MapResultsListProps) {
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  // ── Focus management: keyboard pin activation → matching list item ────────
  useEffect(() => {
    if (!focusRequest) return;
    const button = buttonRefs.current.get(focusRequest.id);
    if (!button) return;
    button.focus();
    button.scrollIntoView({ block: 'nearest' });
  }, [focusRequest?.id, focusRequest?.nonce]);

  const selected = properties.find((p) => p.id === selectedId);

  if (loading) {
    return (
      <section aria-labelledby="map-results-heading" className={className}>
        <h2 id="map-results-heading" className="text-base font-semibold text-gray-900 dark:text-white mb-3">
          Properties on map
        </h2>
        <SkeletonRegion label="Loading map results…">
          <ul className="space-y-2">
            {[0, 1, 2].map((i) => (
              <li key={i} className="h-[72px] rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 animate-pulse" />
            ))}
          </ul>
        </SkeletonRegion>
      </section>
    );
  }

  if (properties.length === 0) {
    return (
      <section aria-labelledby="map-results-heading" className={className}>
        <h2 id="map-results-heading" className="text-base font-semibold text-gray-900 dark:text-white mb-3">
          Properties on map
        </h2>
        <EmptyState
          title="No properties with location data"
          description="Try widening your search or removing the map view to see all results."
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="map-results-heading" className={className}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id="map-results-heading" className="text-base font-semibold text-gray-900 dark:text-white">
          Properties on map ({properties.length})
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Select a property to highlight it on the map.
        </p>
      </div>

      {/* Announce map-driven selections without moving anything on screen */}
      <StatusAnnouncer
        message={
          selected
            ? `Selected ${selected.title}. ${selected.price_per_night} USDC per night. ${
                selected.available ? 'Available' : 'Currently booked'
              }.`
            : ''
        }
      />

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {properties.map((property) => {
          const isSelected = property.id === selectedId;
          return (
            <li key={property.id}>
              <div
                className={`flex items-stretch rounded-lg border transition
                  ${isSelected
                    ? 'border-blue-500 ring-2 ring-blue-500/40'
                    : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'}`}
              >
                <button
                  type="button"
                  ref={(el) => {
                    if (el) buttonRefs.current.set(property.id, el);
                    else buttonRefs.current.delete(property.id);
                  }}
                  onClick={() => onSelect(property.id, 'list')}
                  aria-current={isSelected ? 'true' : undefined}
                  className="flex-1 min-w-0 text-left px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 rounded-l-lg"
                >
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                    {property.title}
                  </span>
                  <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                    {property.location}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-xs">
                    <span className="font-semibold text-blue-600 dark:text-blue-400">
                      {property.price_per_night} USDC/night
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium
                        ${property.available
                          ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}
                    >
                      {property.available ? 'Available' : 'Booked'}
                    </span>
                  </span>
                </button>
                {onOpen && (
                  <button
                    type="button"
                    onClick={() => onOpen(property.id)}
                    aria-label={`View details for ${property.title}`}
                    className="shrink-0 px-3 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline rounded-r-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                  >
                    Details
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
