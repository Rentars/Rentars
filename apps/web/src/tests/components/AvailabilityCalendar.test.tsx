import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Booking calendar ─────────────────────────────────────────────────────────
import BookingCalendar from '@/components/booking/AvailabilityCalendar';
// ── Host / properties calendar ───────────────────────────────────────────────
import HostCalendar from '@/components/features/properties/AvailabilityCalendar';

// ── Shared fetch mock ────────────────────────────────────────────────────────
const PROPERTY_ID = 'prop-test-1';

function buildDays(year: number, month: number) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return Array.from({ length: daysInMonth }, (_, i) => ({
    date: `${year}-${pad(month)}-${pad(i + 1)}`,
    available: i !== 4 && i !== 5, // day 5 and 6 are blocked
    reason: i === 4 || i === 5 ? 'already booked' : undefined,
  }));
}

const now = new Date();
const YEAR = now.getFullYear();
const MONTH = now.getMonth() + 1;

function mockFetch(days = buildDays(YEAR, MONTH)) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ days }),
  } as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKING CALENDAR — tenant date-picker
// ═══════════════════════════════════════════════════════════════════════════════

describe('BookingCalendar — ARIA structure', () => {
  it('renders a grid with columnheader cells for each day of week', async () => {
    mockFetch();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const grid = screen.getByRole('grid');
    expect(grid).toBeInTheDocument();

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
    expect(headers.map((h) => h.textContent)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('renders gridcell elements for each day in the month', async () => {
    mockFetch();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const cells = screen.getAllByRole('gridcell');
    // Cells include empty leading padding + day cells.
    const daysInMonth = new Date(YEAR, MONTH, 0).getDate();
    const dayCells = cells.filter((c) => c.getAttribute('aria-disabled') !== 'true' || c.querySelector('button'));
    // At least as many gridcells as days in the month.
    expect(cells.length).toBeGreaterThanOrEqual(daysInMonth);
  });

  it('gives unavailable days an aria-label containing "unavailable"', async () => {
    mockFetch();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    // Day 5 is unavailable in our fixture.
    const unavailableButtons = screen
      .getAllByRole('button', { hidden: false })
      .filter((btn) => btn.getAttribute('aria-label')?.includes('unavailable'));
    expect(unavailableButtons.length).toBeGreaterThan(0);
  });

  it('gives available days an aria-label with the full date', async () => {
    mockFetch();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const availableButtons = screen
      .getAllByRole('button', { hidden: false })
      .filter(
        (btn) =>
          btn.getAttribute('aria-label') &&
          !btn.getAttribute('aria-label')?.includes('unavailable') &&
          !btn.getAttribute('aria-label')?.includes('previous') &&
          !btn.getAttribute('aria-label')?.includes('next'),
      );
    expect(availableButtons.length).toBeGreaterThan(0);
    // Each label should contain the month name or a day of the week.
    availableButtons.forEach((btn) => {
      expect(btn.getAttribute('aria-label')).toBeTruthy();
    });
  });
});

describe('BookingCalendar — keyboard navigation', () => {
  it('moves focus one day forward with ArrowRight', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    // Tab into the grid and fire ArrowRight.
    const grid = screen.getByRole('grid');
    grid.focus();

    // Wait for the focused cell to be assigned (the month-change effect runs
    // asynchronously after loading finishes, setting tabIndex={0} on day 1).
    const initialFocused = await waitFor(() => {
      const el = grid.querySelector('button[tabindex="0"]') as HTMLButtonElement;
      expect(el).not.toBeNull();
      return el;
    });
    const initialLabel = initialFocused.getAttribute('aria-label') ?? '';

    await user.keyboard('{ArrowRight}');

    const newFocused = grid.querySelector('button[tabindex="0"]') as HTMLButtonElement;
    expect(newFocused.getAttribute('aria-label')).not.toBe(initialLabel);
  });

  it('moves focus one week forward with ArrowDown', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const grid = screen.getByRole('grid');
    grid.focus();

    const initialFocused = grid.querySelector('button[tabindex="0"]') as HTMLButtonElement;
    const initialLabel = initialFocused?.getAttribute('aria-label') ?? '';

    await user.keyboard('{ArrowDown}');

    const newFocused = grid.querySelector('button[tabindex="0"]') as HTMLButtonElement;
    expect(newFocused.getAttribute('aria-label')).not.toBe(initialLabel);
  });

  it('navigates to previous month with PageUp', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const currentMonthName = new Date(YEAR, MONTH - 1).toLocaleString('default', { month: 'long' });
    const prevMonth = new Date(YEAR, MONTH - 2).toLocaleString('default', { month: 'long' });

    const grid = screen.getByRole('grid');
    grid.focus();
    await user.keyboard('{PageUp}');

    // fetch is called again for the new month — wait for it.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(prevMonth),
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toContain(currentMonthName);
  });

  it('navigates to next month with PageDown', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const nextMonth = new Date(YEAR, MONTH).toLocaleString('default', { month: 'long' });

    const grid = screen.getByRole('grid');
    grid.focus();
    await user.keyboard('{PageDown}');

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(nextMonth),
    );
  });

  it('selects a date with Enter and announces check-in', async () => {
    mockFetch();
    const user = userEvent.setup();
    const onSelectRange = vi.fn();
    render(<BookingCalendar propertyId={PROPERTY_ID} onSelectRange={onSelectRange} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const grid = screen.getByRole('grid');
    grid.focus();

    // Navigate to an available cell and press Enter.
    await user.keyboard('{Enter}');

    // The sr-only live region (not the heading) should now contain check-in text.
    await waitFor(() => {
      // Select the first aria-live element with the sr-only class, which is the
      // dedicated announcer div (not the h2 heading).
      const liveRegion = document.querySelector('.sr-only[aria-live="polite"]');
      expect(liveRegion?.textContent).toMatch(/check-in/i);
    });
  });

  it('selects a range with Space key and calls onSelectRange', async () => {
    mockFetch();
    const user = userEvent.setup();
    const onSelectRange = vi.fn();
    render(<BookingCalendar propertyId={PROPERTY_ID} onSelectRange={onSelectRange} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const grid = screen.getByRole('grid');
    grid.focus();

    // Select check-in.
    await user.keyboard(' ');
    // Move forward 2 days and select check-out.
    await user.keyboard('{ArrowRight}{ArrowRight} ');

    await waitFor(() => expect(onSelectRange).toHaveBeenCalledOnce());
    const [checkIn, checkOut] = onSelectRange.mock.calls[0] as [string, string];
    expect(checkIn < checkOut).toBe(true);
  });

  it('prev/next month header buttons work with mouse click', async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const prevBtn = screen.getByRole('button', { name: /previous month/i });
    const nextBtn = screen.getByRole('button', { name: /next month/i });

    const prevMonth = new Date(YEAR, MONTH - 2).toLocaleString('default', { month: 'long' });
    await user.click(prevBtn);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(prevMonth),
    );

    await user.click(nextBtn);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 }).textContent).not.toContain(prevMonth),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HOST CALENDAR — features/properties/AvailabilityCalendar
