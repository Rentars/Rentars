'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { LatLngBounds, Map as LeafletMap } from 'leaflet';
import type { Property } from '@/types/property';

const MapContainer = dynamic(() => import('react-leaflet').then((m) => m.MapContainer), {
  ssr: false,
});
const TileLayer = dynamic(() => import('react-leaflet').then((m) => m.TileLayer), { ssr: false });
const MarkerClusterGroup = dynamic(() => import('react-leaflet-cluster'), { ssr: false });
const PriceMarker = dynamic(() => import('./PriceMarker'), { ssr: false });
const BoundsListener = dynamic(() => import('./BoundsListener'), { ssr: false });

interface SearchMapProps {
  properties: Property[];
  onPropertyClick: (id: string) => void;
  onBoundsChanged?: (bounds: LatLngBounds) => void;
  onSearchThisArea?: (bounds: LatLngBounds) => void;
  activePropertyId?: string;
  isSearching?: boolean;
}

export default function Map({
  properties,
  onPropertyClick,
  onBoundsChanged,
  onSearchThisArea,
  activePropertyId,
  isSearching,
}: SearchMapProps) {
  const [center, setCenter] = useState<[number, number]>([40.7128, -74.006]);
  const [mapKey, setMapKey] = useState(0);
  const [currentBounds, setCurrentBounds] = useState<LatLngBounds | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  const validProperties = useMemo(
    () =>
      properties.filter(
        (p): p is Property & { lat: number; lng: number } =>
          typeof (p as any).lat === 'number' && typeof (p as any).lng === 'number',
      ),
    [properties],
  );

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
    setCurrentBounds(bounds);
    // BoundsListener already debounces and enforces the movement threshold;
    // a second debounce here delayed requests and let stale markers render.
    onBoundsChanged?.(bounds);
  };

  const handleSearchThisArea = () => {
    if (currentBounds && onSearchThisArea) {
      onSearchThisArea(currentBounds);
    }
  };

  return (
    <div className="relative w-full h-96 rounded-lg overflow-hidden shadow-md bg-gray-200">
      <MapContainer
        key={mapKey}
        center={center}
        zoom={validProperties.length > 0 ? 11 : 3}
        style={{ height: '100%', width: '100%' }}
        zoomControl
        ref={mapRef}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {onBoundsChanged && <BoundsListener onBoundsChanged={handleBoundsChanged} />}

        <MarkerClusterGroup chunkedLoading>
          {validProperties.map((property) => (
            <PriceMarker
              key={property.id}
              property={property}
              active={property.id === activePropertyId}
              onClick={() => onPropertyClick(property.id)}
            />
          ))}
        </MarkerClusterGroup>
      </MapContainer>

      {onSearchThisArea && currentBounds && (
        <button
          onClick={handleSearchThisArea}
          disabled={isSearching}
          className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-[999] bg-white border border-gray-300 rounded-lg px-4 py-2 shadow hover:bg-gray-50 disabled:opacity-50 transition text-sm font-medium text-gray-700"
          aria-label="Search properties in current map area"
        >
          {isSearching ? 'Searching...' : 'Search this area'}
        </button>
      )}

      {validProperties.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/80 text-gray-500 text-sm pointer-events-none">
          No properties with location data
        </div>
      )}
    </div>
  );
}
