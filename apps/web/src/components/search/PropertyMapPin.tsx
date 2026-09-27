'use client';

import { useRef } from 'react';
import { Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Property } from '@/types/property';
import PropertyMapPopup from './PropertyMapPopup';

export interface PropertyMapPinProps {
  property: Property;
  onClick?: () => void;
}

/**
 * Creates an accessible DivIcon that is reachable and operable via keyboard.
 *
 * The pin element itself carries:
 *   - role="button"  — identifies it as interactive to AT
 *   - tabindex="0"   — places it in the natural tab order
 *   - aria-label     — announces property title + price to screen readers
 *   - data-property-id — used by the keydown handler to locate the element
 *
 * Focus styling (.rentars-pin--focus) is toggled programmatically and also
 * applied by the :focus-visible CSS rule in globals.css.
 */
function makePinIcon(property: Property): L.DivIcon {
  const price = (property as any).price_per_night ?? '';
  const label = `${property.title}${price ? `, $${price} per night` : ''}`;
  return new L.DivIcon({
    className: 'rentars-pin',
    // iconAnchor centres the pin horizontally; iconSize is intentionally
    // undefined so Leaflet does not clip the shadow ring on focus.
    html: `
      <div
        role="button"
        tabindex="0"
        aria-label="${label.replace(/"/g, '&quot;')}"
        data-property-id="${(property as any).id ?? ''}"
        style="position:relative;outline:none;"
      >
        <div class="rentars-pin__dot" style="
          width:28px;height:28px;border-radius:9999px;
          background:#2563eb;color:white;
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 8px 20px rgba(0,0,0,.25);font-weight:800;
          transition:box-shadow 0.15s,transform 0.15s;
        ">★</div>
      </div>
    `,
  });
}

export default function PropertyMapPin({ property, onClick }: PropertyMapPinProps) {
  const lat = (property as any).lat as number | undefined;
  const lng = (property as any).lng as number | undefined;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const markerRef = useRef<L.Marker | null>(null);
  const map = useMap();

  /**
   * After the Marker mounts, wire up keyboard events to the underlying
   * DOM element that Leaflet created from the DivIcon HTML.
   * We use a ref callback to access the Leaflet Marker instance.
   */
  const handleMarkerRef = (marker: L.Marker | null) => {
    markerRef.current = marker;
    if (!marker) return;

    const el = marker.getElement();
    if (!el) return;

    // The interactive child element carries role="button"
    const btn = el.querySelector<HTMLElement>('[role="button"]');
    if (!btn) return;

    // Keyboard: Enter / Space → open popup + trigger onClick callback
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        // Pan map to marker so popup fits in viewport
        map.panTo([lat, lng]);
        marker.openPopup();
        onClick?.();
      }
    };

    // Visible focus ring via class toggle (CSS in globals.css)
    const onFocus = () => btn.classList.add('rentars-pin--focused');
    const onBlur  = () => btn.classList.remove('rentars-pin--focused');

    btn.addEventListener('keydown', onKeyDown);
    btn.addEventListener('focus',   onFocus);
    btn.addEventListener('blur',    onBlur);
  };

  return (
    <Marker
      position={[lat, lng]}
      icon={makePinIcon(property)}
      ref={handleMarkerRef}
      eventHandlers={{
        click: () => onClick?.(),
      }}
    >
      <PropertyMapPopup property={property} onClick={onClick} />
    </Marker>
  );
}
