'use client';

import { useEffect, useRef } from 'react';
import { useMapEvents } from 'react-leaflet';
import type { LatLngBounds } from 'leaflet';

interface BoundsListenerProps {
  onBoundsChanged: (bounds: LatLngBounds) => void;
  debounceMs?: number;
  /** Ignore pans/zooms smaller than this (degrees of latitude/longitude). */
  minMovementDegrees?: number;
}

export default function BoundsListener({
  onBoundsChanged,
  debounceMs = 400,
  minMovementDegrees = 0.01,
}: BoundsListenerProps) {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBoundsRef = useRef<LatLngBounds | null>(null);
  const callbackRef = useRef(onBoundsChanged);
  callbackRef.current = onBoundsChanged;

  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, []);

  const handleBoundsChange = (bounds: LatLngBounds) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Drop jitter immediately so a rapid pan cannot queue many requests.
    if (lastBoundsRef.current && !movedEnough(lastBoundsRef.current, bounds, minMovementDegrees)) {
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      if (!lastBoundsRef.current || !boundsEqual(lastBoundsRef.current, bounds)) {
        lastBoundsRef.current = bounds;
        callbackRef.current(bounds);
      }
    }, debounceMs);
  };

  useMapEvents({
    moveend: (e) => handleBoundsChange(e.target.getBounds()),
    zoomend: (e) => handleBoundsChange(e.target.getBounds()),
  });

  return null;
}

function movedEnough(a: LatLngBounds, b: LatLngBounds, threshold: number): boolean {
  return (
    Math.abs(a.getCenter().lat - b.getCenter().lat) >= threshold ||
    Math.abs(a.getCenter().lng - b.getCenter().lng) >= threshold ||
    Math.abs((a.getNorth() - a.getSouth()) - (b.getNorth() - b.getSouth())) >= threshold ||
    Math.abs((a.getEast() - a.getWest()) - (b.getEast() - b.getWest())) >= threshold
  );
}

function boundsEqual(a: LatLngBounds, b: LatLngBounds): boolean {
  const tolerance = 0.0001;
  return (
    Math.abs(a.getNorth() - b.getNorth()) < tolerance &&
    Math.abs(a.getSouth() - b.getSouth()) < tolerance &&
    Math.abs(a.getEast() - b.getEast()) < tolerance &&
    Math.abs(a.getWest() - b.getWest()) < tolerance
  );
}
