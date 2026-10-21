'use client';

import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

interface MapSelectionControllerProps {
  /** [lat, lng] of the selected listing, or null when nothing is selected. */
  position: [number, number] | null;
  /** Minimum zoom so a selected pin is always clearly visible. */
  minZoom?: number;
}

/**
 * MapSelectionController — child of `MapContainer` that keeps the selected
 * listing in view. Pan only (never re-centre via a container remount) so the
 * map, its focus, and its scroll position stay predictable.
 */
export default function MapSelectionController({
  position,
  minZoom = 12,
}: MapSelectionControllerProps) {
  const map = useMap();

  const key = position ? `${position[0]},${position[1]}` : '';

  useEffect(() => {
    if (!position) return;
    const zoom = Math.max(map.getZoom(), minZoom);
    map.setView(position, zoom, { animate: true });
    // `key` is the stable identity of the position pair.
  }, [map, key, minZoom]);

  return null;
}
