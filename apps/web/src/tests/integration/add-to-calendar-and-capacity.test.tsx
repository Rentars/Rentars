/**
 * Integration tests for:
 *  1. AddToCalendar component (ICS download + provider links)
 *  2. BookingForm guest-capacity enforcement (maxGuests prop)
 *  3. BookingConfirmationPage rendering the AddToCalendar section
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@/tests/utils/test-utils';
import userEvent from '@testing-library/user-event';
import AddToCalendar from '@/components/booking/confirmation/AddToCalendar';
import BookingForm from '@/components/booking/BookingForm';
import BookingConfirmationPage from '@/components/booking/confirmation/BookingConfirmationPage';

// ─── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const BOOKING_ID = 'booking-cal-test';

const mockBooking = {
  id: BOOKING_ID,
  property_id: 'prop-99',
  tenant_id: 'tenant-1',
  check_in: '2027-09-10',
  check_out: '2027-09-15',
  guest_count: 2,
  total_price: 750,
  status: 'confirmed' as const,
  escrow_status: 'locked' as const,
  created_at: '2027-07-01T00:00:00Z',
  updated_at: '2027-07-01T00:00:00Z',
};

const mockProperty = {
  id: 'prop-99',
  title: 'Seaview Cottage',
  description: 'A lovely cottage',
  price_per_night: 150,
  location: 'Cornwall, UK',
  images: [],
  owner_id: 'owner-1',
  available: true,
  created_at: '2027-01-01T00:00:00Z',
  max_guests: 4,
};

// ─── AddToCalendar tests ──────────────────────────────────────────────────────

describe('AddToCalendar', () => {
  const user = userEvent.setup();
  const defaultProps = {
    bookingId: BOOKING_ID,
    propertyTitle: 'Seaview Cottage',
    propertyLocation: 'Cornwall, UK',
    checkIn: '2027-09-10',
    checkOut: '2027-09-15',
  };

  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the "Add to Calendar" toggle button', () => {
    render(<AddToCalendar {...defaultProps} />);
    expect(screen.getByRole('button', { name: /add to calendar/i })).toBeInTheDocument();
  });

  it('opens the dropdown when the button is clicked', async () => {
    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));

    expect(screen.getByRole('menu', { name: /calendar options/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /download \.ics file/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /google calendar/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /outlook calendar/i })).toBeInTheDocument();
  });

  it('closes the dropdown when clicked again', async () => {
    render(<AddToCalendar {...defaultProps} />);
    const toggle = screen.getByRole('button', { name: /add to calendar/i });
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('preserves the exact end time for datetime Google Calendar values', async () => {
    render(
      <AddToCalendar
        {...defaultProps}
        checkIn="2027-09-10T15:30:00Z"
        checkOut="2027-09-15T11:45:00Z"
      />,
    );
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));
    const gcalLink = screen.getByRole('menuitem', { name: /google calendar/i }) as HTMLAnchorElement;
    expect(gcalLink.href).toContain('20270910T153000Z');
    expect(gcalLink.href).toContain('20270915T114500Z');
  });

  it('Google Calendar link has correct prefilled parameters', async () => {
    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));

    const gcalLink = screen.getByRole('menuitem', { name: /google calendar/i }) as HTMLAnchorElement;
    expect(gcalLink.href).toContain('calendar.google.com');
    expect(gcalLink.href).toContain('Seaview+Cottage');
    expect(gcalLink.href).toContain('Cornwall');
    // Date range: check-in 20270910, check-out +1 day = 20270916
    expect(gcalLink.href).toContain('20270910');
    expect(gcalLink.href).toContain('20270916');
  });

  it('Outlook Calendar link has correct prefilled parameters', async () => {
    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));

    const outlookLink = screen.getByRole('menuitem', { name: /outlook calendar/i }) as HTMLAnchorElement;
    expect(outlookLink.href).toContain('outlook.live.com');
    expect(outlookLink.href).toContain('Seaview+Cottage');
    expect(outlookLink.href).toContain('2027-09-10');
    expect(outlookLink.href).toContain('2027-09-15');
  });

  it('provider links open in a new tab', async () => {
    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));

    const gcalLink = screen.getByRole('menuitem', { name: /google calendar/i }) as HTMLAnchorElement;
    const outlookLink = screen.getByRole('menuitem', { name: /outlook calendar/i }) as HTMLAnchorElement;
    expect(gcalLink.target).toBe('_blank');
    expect(gcalLink.rel).toContain('noopener');
    expect(outlookLink.target).toBe('_blank');
    expect(outlookLink.rel).toContain('noopener');
  });

  it('triggers ICS download from the API on download click', async () => {
    const icsContent = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    const mockBlob = new Blob([icsContent], { type: 'text/calendar' });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Stub URL.createObjectURL & revokeObjectURL
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    // Stub DOM anchor click
    const clickSpy = vi.fn();
    const mockAnchor = { href: '', download: '', click: clickSpy, remove: vi.fn() };
    vi.spyOn(document, 'createElement').mockImplementationOnce(
      () => mockAnchor as unknown as HTMLElement,
    );
    vi.spyOn(document.body, 'appendChild').mockImplementationOnce(() => mockAnchor as unknown as Node);

    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));
    await user.click(screen.getByRole('menuitem', { name: /download \.ics file/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/bookings/${BOOKING_ID}/calendar.ics`),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
      );
    });

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  });

  it('shows an error message when the ICS download fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    render(<AddToCalendar {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /add to calendar/i }));
    await user.click(screen.getByRole('menuitem', { name: /download \.ics file/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/could not generate/i);
    });
  });
});

// ─── BookingForm guest-capacity tests ─────────────────────────────────────────

describe('BookingForm — guest capacity enforcement', () => {
  const user = userEvent.setup();
  const mockOnSubmit = vi.fn();

  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/price')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            total: 750,
            breakdown: [
              { date: '2027-09-10', price: 150, is_available: true },
              { date: '2027-09-11', price: 150, is_available: true },
              { date: '2027-09-12', price: 150, is_available: true },
              { date: '2027-09-13', price: 150, is_available: true },
              { date: '2027-09-14', price: 150, is_available: true },
            ],
          }),
      });
    }
    if (url.includes('/check')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ available: true }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    mockOnSubmit.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('displays the max guests hint when maxGuests is provided', () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        maxGuests={4}
        onSubmit={mockOnSubmit}
      />,
    );
    expect(screen.getByText(/max 4/i)).toBeInTheDocument();
  });

  it('does not display a max guests hint when maxGuests is not provided', () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        onSubmit={mockOnSubmit}
      />,
    );
    expect(screen.queryByText(/max \d/i)).not.toBeInTheDocument();
  });

  it('shows an inline error when guest count exceeds maxGuests', async () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        maxGuests={2}
        onSubmit={mockOnSubmit}
      />,
    );

    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '5');

    expect(await screen.findByText(/maximum 2 guests? allowed/i)).toBeInTheDocument();
  });

  it('clears the error when guest count is corrected', async () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        maxGuests={2}
        onSubmit={mockOnSubmit}
      />,
    );

    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '5');
    expect(await screen.findByText(/maximum 2 guests? allowed/i)).toBeInTheDocument();

    await user.clear(guestInput);
    await user.type(guestInput, '2');
    await waitFor(() => {
      expect(screen.queryByText(/maximum 2 guests? allowed/i)).not.toBeInTheDocument();
    });
  });

  it('disables the submit button when guest count is over capacity', async () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        maxGuests={2}
        onSubmit={mockOnSubmit}
      />,
    );

    const guestInput = screen.getByLabelText(/guests/i);
    await user.clear(guestInput);
    await user.type(guestInput, '10');

    const submitBtn = screen.getByRole('button', { name: /book now/i });
    expect(submitBtn).toBeDisabled();
  });

  it('sets the HTML max attribute on the guest input to maxGuests', () => {
    render(
      <BookingForm
        propertyId="prop-99"
        pricePerNight={150}
        maxGuests={3}
        onSubmit={mockOnSubmit}
      />,
    );

    const guestInput = screen.getByLabelText(/guests/i) as HTMLInputElement;
    expect(guestInput.min).toBe('1');
    expect(guestInput.step).toBe('1');
    expect(guestInput.max).toBe('3');
  });
});

// ─── BookingConfirmationPage — AddToCalendar section ─────────────────────────

describe('BookingConfirmationPage — Add to Calendar section', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders the "Save your stay" section with the calendar button', async () => {
    localStorage.setItem('token', 'test-token');

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/bookings/') || url.includes('/api/v1/bookings/')) {
        // Avoid the escrow polling endpoint
        if (url.includes('/escrow')) {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockBooking),
        });
      }
      if (url.includes('/api/v1/properties/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockProperty),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<BookingConfirmationPage bookingId={BOOKING_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Booking Details')).toBeInTheDocument();
    });

    expect(screen.getByText(/save your stay/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to calendar/i })).toBeInTheDocument();
  });
});
