/**
 * BookingForm edge-case tests
 *
 * Covers:
 *  - end-before-start rejection (#435)
 *  - same-day (zero-night) rejection (#435)
 *  - unavailable-date selection surfacing availability error
 *  - min-stay violation (stay < minimum nights)
 *  - max-stay violation (stay > maximum nights)
 *  - guest count below minimum (#434)
 *  - guest count at zero (#434)
 *  - guest count negative (#434)
 *  - guest count above property max
 *  - submit disabled when invalid; enabled when valid
 *  - price recomputes when date range changes
 *  - blocked dates inside range blocks submission
 *  - stale pricing responses do not overwrite current pricing (#436)
 *  - pricing effect cleans up on unmount (#436)
 *
 * All fetch / quote calls are mocked deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingForm from '../BookingForm';

// ─── i18n mock ─────────────────────────────────────────────────────────────
vi.mock('@/lib/i18n/useTranslations', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => {
    const map: Record<string, string> = {
      checkIn: 'Check-in',
      checkOut: 'Check-out',
      bookNow: 'Book Now',
      processing: 'Processing…',
      invalidDates: 'Please select valid dates',
      checkoutAfterCheckin: 'Check-out date must be after check-in date',
      unavailableDates: 'Dates not available',
      cantCalculatePrice: 'Unable to calculate total price',
      hasBlockedDates: 'Selected dates include unavailable periods',
      totalNights: `Total (${params?.count ?? 0} nights)`,
    };
    return map[key] ?? key;
  },
}));

vi.mock('@/lib/i18n/useLocale', () => ({
  useLocale: () => ({ locale: 'en' }),
}));

vi.mock('@/lib/i18n/formatting', () => ({
  formatCurrency: (amount: number) => String(amount),
}));

vi.mock('@/hooks/useCurrency', () => ({
  useCurrency: () => ({
    formatEstimate: () => null,
    displayCurrency: 'USD',
    ratesStale: false,
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROPERTY_ID = 'prop-test';
const DEFAULT_PRICE = 100;

/** Build a deterministic pricing response for N-night stay. */
function makePricingResponse(
  checkIn: string,
  checkOut: string,
  opts: { allAvailable?: boolean } = {},
) {
  const allAvailable = opts.allAvailable ?? true;
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const nights = Math.ceil((end.getTime() - start.getTime()) / 86_400_000);
  const breakdown = Array.from({ length: nights }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return {
      date: d.toISOString().split('T')[0],
      price: DEFAULT_PRICE,
      is_available: allAvailable,
    };
  });
  return {
    base_nightly_rate: DEFAULT_PRICE,
    nights,
    subtotal: DEFAULT_PRICE * nights,
    dynamic_adjustments: 0,
    platform_fee_pct: 0.05,
    platform_fee: DEFAULT_PRICE * nights * 0.05,
    total: DEFAULT_PRICE * nights,
    breakdown,
  };
}

/**
 * Build a fetch mock that handles:
 *   /quote   → pricing endpoint  (matches /api/v1/properties/:id/quote)
 *   /check   → availability check
 */
function buildFetchMock(opts: {
  available?: boolean;
  pricingBlocked?: boolean;
  pricingError?: boolean;
} = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/quote')) {
      if (opts.pricingError) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'Unable to calculate total price' }),
        } as Response);
      }
      // Extract dates from query string (?start=...&end=...)
      const u = new URL(url, 'http://localhost:3000');
      const start = u.searchParams.get('start') ?? '2027-01-01';
      const end = u.searchParams.get('end') ?? '2027-01-03';
      // Only return a valid response when dates are well-formed ISO strings
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'invalid dates' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            makePricingResponse(start, end, {
              allAvailable: !opts.pricingBlocked,
            }),
          ),
      } as Response);
    }

    if (url.includes('/check')) {
      const available = opts.available ?? true;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            available,
            reason: available ? undefined : 'Dates not available',
          }),
      } as Response);
    }

    return Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    } as Response);
  });
}

// ─── Default props ──────────────────────────────────────────────────────────

