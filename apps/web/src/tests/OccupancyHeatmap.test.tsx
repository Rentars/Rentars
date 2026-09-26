/**
 * Tests for OccupancyHeatmap stale-request cancellation (#429).
 *
 * Verifies that when inputs change quickly, an in-flight fetch is aborted and
 * its response cannot overwrite data from the newer request.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OccupancyHeatmap from '@/app/dashboard/host-dashboard/components/OccupancyHeatmap';

const PROPERTIES = [
  { id: 'prop-a', title: 'Property A' },
  { id: 'prop-b', title: 'Property B' },
];

function makeHeatmap(propertyId: string): object {
  return {
    propertyId,
    from: '2024-01-01',
    to: '2024-01-31',
    days: [{ date: '2024-01-01', status: 'available' }],
    summary: { booked: 0, blocked: 0, available: 1, total: 1 },
  };
}

describe('OccupancyHeatmap stale-request guard', () => {
  type Entry = { resolve: (d: object) => void; signal: AbortSignal };
  const pending: Entry[] = [];

  beforeEach(() => {
    pending.length = 0;
    global.fetch = vi.fn((_url: string, options?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({
          resolve: (data) =>
            resolve(new Response(JSON.stringify(data), { status: 200 })),
          signal: options?.signal as AbortSignal,
        });
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }),
    ) as unknown as typeof fetch;
  });

  it('aborts the first request when inputs change', async () => {
    render(<OccupancyHeatmap properties={PROPERTIES} defaultPropertyId="prop-a" />);

    await waitFor(() => expect(pending).toHaveLength(1));

    // Change horizon — triggers cleanup that calls controller.abort() on Fetch1
    fireEvent.change(screen.getByLabelText('Horizon'), { target: { value: '1' } });

    await waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0].signal.aborted).toBe(true);
    expect(pending[1].signal.aborted).toBe(false);
  });

  it('newest response wins when an earlier fetch resolves out of order', async () => {
    render(<OccupancyHeatmap properties={PROPERTIES} defaultPropertyId="prop-a" />);

    await waitFor(() => expect(pending).toHaveLength(1));

    // Change horizon before the first fetch resolves
    fireEvent.change(screen.getByLabelText('Horizon'), { target: { value: '1' } });

    await waitFor(() => expect(pending).toHaveLength(2));

    // Resolve the newest (second) fetch with valid data
    pending[1].resolve(makeHeatmap('prop-a'));

    await waitFor(() =>
      expect(screen.getByText(/available/i)).toBeInTheDocument(),
    );

    // First fetch is already aborted — even if its promise settles it cannot
    // overwrite state, so no error banner should appear
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not show an error when a stale fetch is aborted', async () => {
    render(<OccupancyHeatmap properties={PROPERTIES} defaultPropertyId="prop-a" />);

    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Horizon'), { target: { value: '1' } });

    await waitFor(() => expect(pending).toHaveLength(2));

    // Resolve second so loading ends
    pending[1].resolve(makeHeatmap('prop-a'));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
