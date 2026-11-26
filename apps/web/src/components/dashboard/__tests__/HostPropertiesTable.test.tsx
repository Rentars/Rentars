import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HostPropertiesTable from '../HostPropertiesTable';
import type { HostProperty } from '@/hooks/useHostDashboard';

// jsdom doesn't implement matchMedia; stub it so useMediaQuery doesn't throw
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const makeProperty = (overrides: Partial<HostProperty> = {}): HostProperty => ({
  id: 'prop-1',
  title: 'Beach House',
  location: 'Malaga, Spain',
  price_per_night: 150,
  status: 'published',
  draft_status: 'active',
  moderation_state: 'approved',
  active_bookings: 1,
  total_bookings: 5,
  average_rating: 4.5,
  review_count: 10,
  images: [],
  created_at: '2026-01-01',
  ...overrides,
});

describe('HostPropertiesTable', () => {
  it('shows empty state when no properties', () => {
    render(<HostPropertiesTable properties={[]} total={0} page={1} totalPages={0} />);
    expect(screen.getByText(/No properties yet/i)).toBeTruthy();
  });

  it('renders properties with status badge', () => {
    render(
      <HostPropertiesTable
        properties={[makeProperty()]}
        total={1}
        page={1}
        totalPages={1}
      />
    );
    expect(screen.getByText('Beach House')).toBeTruthy();
    expect(screen.getByText('published')).toBeTruthy();
  });

  it('calls onFilterChange when status is changed', () => {
    const onFilterChange = vi.fn();
    render(
      <HostPropertiesTable
        properties={[]}
        total={0}
        page={1}
        totalPages={0}
        onFilterChange={onFilterChange}
      />
    );
    const select = screen.getByRole('combobox', { name: /filter by status/i });
    fireEvent.change(select, { target: { value: 'draft' } });
    expect(onFilterChange).toHaveBeenCalledWith('draft', '');
  });

  it('shows pagination when totalPages > 1', () => {
    render(
      <HostPropertiesTable
        properties={[makeProperty()]}
        total={25}
        page={1}
        totalPages={2}
      />
    );
    expect(screen.getByRole('button', { name: /next page/i })).toBeTruthy();
  });

  it('disables previous button on first page', () => {
    render(
      <HostPropertiesTable
        properties={[makeProperty()]}
        total={25}
        page={1}
        totalPages={2}
      />
    );
    expect(screen.getByRole('button', { name: /previous page/i }).hasAttribute('disabled')).toBe(true);
  });
});
