import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/tests/utils/test-utils';
import MapResultsList from '../MapResultsList';
import type { Property } from '@/types/property';

const properties: Property[] = [
  {
    id: 'id-1',
    title: 'Beach House',
    description: 'A lovely beach house',
    price_per_night: 100,
    location: 'Malibu, CA',
    images: [],
    owner_id: 'owner-1',
    available: true,
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'id-2',
    title: 'Mountain Cabin',
    description: 'A cozy mountain cabin',
    price_per_night: 80,
    location: 'Aspen, CO',
    images: [],
    owner_id: 'owner-2',
    available: false,
    created_at: '2024-01-02T00:00:00Z',
  },
];

describe('MapResultsList', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView, which focus management calls.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  });

  it('exposes property, price and availability without needing the map', () => {
    render(<MapResultsList properties={properties} onSelect={vi.fn()} />);

    expect(
      screen.getByRole('heading', { name: 'Properties on map (2)' }),
    ).toBeInTheDocument();

    // Listing 1:
    expect(screen.getByText('Beach House')).toBeInTheDocument();
    expect(screen.getByText('Malibu, CA')).toBeInTheDocument();
    expect(screen.getByText('100 USDC/night')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();

    // Listing 2:
    expect(screen.getByText('Mountain Cabin')).toBeInTheDocument();
    expect(screen.getByText('Aspen, CO')).toBeInTheDocument();
    expect(screen.getByText('80 USDC/night')).toBeInTheDocument();
    expect(screen.getByText('Booked')).toBeInTheDocument();
  });

  it('renders a native button per listing, reachable by keyboard', () => {
    render(<MapResultsList properties={properties} onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON'); // natively focusable + Enter-activatable
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('selects a listing and reports the list as the source', () => {
    const onSelect = vi.fn();
    render(<MapResultsList properties={properties} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Beach House/ }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('id-1', 'list');
  });

  it('marks the synchronised selection with aria-current', () => {
    render(
      <MapResultsList properties={properties} selectedId="id-2" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /Mountain Cabin/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('button', { name: /Beach House/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('announces the selected listing in a polite live region', () => {
    render(
      <MapResultsList properties={properties} selectedId="id-1" onSelect={vi.fn()} />,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(
      'Selected Beach House. 100 USDC per night. Available.',
    );
  });

  it('moves focus to the list item requested by the map (keyboard pin activation)', () => {
    const { rerender } = render(
      <MapResultsList
        properties={properties}
        onSelect={vi.fn()}
        focusRequest={{ id: 'id-2', nonce: 1 }}
      />,
    );

    const cabinButton = screen.getByRole('button', { name: /Mountain Cabin/ });
    expect(cabinButton).toHaveFocus();

    // A second activation (new nonce) moves focus to the newly selected item:
    rerender(
      <MapResultsList
        properties={properties}
        onSelect={vi.fn()}
        focusRequest={{ id: 'id-1', nonce: 2 }}
      />,
    );

    expect(screen.getByRole('button', { name: /Beach House/ })).toHaveFocus();
  });

  it('offers a details control per listing when onOpen is provided', () => {
    const onOpen = vi.fn();
    render(
      <MapResultsList properties={properties} onSelect={vi.fn()} onOpen={onOpen} />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'View details for Beach House' }),
    );

    expect(onOpen).toHaveBeenCalledWith('id-1');
  });

  it('shows an announced, fixed-size skeleton while loading', () => {
    render(<MapResultsList properties={[]} onSelect={vi.fn()} loading />);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('aria-label', 'Loading map results…');
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

    // Loading must not masquerade as "no results":
    expect(
      screen.queryByText('No properties with location data'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('distinguishes an empty result set from a failure', () => {
    render(<MapResultsList properties={[]} onSelect={vi.fn()} />);

    expect(
      screen.getByText('No properties with location data'),
    ).toBeInTheDocument();
    // "No data" is a status, never an error:
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
