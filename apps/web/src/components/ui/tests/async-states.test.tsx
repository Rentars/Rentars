import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/tests/utils/test-utils';
import {
  BookingListSkeleton,
  DashboardSummarySkeleton,
  EmptyState,
  ErrorState,
  SkeletonRegion,
  StatusAnnouncer,
  TableRowsSkeleton,
} from '../async-states';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('StatusAnnouncer', () => {
  it('is a visually-hidden polite live region', () => {
    render(<StatusAnnouncer message="3 bookings loaded" />);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    expect(region).toHaveClass('sr-only');
    expect(region).toHaveTextContent('3 bookings loaded');
  });

  it('clears the announcement when given an empty message', () => {
    render(<StatusAnnouncer message="" />);

    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
  });
});

describe('EmptyState', () => {
  it('announces "no data" politely as a status, never an alert', () => {
    const { container } = render(
      <EmptyState title="No properties found" description="Try a different search." />,
    );

    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('No properties found');
    expect(region).toHaveTextContent('Try a different search.');
    expect(screen.queryByRole('alert')).toBeNull();
    // Stable height: loading → empty → results must not reflow the page.
    expect(region.className).toContain('min-h-[240px]');
    expect(container.firstChild).toBe(region);
  });

  it('renders an optional action control', () => {
    render(<EmptyState title="Nothing yet" action={<button type="button">Clear filters</button>} />);

    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('announces failures via role=alert with a retry control', () => {
    const { container } = render(<ErrorState message="Search failed" onRetry={() => {}} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('Search failed');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // Same stable minimum height as EmptyState so state swaps do not reflow.
    expect(alert.className).toContain('min-h-[240px]');
    expect(container.firstChild).toBe(alert);
  });

  it('renders the compact inline variant without the block title', () => {
    render(<ErrorState variant="inline" message="Could not load house rules" onRetry={() => {}} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load house rules');
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('fires only one retry for an impatient double click', async () => {
    const d = deferred<void>();
    const onRetry = vi.fn(() => d.promise);
    render(<ErrorState message="Search failed" onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(button);
    fireEvent.click(button); // second click lands before React re-renders

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      d.resolve();
    });

    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('re-enables retry after the retry promise rejects', async () => {
    const onRetry = vi.fn(() => Promise.reject(new Error('still failing')));
    render(<ErrorState message="Search failed" onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  it('respects an externally-controlled retrying flag', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Search failed" onRetry={onRetry} retrying />);

    const button = screen.getByRole('button', { name: /try again/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    // A click that slips through while busy must not fire the request either.
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('omits the retry button when no handler is given', () => {
    render(<ErrorState message="Search failed" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('loading skeletons', () => {
  it('SkeletonRegion is an accessible busy region with a stable height', () => {
    const { container } = render(
      <SkeletonRegion label="Loading summary">
        <div data-testid="skeleton-body" />
      </SkeletonRegion>,
    );

    const region = screen.getByRole('status', { name: 'Loading summary' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region.className).toContain('min-h-[240px]');
    expect(region).toHaveTextContent('Loading summary');
    expect(screen.getByTestId('skeleton-body')).toBeInTheDocument();
    expect(container.firstChild).toBe(region);
  });

  it('DashboardSummarySkeleton renders 4 fixed-height cards', () => {
    const { container } = render(<DashboardSummarySkeleton />);

    const cards = container.querySelectorAll('[class*="animate-pulse"]');
    expect(cards).toHaveLength(4);
    cards.forEach((card) => expect(card.className).toContain('h-28'));
  });

  it('DashboardSummarySkeleton honours a custom count', () => {
    const { container } = render(<DashboardSummarySkeleton count={2} />);

    expect(container.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(2);
  });

  it('TableRowsSkeleton renders the requested rows at a fixed height', () => {
    const { container } = render(<TableRowsSkeleton rows={5} />);

    const rows = container.querySelectorAll('[class*="animate-pulse"]');
    expect(rows).toHaveLength(5);
    rows.forEach((row) => expect(row.className).toContain('h-16'));
  });

  it('BookingListSkeleton renders stacked card placeholders', () => {
    const { container } = render(<BookingListSkeleton />);

    expect(container.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(3);
  });
});