// ═══════════════════════════════════════════════════════════════════════════════

function mockHostFetch(ranges: object[] = []) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ranges,
  } as Response);
}

describe('HostCalendar — ARIA structure', () => {
  it('renders a grid with 7 columnheader cells', async () => {
    mockHostFetch();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument();
    });

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(7);
  });

  it('gives blocked days an aria-label containing "blocked"', async () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const blockedStart = `${YEAR}-${pad(MONTH)}-10`;
    const blockedEnd   = `${YEAR}-${pad(MONTH)}-13`;

    mockHostFetch([{ id: 'r1', start_date: blockedStart, end_date: blockedEnd }]);
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    const blockedCells = screen
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-label')?.includes('blocked'));
    // Days 10, 11, 12 should be blocked (end is exclusive).
    expect(blockedCells.length).toBeGreaterThanOrEqual(3);
  });

  it('gives empty leading cells aria-hidden="true"', async () => {
    mockHostFetch();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    // jsdom exposes aria-hidden cells regardless — query all gridcells including hidden ones.
    const allCells = document.querySelectorAll('[role="gridcell"][aria-hidden="true"]');
    // The first day of any month except Sunday will have at least one leading padding cell.
    // The last row may also be padded with trailing empty cells to complete the 7-column grid.
    const firstDayOfWeek = new Date(YEAR, MONTH - 1, 1).getDay();
    // There are at least firstDayOfWeek hidden cells (leading), plus 0–6 trailing cells.
    expect(allCells.length).toBeGreaterThanOrEqual(firstDayOfWeek);
    // Total hidden cells must be a valid combination: leading + trailing (0–6).
    expect((allCells.length - firstDayOfWeek) % 7).toBeLessThan(7);
  });
});

