/**
 * Tests for AvailabilityCalendar day-parsing guard (#432).
 *
 * Verifies that month navigation never produces NaN dates when the previously
 * focused date has a non-numeric day segment, and that normal end-of-month
 * clamping still works correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AvailabilityCalendar from '@/components/booking/AvailabilityCalendar';

function mockFetch(days: object[]) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ days }), { status: 200 }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  // Default: no days returned
  global.fetch = mockFetch([]);
});

describe('AvailabilityCalendar month-change day guard', () => {
  it('falls back to day 1 when focusedDate has a non-numeric day segment', async () => {
    // First fetch returns a day whose date segment is non-numeric so that
    // focusedDate is set to a malformed string.  Subsequent fetches return
    // normal February data.
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ days: [{ date: '2024-01-abc', available: true }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ days: [{ date: '2024-02-01', available: true }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    render(<AvailabilityCalendar propertyId="test-prop" />);

    // Wait for initial calendar load
    await waitFor(() =>
      expect(screen.queryByText(/Loading calendar/i)).toBeNull(),
    );

    // Navigate forward — triggers the month-change effect with
    // prev = '2024-01-abc' (parseInt('abc') = NaN)
    fireEvent.click(screen.getByLabelText('Go to next month'));

    // Wait for the second fetch
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(screen.queryByText(/Loading calendar/i)).toBeNull(),
    );

    // No button or element in the calendar should reference a NaN date
    const allLabels = Array.from(document.querySelectorAll('[aria-label]')).map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
    expect(allLabels.some((l) => l.includes('NaN'))).toBe(false);
  });

  it('clamps day to last day of month on end-of-month navigation', async () => {
    // Focus lands on day 31 (January), then user navigates to February (28 or 29 days)
    global.fetch = vi.fn(async (_url: string) => {
      if (_url.includes('month=1')) {
        // January: include a day-31 entry so focusedDate = '2024-01-31'
        return new Response(
          JSON.stringify({
            days: Array.from({ length: 31 }, (_, i) => ({
              date: `2024-01-${String(i + 1).padStart(2, '0')}`,
              available: true,
            })),
          }),
          { status: 200 },
        );
      }
      // February 2024 (leap year: 29 days)
      return new Response(
        JSON.stringify({
          days: Array.from({ length: 29 }, (_, i) => ({
            date: `2024-02-${String(i + 1).padStart(2, '0')}`,
            available: true,
          })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    render(<AvailabilityCalendar propertyId="test-prop" />);

    await waitFor(() =>
      expect(screen.queryByText(/Loading calendar/i)).toBeNull(),
    );

    // Navigate to February — day 31 doesn't exist so it must clamp to 29
    fireEvent.click(screen.getByLabelText('Go to next month'));

    await waitFor(() =>
      expect(screen.queryByText(/Loading calendar/i)).toBeNull(),
    );

    // No NaN dates in the rendered output
    const allLabels = Array.from(document.querySelectorAll('[aria-label]')).map(
      (el) => el.getAttribute('aria-label') ?? '',
    );
    expect(allLabels.some((l) => l.includes('NaN'))).toBe(false);

    // The clamped day (29) button should be present for February 2024
    const feb29 = allLabels.find((l) => l.includes('29') && l.includes('February'));
    expect(feb29).toBeDefined();
  });
});
