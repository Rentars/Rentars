import { describe, expect, it } from 'vitest';
import {
  buildGoogleCalendarUrl,
  buildOutlookUrl,
} from '@/components/booking/confirmation/AddToCalendar';

const booking = {
  bookingId: 'booking&42#1',
  propertyTitle: 'A&B #1',
  propertyLocation: '12 Main St, City #2 & West',
  checkIn: '2027-06-10',
  checkOut: '2027-06-15',
};

describe('calendar URL builders', () => {
  it('encodes every dynamic Google Calendar field as a query parameter', () => {
    const url = buildGoogleCalendarUrl(booking);
    expect(url).not.toBeNull();

    const params = new URL(url!).searchParams;
    expect(params.get('text')).toBe('Stay at A&B #1');
    expect(params.get('details')).toBe('Booking ID: booking&42#1');
    expect(params.get('location')).toBe('12 Main St, City #2 & West');
    expect(params.get('dates')).toBe('20270610/20270616');
  });

  it('encodes every dynamic Outlook Calendar field as a query parameter', () => {
    const url = buildOutlookUrl(booking);
    expect(url).not.toBeNull();

    const params = new URL(url!).searchParams;
    expect(params.get('subject')).toBe('Stay at A&B #1');
    expect(params.get('body')).toBe('Booking ID: booking&42#1');
    expect(params.get('location')).toBe('12 Main St, City #2 & West');
  });

  it('returns no provider URL for malformed dates', () => {
    const invalid = { ...booking, checkIn: 'not-a-date' };
    expect(buildGoogleCalendarUrl(invalid)).toBeNull();
    expect(buildOutlookUrl(invalid)).toBeNull();
  });

  it('rejects calendar dates that the Date parser normalises', () => {
    const invalid = { ...booking, checkOut: '2027-02-30' };
    expect(buildGoogleCalendarUrl(invalid)).toBeNull();
    expect(buildOutlookUrl(invalid)).toBeNull();
  });
});