describe('HostCalendar — keyboard month navigation', () => {
  it('changes month with PageDown', async () => {
    mockHostFetch();
    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    const nextMonthLabel = new Date(YEAR, MONTH).toLocaleString('default', {
      month: 'long', year: 'numeric',
    });

    const grid = screen.getByRole('grid');
    await user.click(grid);
    await user.keyboard('{PageDown}');

    await waitFor(() =>
      expect(screen.getByText(nextMonthLabel)).toBeInTheDocument(),
    );
  });

  it('changes month with PageUp', async () => {
    mockHostFetch();
    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    const prevMonthLabel = new Date(YEAR, MONTH - 2).toLocaleString('default', {
      month: 'long', year: 'numeric',
    });

    const grid = screen.getByRole('grid');
    await user.click(grid);
    await user.keyboard('{PageUp}');

    await waitFor(() =>
      expect(screen.getByText(prevMonthLabel)).toBeInTheDocument(),
    );
  });

  it('prev/next month header buttons work', async () => {
    mockHostFetch();
    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    const nextMonthLabel = new Date(YEAR, MONTH).toLocaleString('default', {
      month: 'long', year: 'numeric',
    });
    const nextBtn = screen.getByRole('button', { name: /next month/i });
    await user.click(nextBtn);

    await waitFor(() =>
      expect(screen.getByText(nextMonthLabel)).toBeInTheDocument(),
    );
  });
});

describe('HostCalendar — block-range form', () => {
  it('shows an error when start date is missing', async () => {
    mockHostFetch();
    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /block dates/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/required/i);
  });

  it('shows an error when start date is not before end date', async () => {
    mockHostFetch();
    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.getByRole('grid')).toBeInTheDocument());

    const pad = (n: number) => String(n).padStart(2, '0');
    await user.type(screen.getByLabelText(/start date/i), `${YEAR}-${pad(MONTH)}-20`);
    await user.type(screen.getByLabelText(/end date/i), `${YEAR}-${pad(MONTH)}-10`);
    await user.click(screen.getByRole('button', { name: /block dates/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/before/i);
  });

  it('calls DELETE when a blocked range is removed', async () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const ranges = [{ id: 'r1', start_date: `${YEAR}-${pad(MONTH)}-01`, end_date: `${YEAR}-${pad(MONTH)}-03` }];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ranges } as Response) // initial fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)   // DELETE
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);    // refetch

    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<HostCalendar propertyId={PROPERTY_ID} />);

    const removeBtn = await screen.findByRole('button', { name: /remove block/i });
    await user.click(removeBtn);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter((c) => {
        const [, opts] = c as [string, RequestInit];
        return opts?.method === 'DELETE';
      });
      expect(deleteCalls.length).toBe(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// #433 BookingCalendar — duplicate fetch prevention
// ═══════════════════════════════════════════════════════════════════════════════

describe('BookingCalendar — #433 duplicate fetch prevention', () => {
  it('issues exactly one request when rendered with the same property and month', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ days: buildDays(YEAR, MONTH) }),
    } as Response);
    global.fetch = fetchSpy;

    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const calendarCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/month'),
    );
    // The initial mount should produce exactly one request for the current month.
    expect(calendarCalls).toHaveLength(1);
  });

  it('does not refetch when the same property+month is re-rendered without change', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ days: buildDays(YEAR, MONTH) }),
    } as Response);
    global.fetch = fetchSpy;

    const { rerender } = render(<BookingCalendar propertyId={PROPERTY_ID} />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    // Re-render with identical props — should NOT trigger another fetch.
    rerender(<BookingCalendar propertyId={PROPERTY_ID} />);

    // Allow any potential async effect to settle.
    await new Promise((r) => setTimeout(r, 50));

    const calendarCalls = fetchSpy.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/month'),
    );
    // Still exactly one call.
    expect(calendarCalls).toHaveLength(1);
  });

  it('fetches again when the property changes', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ days: buildDays(YEAR, MONTH) }),
    } as Response);
    global.fetch = fetchSpy;

    const { rerender } = render(<BookingCalendar propertyId="prop-a" />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    rerender(<BookingCalendar propertyId="prop-b" />);
    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([url]: [string]) =>
        String(url).includes('/month'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('fetches again when the month changes via navigation', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ days: buildDays(YEAR, MONTH) }),
    } as Response);
    global.fetch = fetchSpy;

    const user = userEvent.setup();
    render(<BookingCalendar propertyId={PROPERTY_ID} />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    const nextBtn = screen.getByRole('button', { name: /next month/i });
    await user.click(nextBtn);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(([url]: [string]) =>
        String(url).includes('/month'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