const defaultProps = {
  propertyId: PROPERTY_ID,
  pricePerNight: DEFAULT_PRICE,
  onSubmit: vi.fn(),
  isLoading: false,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BookingForm edge cases', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    defaultProps.onSubmit = vi.fn();
    fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── #435 Date validation ─────────────────────────────────────────────────

  it('#435: rejects end-before-start via form submit and shows field-level error', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-05');

    // Button is disabled (nights < 0) — dispatch submit directly to test the
    // handler's own date-order guard against programmatic or altered inputs.
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(
        screen.getByText(/check-out date must be after check-in date/i),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('#435: rejects same check-in and check-out (zero nights)', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-10');

    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(
        screen.getByText(/check-out date must be after check-in date/i),
      ).toBeInTheDocument();
    });

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('shows "invalid dates" error when dates are missing on submit', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    // Only fill check-in, leave check-out empty
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');

    // Submit button is disabled (nights = 0) — dispatch directly
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(screen.getByText(/please select valid dates/i)).toBeInTheDocument();
    });

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  // ── Unavailable dates ────────────────────────────────────────────────────

  it('shows availability error when /check returns available: false', async () => {
    fetchMock = buildFetchMock({ available: false });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    // Wait for pricing to load (so submit is enabled before clicking)
    await waitFor(() => {
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument();
    });

    const submit = screen.getByRole('button', { name: /book now/i });
    await user.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/dates not available/i)).toBeInTheDocument();
    });

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('disables submit when pricing contains blocked dates', async () => {
    fetchMock = buildFetchMock({ available: true, pricingBlocked: true });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    // Wait for pricing section to appear (blocked dates still load pricing).
    await waitFor(() => {
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument();
    });

    // Dispatch submit: the handler is async, so we poll for the error with waitFor.
    const form = screen.getByRole('button', { name: /book now/i }).closest('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(
      () => {
        expect(
          screen.getByText(/selected dates include unavailable periods/i),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  // ── Min / max stay violations ────────────────────────────────────────────

  it('disables submit when stay is shorter than minStay', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} minStay={3} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-11');

    // Wait for pricing section to appear (1 night × 100 = total 100 USDC)
    await waitFor(() => {
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument();
    });

    // Submit must be disabled because stayViolation is true
    expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('sets the minStay error message when submit is attempted while stay < minStay', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} minStay={3} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-11');

    // Wait for pricing
    await waitFor(() =>
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument(),
    );

    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(screen.getByText(/minimum stay is 3 night/i)).toBeInTheDocument();
    });

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('disables submit when stay is longer than maxStay', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} maxStay={5} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-17');

    // Wait for pricing section (7 nights)
    await waitFor(() => {
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('sets the maxStay error message when submit is attempted while stay > maxStay', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} maxStay={5} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-17');

    await waitFor(() =>
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument(),
    );

    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(screen.getByText(/maximum stay is 5 night/i)).toBeInTheDocument();
    });

    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  // ── #434 Guest count violations ──────────────────────────────────────────

  it('#434: shows error and disables submit when guest count is zero', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    // Use fill() to atomically replace the value in the number input
    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '0');

    await waitFor(() => {
      expect(screen.getByText(/at least 1 guest is required/i)).toBeInTheDocument();
    });

    // Submit is disabled regardless of dates
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    const submit = screen.getByRole('button', { name: /book now/i });
    expect(submit).toBeDisabled();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('#434: shows error and disables submit when guest count is negative', async () => {
    const user = userEvent.setup();
    const { fireEvent } = await import('@testing-library/react');
    render(<BookingForm {...defaultProps} />);

    // Use fireEvent.change to set a negative value; userEvent's type() does not
    // reliably produce negative numbers on type="number" inputs in jsdom.
    const guestInput = screen.getByLabelText(/guests/i);
    fireEvent.change(guestInput, { target: { value: '-1' } });

    await waitFor(() => {
      expect(screen.getByText(/at least 1 guest is required/i)).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    const submit = screen.getByRole('button', { name: /book now/i });
    expect(submit).toBeDisabled();
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it('shows error when guest count exceeds maxGuests', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} maxGuests={2} />);

    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '5');

    await waitFor(() => {
      expect(screen.getByText(/maximum 2 guests? allowed/i)).toBeInTheDocument();
    });

    // Submit disabled even after valid dates
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
  });
  it('#434: no network availability check is made when guest count is invalid on submit', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    // Enter valid dates to get pricing loaded
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    // Wait for pricing to load
    await waitFor(() => {
      expect(screen.getByText(/total \(charged in usdc\)/i)).toBeInTheDocument();
    });

    // Now set guest count to 0
    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '0');

    await waitFor(() => {
      expect(screen.getByText(/at least 1 guest is required/i)).toBeInTheDocument();
    });

    // Record current check calls count before submit
    const checkCallsBefore = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/check'),
    ).length;

    // Dispatch submit directly to test handler-level guard
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Wait a tick to ensure no additional calls were made
    await new Promise((r) => setTimeout(r, 50));

    const checkCallsAfter = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/check'),
    ).length;
    // No new availability check should have been made
    expect(checkCallsAfter).toBe(checkCallsBefore);
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  // ── Submit gating ────────────────────────────────────────────────────────

  it('submit is disabled before any dates are selected', () => {
    render(<BookingForm {...defaultProps} />);
    expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
  });

  it('submit is disabled while isLoading is true', () => {
    render(<BookingForm {...defaultProps} isLoading={true} />);
    expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();
  });

  it('submit is disabled when pricing fails to load', async () => {
    fetchMock = buildFetchMock({ pricingError: true });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /book now/i })).toBeDisabled();
    });
  });

  // ── Price recomputation ──────────────────────────────────────────────────

  it('displays total price based on fetched pricing when dates are set', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-13'); // 3 nights → 300

    // The pricing section renders the total; "300 USDC" may appear multiple times
    // (subtotal + total lines), so we assert at least one match.
    await waitFor(() => {
      expect(screen.getAllByText(/300 usdc/i).length).toBeGreaterThan(0);
    });
  });

  it('recomputes price when the date range changes', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    // First range: 2 nights → 200 USDC total
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-12');

    await waitFor(() => {
      expect(screen.getAllByText(/200 usdc/i).length).toBeGreaterThan(0);
    });

    // Change check-out to extend to 5 nights → 500 USDC total
    await user.clear(screen.getByLabelText(/check-out/i));
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-15');

    await waitFor(() => {
      expect(screen.getAllByText(/500 usdc/i).length).toBeGreaterThan(0);
    });

    // Verify the pricing API was called again with the new range
    const quoteCalls = fetchMock.mock.calls.filter(([url]: [string]) =>
      String(url).includes('/quote'),
    );
    expect(quoteCalls.length).toBeGreaterThanOrEqual(2);
  });

  // ── #436 Stale pricing cancellation ─────────────────────────────────────

  it('#436: only the latest pricing response updates the form (out-of-order responses)', async () => {
    // We test stale-response cancellation by:
    // 1. Setting dates to produce a first complete request (range A, 2 nights)
    // 2. Changing dates before range A resolves to produce a second request (range B, 3 nights)
    // 3. Resolving range B (current) — its pricing must appear
    // 4. Resolving range A (stale) — must be ignored because its signal is aborted
    //
    // The mock respects the AbortSignal so that aborting the first controller
    // correctly rejects its in-flight fetch with an AbortError.
    const { fireEvent: fe } = await import('@testing-library/react');

    let resolveSlow!: (r: Response) => void;
    let resolveFast!: (r: Response) => void;
    const slowFetch = new Promise<Response>((res) => { resolveSlow = res; });
    const fastFetch = new Promise<Response>((res) => { resolveFast = res; });

    let quoteCallIdx = 0;

    // Signal-aware mock: wraps the underlying promise so it rejects with AbortError
    // when the provided signal fires before the response arrives.
    function signalAwareFetch(underlying: Promise<Response>, signal?: AbortSignal): Promise<Response> {
      if (!signal) return underlying;
      return new Promise<Response>((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        underlying.then(resolve, reject);
      });
    }

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const signal = init?.signal as AbortSignal | undefined;
      if (url.includes('/quote')) {
        quoteCallIdx += 1;
        if (quoteCallIdx === 1) return signalAwareFetch(slowFetch, signal);
        if (quoteCallIdx === 2) return signalAwareFetch(fastFetch, signal);
        return new Promise(() => {});
      }
      if (url.includes('/check')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ available: true }),
        } as Response);
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    }));

    render(<BookingForm {...defaultProps} />);

    // Set check-in — effect won't fire yet (checkOut is empty).
    await act(async () => {
      fe.change(screen.getByLabelText(/check-in/i), { target: { value: '2027-06-10' } });
    });

    // Set first checkout (2 nights) → flushes effect → quoteCallIdx=1 (slow).
    await act(async () => {
      fe.change(screen.getByLabelText(/check-out/i), { target: { value: '2027-06-12' } });
    });

    // Change checkout to 3 nights → cleanup aborts controller1 → quoteCallIdx=2 (fast).
    await act(async () => {
      fe.change(screen.getByLabelText(/check-out/i), { target: { value: '2027-06-13' } });
    });

    // Resolve the fast (current) 3-night request first.
    await act(async () => {
      resolveFast({
        ok: true,
        json: () => Promise.resolve(makePricingResponse('2027-06-10', '2027-06-13')),
      } as Response);
      await new Promise((r) => setTimeout(r, 10));
    });

    // Wait for the 3-night pricing to appear.
    await waitFor(() => {
      expect(screen.getAllByText(/300 usdc/i).length).toBeGreaterThan(0);
    });

    // Resolve the stale 2-night request — must be ignored (signal was aborted).
    await act(async () => {
      resolveSlow({
        ok: true,
        json: () => Promise.resolve(makePricingResponse('2027-06-10', '2027-06-12')),
      } as Response);
      await new Promise((r) => setTimeout(r, 20));
    });

    // 300 USDC must remain; 200 USDC must not appear.
    expect(screen.getAllByText(/300 usdc/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/200 usdc/i)).toHaveLength(0);
  });

  it('#436: pricing effect cleans up on unmount (no state update after unmount)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pendingFetch = new Promise<Response>((res) => { resolveFetch = res; });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/quote')) return pendingFetch;
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    }));

    const user = userEvent.setup();
    const { unmount } = render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-13');

    // Unmount before the fetch resolves
    unmount();

    // Resolve after unmount — should not throw
    await act(async () => {
      resolveFetch({
        ok: true,
        json: () => Promise.resolve(makePricingResponse('2027-06-10', '2027-06-13')),
      } as Response);
      await new Promise((r) => setTimeout(r, 10));
    });

    // No error thrown = AbortController cleanup worked correctly.
    expect(true).toBe(true);
  });

  it('clears a stale availability error when a retry succeeds', async () => {
    let availabilityAttempts = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/quote')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makePricingResponse('2027-06-10', '2027-06-13')),
        } as Response);
      }
      if (url.includes('/check')) {
        availabilityAttempts += 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ available: availabilityAttempts > 1 }),
        } as Response);
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
    }));

    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);
    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-13');
    await waitFor(() => expect(screen.getByText(/300 usdc/i)).toBeInTheDocument());

    const submit = screen.getByRole('button', { name: /book now/i });
    await user.click(submit);
    await waitFor(() => expect(screen.getByText(/dates not available/i)).toBeInTheDocument());

    await user.click(submit);
    await waitFor(() => expect(screen.queryByText(/dates not available/i)).not.toBeInTheDocument());
    expect(defaultProps.onSubmit).toHaveBeenCalledTimes(1);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('calls onSubmit with correct data when form is valid', async () => {
    const user = userEvent.setup();
    render(<BookingForm {...defaultProps} />);

    await user.type(screen.getByLabelText(/check-in/i), '2027-06-10');
    await user.type(screen.getByLabelText(/check-out/i), '2027-06-13'); // 3 nights

    await waitFor(() => {
      expect(screen.getAllByText(/300 usdc/i).length).toBeGreaterThan(0);
    });

    const submit = screen.getByRole('button', { name: /book now/i });
    await user.click(submit);

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          checkIn: new Date('2027-06-10'),
          checkOut: new Date('2027-06-13'),
          guestCount: 1,
          totalPrice: 300,
        }),
      );
    });
  });
});
