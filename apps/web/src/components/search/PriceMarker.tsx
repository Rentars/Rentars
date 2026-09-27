'use client';

import { useRef } from 'react';
import { Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Property } from '@/types/property';
import PropertyMapPopup from './PropertyMapPopup';

interface PriceMarkerProps {
  property: Property & { lat: number; lng: number };
  active?: boolean;
  onClick?: () => void;
}

function makeIcon(property: Property & { lat: number; lng: number }, active: boolean) {
  const bg    = active ? '#1d4ed8' : '#2563eb';
  const price = property.price_per_night;
  const label = price >= 1000 ? `$${Math.round(price / 1000)}k` : `$${price}`;
  const ariaLabel = `${property.title}, $${price} per night${active ? ', selected' : ''}`;

  return new L.DivIcon({
    className: '',
    iconSize: undefined,
    html: `
      <div
        role="button"
        tabindex="0"
        aria-label="${ariaLabel.replace(/"/g, '&quot;')}"
        aria-pressed="${active}"
        data-property-id="${(property as any).id ?? ''}"
        style="outline:none;"
      >
        <div class="rentars-price-marker${active ? ' rentars-price-marker--active' : ''}" style="
          background:${bg};
          color:white;
          font-size:12px;
          font-weight:700;
          padding:4px 8px;
          border-radius:20px;
          white-space:nowrap;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
          border: 2px solid ${active ? '#93c5fd' : 'transparent'};
          transform: ${active ? 'scale(1.15)' : 'scale(1)'};
          transition: transform 0.15s, box-shadow 0.15s;
        ">${label}</div>
      </div>
    `,
  });
}

export default function PriceMarker({ property, active = false, onClick }: PriceMarkerProps) {
  const markerRef = useRef<L.Marker | null>(null);
  const map = useMap();

  const handleMarkerRef = (marker: L.Marker | null) => {
    markerRef.current = marker;
    if (!marker) return;

    const el = marker.getElement();
    if (!el) return;

    const btn = el.querySelector<HTMLElement>('[role="button"]');
    if (!btn) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        map.panTo([property.lat, property.lng]);
        marker.openPopup();
        onClick?.();
      }
    };

    const onFocus = () => btn.classList.add('rentars-price-marker--focused');
    const onBlur  = () => btn.classList.remove('rentars-price-marker--focused');

    btn.addEventListener('keydown', onKeyDown);
    btn.addEventListener('focus',   onFocus);
    btn.addEventListener('blur',    onBlur);
  };

  return (
    <Marker
      position={[property.lat, property.lng]}
      icon={makeIcon(property, active)}
      ref={handleMarkerRef}
      eventHandlers={{
        click: () => onClick?.(),
      }}
    >
      <PropertyMapPopup property={property} onClick={onClick} />
    </Marker>
  );
}
