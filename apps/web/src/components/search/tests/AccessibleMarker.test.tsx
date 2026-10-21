import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@/tests/utils/test-utils';
import AccessibleMarker from '../AccessibleMarker';
import type { Icon } from 'leaflet';

/**
 * react-leaflet renders markers through Leaflet, which has no DOM presence in
 * jsdom. The mock mirrors exactly what these tests depend on:
 *
 * - a bare icon element with NO ARIA semantics (like a real Leaflet icon), so
 *   we can prove AccessibleMarker applies them imperatively;
 * - `eventHandlers` routed from native DOM events (as Leaflet does);
 * - a marker ref exposing `getElement()` / `fire()`.
 */
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

    // Native listeners, like Leaflet's own DomEvent wiring — independent of
    // React's synthetic event system.
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

const icon = {} as Icon;

describe('AccessibleMarker', () => {
  it('exposes the marker as a focusable, labelled button', () => {
    render(<AccessibleMarker position={[34.02, -118.77]} icon={icon} label="Beach House" />);

    const marker = screen.getByTestId('marker-icon');
    expect(marker).toHaveAttribute('role', 'button');
    expect(marker).toHaveAttribute('tabindex', '0');
    expect(marker).toHaveAttribute('aria-label', 'Beach House');
    expect(marker).not.toHaveAttribute('aria-pressed');

    // Reachable through the accessibility tree under its label:
    expect(screen.getByRole('button', { name: 'Beach House' })).toBe(marker);
  });

  it('keeps aria-label in sync when the label changes', () => {
    const { rerender } = render(<AccessibleMarker position={[0, 0]} icon={icon} label="Old" />);
    expect(screen.getByTestId('marker-icon')).toHaveAttribute('aria-label', 'Old');

    rerender(<AccessibleMarker position={[0, 0]} icon={icon} label="New" />);
    expect(screen.getByTestId('marker-icon')).toHaveAttribute('aria-label', 'New');
  });

  it('toggles aria-pressed with the selected state', () => {
    const { rerender } = render(<AccessibleMarker position={[0, 0]} icon={icon} label="Cabin" />);
    expect(screen.getByTestId('marker-icon')).not.toHaveAttribute('aria-pressed');

    rerender(<AccessibleMarker position={[0, 0]} icon={icon} label="Cabin" selected />);
    expect(screen.getByTestId('marker-icon')).toHaveAttribute('aria-pressed', 'true');

    rerender(<AccessibleMarker position={[0, 0]} icon={icon} label="Cabin" selected={false} />);
    expect(screen.getByTestId('marker-icon')).not.toHaveAttribute('aria-pressed');
  });

  it('reports pointer activation and delegates the click handler', () => {
    const onSelect = vi.fn();
    const click = vi.fn();
    render(
      <AccessibleMarker
        position={[0, 0]}
        icon={icon}
        label="Cabin"
        onSelect={onSelect}
        eventHandlers={{ click }}
      />,
    );

    fireEvent.click(screen.getByTestId('marker-icon'));

    expect(click).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('pointer');
  });

  it('activates on Space, prevents page scroll, and reports keyboard source', () => {
    const onSelect = vi.fn();
    const keypress = vi.fn();
    const click = vi.fn();
    render(
      <AccessibleMarker
        position={[0, 0]}
        icon={icon}
        label="Cabin"
        onSelect={onSelect}
        eventHandlers={{ keypress, click }}
      />,
    );

    const marker = screen.getByTestId('marker-icon');
    const space = createEvent.keyPress(marker, { key: ' ', code: 'Space', cancelable: true });
    fireEvent(marker, space);

    // The page must not scroll while focus is on a pin:
    expect(space.defaultPrevented).toBe(true);
    // Delegation still happens for the original handler:
    expect(keypress).toHaveBeenCalledTimes(1);
    // Space activates the marker by firing its click, exactly once:
    expect(click).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('keyboard');
  });

  it('does not activate on non-Space keys', () => {
    const onSelect = vi.fn();
    const keypress = vi.fn();
    render(
      <AccessibleMarker
        position={[0, 0]}
        icon={icon}
        label="Cabin"
        onSelect={onSelect}
        eventHandlers={{ keypress }}
      />,
    );

    const marker = screen.getByTestId('marker-icon');
    fireEvent.keyPress(marker, { key: 'a' });

    expect(keypress).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
