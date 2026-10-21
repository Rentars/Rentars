'use client';

import { useMemo } from 'react';
import L from 'leaflet';
import type { Property } from '@/types/property';
import AccessibleMarker from './AccessibleMarker';
import { pinAccessibleName } from './PropertyMapPin';
import PropertyMapPopup from './PropertyMapPopup';

interface PriceMarkerProps {
  property: Property & { lat: number; lng: number };
  /** Selected state — synchronised with the results list via aria-pressed. */
  active?: boolean;
  /** Fired when the pin is activated (click, Enter, or Space). */
  onSelect?: (source: 'pointer' | 'keyboard') => void;
  onClick?: () => void;
}

function makeIcon(price: number, active: boolean) {
  const bg = active ? '#1d4ed8' : '#2563eb';
  const label = price >= 1000 ? `$${Math.round(price / 1000)}k` : `$${price}`;
  return new L.DivIcon({
    className: '',
    iconSize: undefined,
    html: `<div style="
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
      transition: transform 0.15s;
    ">${label}</div>`,
  });
}

export default function PriceMarker({
  property,
  active = false,
  onSelect,
  onClick,
}: PriceMarkerProps) {
  // Memoised so Leaflet does not rebuild (and replace) the icon element on
  // every render — which would also discard the pin's ARIA attributes.
  const icon = useMemo(
    () => makeIcon(property.price_per_night, active),
    [property.price_per_night, active],
  );

  // Visible text stays the price pill; screen readers get the full name.
  const label = `${pinAccessibleName(property)}, ${property.price_per_night} USDC per night`;

  return (
    <AccessibleMarker
      position={[property.lat, property.lng]}
      icon={icon}
      label={label}
      selected={active}
      onSelect={onSelect}
      eventHandlers={onClick ? { click: () => onClick() } : undefined}
    >
      <PropertyMapPopup property={property} onClick={onClick} />
    </AccessibleMarker>
  );
}
