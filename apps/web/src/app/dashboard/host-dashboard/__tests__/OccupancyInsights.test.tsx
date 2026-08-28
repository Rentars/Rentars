import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import OccupancyInsights from '../components/OccupancyInsights';

// Helper: extract the progress bar element
function getProgressBar(container: HTMLElement): HTMLElement {
  // The progress bar is the inner div inside the gray track div
  const bar = container.querySelector('.bg-blue-600.h-2.rounded-full') as HTMLElement;
  if (!bar) throw new Error('Progress bar element not found');
  return bar;
}

describe('OccupancyInsights — progress bar clamping (#428)', () => {
  it('renders a 50% progress bar for normal occupancy', () => {
    const { container } = render(
      <OccupancyInsights occupancy={{ bookedNights: 50, availableNights: 100 }} />
    );
    expect(getProgressBar(container).style.width).toBe('50%');
  });

  it('clamps a negative occupancy rate to 0% (lower bound)', () => {
    // bookedNights = 0, availableNights = 0 → calcOccupancyRate returns 0,
    // but we force a negative by passing a component with a mocked rate.
    // The simplest approach: booked = -5, available = 100 → rate = -5.
    const { container } = render(
      <OccupancyInsights occupancy={{ bookedNights: -5, availableNights: 100 }} />
    );
    // -5% must be clamped to 0%
    expect(getProgressBar(container).style.width).toBe('0%');
  });

  it('clamps an occupancy rate above 100 to 100% (upper bound)', () => {
    // bookedNights = 105, availableNights = 100 → rate = 105%
    const { container } = render(
      <OccupancyInsights occupancy={{ bookedNights: 105, availableNights: 100 }} />
    );
    // 105% must be clamped to 100%
    expect(getProgressBar(container).style.width).toBe('100%');
  });

  it('renders 0% for zero occupancy', () => {
    const { container } = render(
      <OccupancyInsights occupancy={{ bookedNights: 0, availableNights: 100 }} />
    );
    expect(getProgressBar(container).style.width).toBe('0%');
  });

  it('renders 100% for fully booked occupancy', () => {
    const { container } = render(
      <OccupancyInsights occupancy={{ bookedNights: 100, availableNights: 100 }} />
    );
    expect(getProgressBar(container).style.width).toBe('100%');
  });

  it('displays the numeric label without clamping (raw rate is shown)', () => {
    // The displayed text label should be the raw calculated rate, not the clamped value
    const { getByText } = render(
      <OccupancyInsights occupancy={{ bookedNights: 105, availableNights: 100 }} />
    );
    // Label shows the real occupancy rate (105.0%), not clamped
    expect(getByText('105.0%')).toBeTruthy();
  });
});
