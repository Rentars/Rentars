import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@/tests/utils/test-utils';
import PropertyMapPin, { pinAccessibleName, PIN_FALLBACK_LABEL } from '../PropertyMapPin';
import type { Property } from '@/types/property';

// See AccessibleMarker.test.tsx for the rationale behind this mock: a bare
// icon element + marker ref, exactly like Leaflet's imperative icon DOM.
vi.mock('react-leaflet', async () => {
  const React = await import('react');

  type MarkerEvent = { type: string; originalEvent?: Event };
  type MarkerHandlers = Record<string, ((event: MarkerEvent) => void) | undefined>;

  interface MockMarkerProps {
    position?: unknown;
    icon?: unknown;
    keyboard?: boolean;
    eventHandlers?: MarkerHandlers;
    children?: React.ReactNode;
  }

  const Marker = React.forwardRef<unknown, MockMarkerProps>(function Marker(props, ref) {
    const elementRef = React.useRef<HTMLDivElement | null>(null);
    const handlersRef = React.useRef<MarkerHandlers | undefined>(props.eventHandlers);
    handlersRef.current = props.eventHandlers;

    React.useImperativeHandle(ref, () => ({
      getElement: () => elementRef.current,
      fire: (type: string, event?: Record<string, unknown>) => {
        handlersRef.current?.[type]?.({ type, ...event });
      },
    }));

    React.useEffect(() => {
      const element = elementRef.current;
      if (!element) return;
      const handleClick = (e: Event) =>
        handlersRef.current?.click?.({ type: 'click', originalEvent: e });
      const handleKeyPress = (e: Event) =>
        handlersRef.current?.keypress?.({ type: 'keypress', originalEvent: e });
      element.addEventListener('click', handleClick);
      element.addEventListener('keypress', handleKeyPress);
      return () => {
        element.removeEventListener('click', handleClick);
        element.removeEventListener('keypress', handleKeyPress);
      };
    }, []);

    return <div ref={elementRef} data-testid="marker-icon">{props.children}</div>;
  });
  Marker.displayName = 'Marker';

  return { Marker };
});

// The popup is covered elsewhere and would otherwise add a second button to
// the accessible tree, complicating name queries.
vi.mock('../PropertyMapPopup', () => ({ default: () => null }));

const property: Property & { lat: number; lng: number } = {
  id: 'prop-1',
  title: 'Beach House',
  description: 'A lovely beach house',
  price_per_night: 100,
  location: 'Malibu, CA',
  images: [],
  owner_id: 'owner-1',
  available: true,
  created_at: '2024-01-01T00:00:00Z',
  lat: 34.0259,
  lng: -118.7798,
};

describe('pinAccessibleName', () => {
  it('uses the property title as the accessible name', () => {
    expect(pinAccessibleName({ title: 'Beach House' })).toBe('Beach House');
  });

  it('trims surrounding whitespace', () => {
    expect(pinAccessibleName({ title: '  Beach House \n' })).toBe('Beach House');
  });

  it('falls back for whitespace-only titles', () => {
    expect(pinAccessibleName({ title: '   ' })).toBe(PIN_FALLBACK_LABEL);
  });

  it('falls back for missing, empty or null titles', () => {
    expect(pinAccessibleName({})).toBe(PIN_FALLBACK_LABEL);
    expect(pinAccessibleName({ title: '' })).toBe(PIN_FALLBACK_LABEL);
    expect(pinAccessibleName({ title: null })).toBe(PIN_FALLBACK_LABEL);
    expect(pinAccessibleName({ title: undefined })).toBe(PIN_FALLBACK_LABEL);
  });

  it('always produces a non-empty name — never "undefined" or an id', () => {
    for (const title of [undefined, null, '', '   ']) {
      const name = pinAccessibleName({ title });
      expect(name.trim().length).toBeGreaterThan(0);
      expect(name).not.toContain('undefined');
      expect(name).not.toContain('null');
    }
  });

  it('preserves special characters in real titles', () => {
    const title = 'Café & Cabin <3> "Cozy" — 2BR';
    expect(pinAccessibleName({ title })).toBe(title);
  });
});

describe('PropertyMapPin', () => {
  it('renders a focusable pin named after the property', () => {
    render(<PropertyMapPin property={property} />);

    const pin = screen.getByRole('button', { name: 'Beach House' });
    expect(pin).toHaveAttribute('tabindex', '0');
    expect(pin).toHaveAttribute('aria-label', 'Beach House');
  });

  it('uses the generic fallback label when the title is unusable', () => {
    render(<PropertyMapPin property={{ ...property, title: '   ' }} />);

    const pin = screen.getByRole('button', { name: PIN_FALLBACK_LABEL });
    expect(pin).toHaveAttribute('aria-label', PIN_FALLBACK_LABEL);
  });

  it('exposes the selected state via aria-pressed', () => {
    const { rerender } = render(<PropertyMapPin property={property} />);
    expect(screen.getByTestId('marker-icon')).not.toHaveAttribute('aria-pressed');

    rerender(<PropertyMapPin property={property} selected />);
    expect(screen.getByTestId('marker-icon')).toHaveAttribute('aria-pressed', 'true');

    rerender(<PropertyMapPin property={property} selected={false} />);
    expect(screen.getByTestId('marker-icon')).not.toHaveAttribute('aria-pressed');
  });

  it('keeps click behaviour: reports the selection and invokes onClick', () => {
    const onSelect = vi.fn();
    const onClick = vi.fn();
    render(<PropertyMapPin property={property} onSelect={onSelect} onClick={onClick} />);

    fireEvent.click(screen.getByTestId('marker-icon'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('pointer');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates from the keyboard (Space) and reports keyboard source', () => {
    const onSelect = vi.fn();
    const onClick = vi.fn();
    render(<PropertyMapPin property={property} onSelect={onSelect} onClick={onClick} />);

    const marker = screen.getByTestId('marker-icon');
    const space = createEvent.keyPress(marker, { key: ' ', code: 'Space', cancelable: true });
    fireEvent(marker, space);

    expect(space.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('keyboard');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the property has no coordinates', () => {
    render(
      <PropertyMapPin
        property={{ ...property, lat: undefined, lng: undefined } as unknown as Property}
      />,
    );

    expect(screen.queryByTestId('marker-icon')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
