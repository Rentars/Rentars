'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { LatLngBounds, Map as LeafletMap } from 'leaflet';
import type { Property } from '@/types/property';
import { useGeolocation, type GeoPosition } from '@/hooks/useGeolocation';

// ── Dynamic imports (no SSR) ──────────────────────────────────────────────────
const MapContainer = dynamic(() => import('react-leaflet').then((m) => m.MapContainer), {
  ssr: false,
});
const TileLayer = dynamic(() => import('react-leaflet').then((m) => m.TileLayer), { ssr: false });
const MarkerClusterGroup = dynamic(() => import('react-leaflet-cluster'), { ssr: false });
const PriceMarker = dynamic(() => import('./PriceMarker'), { ssr: false });
const BoundsListener = dynamic(() => import('./BoundsListener'), { ssr: false });
const UserLocationMarker = dynamic(() => import('./UserLocationMarker'), { ssr: false });

export interface PropertyMapProps {
  properties: Property[];
  onPropertyClick?: (id: string) => void;
  onBoundsChanged?: (bounds: LatLngBounds) => void;
  /** Highlighted property id (e.g. hovered card) */
  activePropertyId?: string;
  /**
   * Called when "use my location" resolves both coordinates and a readable label.
   * Use this to populate the search field and trigger a radius search.
   * `label` is null when reverse geocoding failed — position is still valid.
   */
  onUserLocation?: (position: GeoPosition, label: string | null) => void;
}

/**
 * Keyboard-accessible list fallback for map pins.
 *
 * The Leaflet canvas can trap keyboard focus and make individual markers
 * unreachable on some browsers. This visually-hidden (sr-only) list renders
 * every property as a focusable button so keyboard-only and screen-reader
 * users can always reach each property without using the map.
 *
 * The list is visually hidden but fully reachable via Tab — it appears
 * just before the MapContainer in DOM order.
 */
function MapPinListFallback({
  properties,
  onPropertyClick,
}: {
  properties: Array<Property & { lat: number; lng: number }>;
  onPropertyClick?: (id: string) => void;
}) {
  if (properties.length === 0) return null;
  return (
    <nav
      aria-label="Properties on map — keyboard list"
      className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:z-[1001] focus-within:bg-white focus-within:border focus-within:border-gray-300 focus-within:rounded-lg focus-within:shadow-lg focus-within:p-3 focus-within:max-h-60 focus-within:overflow-y-auto focus-within:top-0 focus-within:left-0 focus-within:w-72"
    >
      <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
        {properties.length} {properties.length === 1 ? 'property' : 'properties'} on map
      </p>
      <ul className="space-y-1">
        {properties.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPropertyClick?.(p.id)}
              className="w-full text-left px-3 py-2 text-sm rounded hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none transition"
            >
              <span className="font-medium text-gray-900">{p.title}</span>
              {p.price_per_night !== undefined && (
                <span className="ml-2 text-blue-600 font-semibold">${p.price_per_night}/night</span>
              )}
              <span className="block text-xs text-gray-500 truncate">{p.location}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function PropertyMap({
  properties,
  onPropertyClick,
  onBoundsChanged,
  activePropertyId,
  onUserLocation,
}: PropertyMapProps) {
  const [center, setCenter] = useState<[number, number]>([40.7128, -74.006]);
  const [mapKey, setMapKey] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable callback reference — rebuild only when parent's onUserLocation changes.
  const handleLocation = useCallback(
    (pos: GeoPosition, label: string | null) => {
      setCenter([pos.lat, pos.lng]);
      setMapKey((k) => k + 1);
      onUserLocation?.(pos, label);
    },
    [onUserLocation],
  );

  const { position, loading: geoLoading, error: geoError, locate } = useGeolocation({
    onLocation: handleLocation,
  });

  const validProperties = useMemo(
    () =>
      properties.filter(
        (p): p is Property & { lat: number; lng: number } =>
          typeof (p as any).lat === 'number' && typeof (p as any).lng === 'number',
      ),
    [properties],
  );

  // Fit map to property bounds when list changes.
  useEffect(() => {
    if (validProperties.length === 0) return;
    const lats = validProperties.map((p) => p.lat);
    const lngs = validProperties.map((p) => p.lng);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const midLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    setCenter([midLat, midLng]);
    setMapKey((k) => k + 1);
  }, [validProperties]);

  const handleBoundsChanged = (bounds: LatLngBounds) => {
    if (!onBoundsChanged) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onBoundsChanged(bounds), 350);
  };

  return (
    <div
      className="relative w-full h-[450px] rounded-xl overflow-hidden shadow-md bg-gray-200"
      role="region"
      aria-label="Property map"
    >
      {/* Keyboard list fallback — visible only on focus (sr-only) */}
      <MapPinListFallback
        properties={validProperties}
        onPropertyClick={onPropertyClick}
      />

      {/* Geolocation button */}
      <button
        onClick={locate}
        disabled={geoLoading}
        title="Use my location"
        className="absolute top-3 right-3 z-[1000] bg-white border border-gray-300 rounded-lg p-2 shadow hover:bg-gray-50 disabled:opacity-50 transition"
        aria-label={geoLoading ? 'Finding your location…' : 'Find properties near me'}
      >
        {geoLoading ? (
          <svg
            className="w-5 h-5 animate-spin text-blue-600"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
          </svg>
        ) : (
          <svg
            className="w-5 h-5 text-blue-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 2a7 7 0 017 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 017-7z"
            />
            <circle cx="12" cy="9" r="2.5" fill="currentColor" />
          </svg>
        )}
      </button>

      {/* Geo-error banner — only shown after a failed locate() */}
      {geoError && (
        <div
          role="alert"
          className="absolute top-14 right-3 z-[1000] max-w-xs bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2 shadow"
        >
          {geoError}
        </div>
      )}

      <MapContainer
        key={mapKey}
        center={center}
        zoom={validProperties.length > 0 ? 11 : 3}
        style={{ height: '100%', width: '100%' }}
        zoomControl
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {onBoundsChanged && <BoundsListener onBoundsChanged={handleBoundsChanged} />}

        {position && <UserLocationMarker position={position} />}

        <MarkerClusterGroup chunkedLoading>
          {validProperties.map((property) => (
            <PriceMarker
              key={property.id}
              property={property}
              active={property.id === activePropertyId}
              onClick={() => onPropertyClick?.(property.id)}
            />
          ))}
        </MarkerClusterGroup>
      </MapContainer>

      {validProperties.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/80 text-gray-500 text-sm pointer-events-none">
          No properties with location data
        </div>
      )}
    </div>
  );
}
