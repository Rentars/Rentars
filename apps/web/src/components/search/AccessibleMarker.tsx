'use client';

import { useEffect, useRef } from 'react';
import { Marker } from 'react-leaflet';
import type { MarkerProps } from 'react-leaflet';
import type { Icon, LatLngExpression, LeafletEvent, Marker as LeafletMarker } from 'leaflet';

/** How a pin was activated — used to decide where focus should land. */
export type PinSelectSource = 'pointer' | 'keyboard';

type EventHandler = (event: LeafletEvent) => void;

export interface AccessibleMarkerProps {
  position: LatLngExpression;
  icon: Icon;
  /**
   * Accessible name for the pin. MUST be non-empty — compute it with
   * `pinAccessibleName()` so a missing title never yields "undefined".
   */
  label: string;
  /** Marks the pin as selected (`aria-pressed="true"`). */
  selected?: boolean;
  /** Fired on every activation: mouse click, Enter, or Space. */
  onSelect?: (source: PinSelectSource) => void;
  /** Extra Leaflet handlers (delegated before the built-in behaviour). */
  eventHandlers?: Record<string, EventHandler | undefined>;
  /**
   * Called when the marker's popup closes (including Escape). Focus is returned
   * to the originating pin when the interaction started from the keyboard.
   */
  onClose?: () => void;
  children?: React.ReactNode;
}

/**
 * AccessibleMarker — a react-leaflet `Marker` that assistive technology can
 * actually use.
 *
 * Leaflet renders markers as bare `<div>` icons: not focusable, no role, no
 * name. This wrapper re-applies the semantics imperatively (Leaflet replaces
 * the icon element whenever the icon changes, so they cannot live in JSX):
 *
 * - `role="button"` + `tabindex="0"` → reachable and announced as a button;
 * - `aria-label` → the visible pill text is decorative, the label carries
 *   title + price for screen readers;
 * - `aria-pressed` → synchronises the selected listing with the result list;
 * - Enter already activates a marker in Leaflet; Space is handled here, with
 *   `preventDefault()` so the page does not scroll while focus is on a pin.
 *
 * `onSelect` reports whether activation came from a pointer or the keyboard so
 * callers can move focus predictably (keyboard users are taken to the matching
 * list item; pointer users stay where they are).
 */
export default function AccessibleMarker({
  position,
  icon,
  label,
  selected = false,
  onSelect,
  eventHandlers,
  onClose,
  children,
}: AccessibleMarkerProps) {
  const markerRef = useRef<LeafletMarker | null>(null);
  const keyboardActivationRef = useRef(false);

  // ARIA semantics must be re-applied whenever the icon element is (re)created.
  // react-leaflet applies prop updates in its own effects, which run before
  // this parent effect, so `getElement()` returns the current element here.
  useEffect(() => {
    const element = markerRef.current?.getElement?.() ?? null;
    if (!element) return;
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.setAttribute('aria-label', label);
    if (selected) {
      element.setAttribute('aria-pressed', 'true');
    } else {
      element.removeAttribute('aria-pressed');
    }
  }, [label, selected, icon]);

  // Leaflet fires `popupclose` on the marker for pointer closes, Escape and
  // programmatic closes. Return focus to the pin for keyboard users so they
  // are never stranded inside a removed popup.
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker?.on) return;
    const handlePopupClose = () => {
      if (keyboardActivationRef.current) {
        marker.getElement?.()?.focus();
        keyboardActivationRef.current = false;
      }
      onClose?.();
    };
    marker.on('popupclose', handlePopupClose);
    return () => {
      marker.off?.('popupclose', handlePopupClose);
    };
  }, [onClose]);

  const handleClick: EventHandler = (event) => {
    eventHandlers?.click?.(event);
    const source: PinSelectSource = keyboardActivationRef.current ? 'keyboard' : 'pointer';
    if (source === 'pointer') keyboardActivationRef.current = false;
    onSelect?.(source);
  };

  const handleKeypress: EventHandler = (event) => {
    eventHandlers?.keypress?.(event);
    const original = (event as { originalEvent?: KeyboardEvent }).originalEvent;
    // Leaflet activates markers on Enter; without this, Space would scroll the
    // page instead of selecting the listing.
    if (original?.key === 'Enter') {
      // Leaflet activates the marker itself on Enter; remember the input source
      // so a later Escape/popup close can restore focus here.
      keyboardActivationRef.current = true;
      return;
    }
    if (original && (original.key === ' ' || original.key === 'Spacebar')) {
      original.preventDefault();
      keyboardActivationRef.current = true;
      markerRef.current?.fire('click');
    }
  };

  // react-leaflet types each handler with its concrete Leaflet event type;
  // this map only ever carries marker events, so a structural cast is safe.
  const handlers = {
    click: handleClick,
    keypress: handleKeypress,
  } as unknown as NonNullable<MarkerProps['eventHandlers']>;

  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={icon}
      keyboard
      eventHandlers={handlers}
    >
      {children}
    </Marker>
  );
}
