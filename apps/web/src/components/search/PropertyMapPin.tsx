'use client';

import L from 'leaflet';
import type { Property } from '@/types/property';
import AccessibleMarker from './AccessibleMarker';
import PropertyMapPopup from './PropertyMapPopup';

/** Generic fallback for pins whose property has no usable title. */
export const PIN_FALLBACK_LABEL = 'Property location';

/**
 * Compute the accessible name for a property map pin.
 *
 * - Uses the property title when it contains anything other than whitespace.
 * - Falls back to a fixed, meaningful generic label — never to `undefined`,
 *   `null`, an empty string, whitespace, or an internal id — so screen reader
 *   users always get a usable, stable name.
 *
 * @example pinAccessibleName({ title: '  Beach House ' }) // 'Beach House'
 * @example pinAccessibleName({ title: '   ' })            // 'Property location'
 * @example pinAccessibleName({})                          // 'Property location'
 */
export function pinAccessibleName(
  property: Pick<Property, 'title'> | { title?: string | null },
): string {
  const title = typeof property.title === 'string' ? property.title.trim() : '';
  return title.length > 0 ? title : PIN_FALLBACK_LABEL;
}

// Module-level so the DivIcon instance (and therefore the marker element) is
// reused across renders instead of being rebuilt on every state change.
const pinIcon = new L.DivIcon({
  className: 'rentars-pin',
  html: `
    <div style="position:relative;">
      <div style="width:26px;height:26px;border-radius:9999px;background:#2563eb;color:white;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 20px rgba(0,0,0,.25);font-weight:800;">★</div>
    </div>
  `,
});

export interface PropertyMapPinProps {
  property: Property;
  /** Selected state — synchronised with the results list via aria-pressed. */
  selected?: boolean;
  /** Fired when the pin is activated (click, Enter, or Space). */
  onSelect?: (source: 'pointer' | 'keyboard') => void;
  onClick?: () => void;
}

/**
 * A keyboard- and screen-reader-operable map pin.
 *
 * The pin is focusable (`tabindex="0"`), has `role="button"` and a guaranteed
 * non-empty accessible name (title, or `PIN_FALLBACK_LABEL`). Enter and Space
 * both activate it, and the selected state is exposed via `aria-pressed` so it
 * stays in sync with the property list fallback rendered next to the map.
 */
export default function PropertyMapPin({
  property,
  selected,
  onSelect,
  onClick,
}: PropertyMapPinProps) {
  const lat = (property as any).lat as number | undefined;
  const lng = (property as any).lng as number | undefined;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  return (
    <AccessibleMarker
      position={[lat, lng]}
      icon={pinIcon}
      label={pinAccessibleName(property)}
      selected={selected}
      onSelect={onSelect}
      eventHandlers={onClick ? { click: () => onClick() } : undefined}
    >
      {/* Click opens popup; also allow explicit callback */}
      <PropertyMapPopup property={property} onClick={onClick} />
    </AccessibleMarker>
  );
}
