'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { LatLngBounds, Map as LeafletMap } from 'leaflet';
import type { Property } from '@/types/property';
import { useGeolocation, type GeoPosition } from '@/hooks/useGeolocation';
import MapResultsList from './MapResultsList';

// ── Dynamic imports (no SSR) ──────────────────────────────────────────────────
const MapContainer = dynamic(() => import('react-leaflet').then((m) => m.MapContainer), {
  ssr: false,
});
const TileLayer = dynamic(() => import('react-leaflet').then((m) => m.TileLayer), { ssr: false });
const MarkerClusterGroup = dynamic(() => import('react-leaflet-cluster'), { ssr: false });
const PriceMarker = dynamic(() => import('./PriceMarker'), { ssr: false });
const BoundsListener = dynamic(() => import('./BoundsListener'), { ssr: false });
const UserLocationMarker = dynamic(() => import('./UserLocationMarker'), { ssr: false });
const MapSelectionController = dynamic(() => import('./MapSelectionController'), { ssr: false });

/** Where a selection originated — drives focus management in the list. */
export type MapSelectSource = 'map-pointer' | 'map-keyboard' | 'list';

export interface PropertyMapProps {
  properties: Property[];
  onPropertyClick?: (id: string) => void;
  onBoundsChanged?: (bounds: LatLngBounds) => void;
  /** Highlighted property id (e.g. hovered card) */
  activePropertyId?: string;
  /** Selected listing, synchronised with the accessible results list below. */
  selectedPropertyId?: string;
  /**
   * Fired when a listing is selected from the map (pin activation) or the
   * results list. Keyboard-driven pin activation reports `map-keyboard` so the
   * caller can move focus to the matching list item.
   */
  onSelectProperty?: (id: string, source: MapSelectSource) => void;
  /**
   * Called when "use my location" resolves both coordinates and a readable label.
   * Use this to populate the search field and trigger a radius search.
   * `label` is null when reverse geocoding failed — position is still valid.
   */
  onUserLocation?: (position: GeoPosition, label: string | null) => void;
}

export default function PropertyMap({
  properties,
  onPropertyClick,
  onBoundsChanged,
  activePropertyId,
  selectedPropertyId,
  onSelectProperty,
  onUserLocation,
}: PropertyMapProps) {
  const [center, setCenter] = useState<[number, number]>([40.7128, -74.006]);
  const [mapKey, setMapKey] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus request forwarded to the results list when a keyboard user
  // activates a pin (nonce changes → the list item receives DOM focus).
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonceRef = useRef(0);

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

  const selectedId = selectedPropertyId ?? activePropertyId;

  const selectedPosition = useMemo<[number, number] | null>(() => {
    const match = validProperties.find((p) => p.id === selectedId);
    return match ? [match.lat, match.lng] : null;
  }, [validProperties, selectedId]);

  const handlePinSelect = useCallback(
    (id: string, source: 'pointer' | 'keyboard') => {
      onSelectProperty?.(id, source === 'keyboard' ? 'map-keyboard' : 'map-pointer');
      if (source === 'keyboard') {
        focusNonceRef.current += 1;
        setFocusRequest({ id, nonce: focusNonceRef.current });
      }
    },
    [onSelectProperty],
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
    <div>
      <div
        className="relative w-full h-[450px] rounded-xl overflow-hidden shadow-md bg-gray-200"
        role="group"
        aria-label="Search results map"
      >
        <p className="sr-only">
          This map is optional. An equivalent list of every mapped property, with
          price and availability, follows below the map.
        </p>
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

          {selectedPosition && <MapSelectionController position={selectedPosition} />}

          {position && <UserLocationMarker position={position} />}

          <MarkerClusterGroup chunkedLoading>
            {validProperties.map((property) => (
              <PriceMarker
                key={property.id}
                property={property}
                active={property.id === selectedId}
                onSelect={(source) => handlePinSelect(property.id, source)}
                onClick={() => onPropertyClick?.(property.id)}
              />
            ))}
          </MarkerClusterGroup>
        </MapContainer>

        {validProperties.length === 0 && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-gray-100/80 text-gray-500 text-sm pointer-events-none"
          >
            No properties with location data
          </div>
        )}
      </div>

      {/* Non-map path: full property/price/availability list, kept in sync
          with the pins above (selection, focus, and live announcements). */}
      <MapResultsList
        properties={validProperties}
        selectedId={selectedId}
        onSelect={(id, source) => onSelectProperty?.(id, source === 'list' ? 'list' : 'map-keyboard')}
        onOpen={onPropertyClick ? (id) => onPropertyClick(id) : undefined}
        focusRequest={focusRequest}
        className="mt-4"
      />
    </div>
  );
}
