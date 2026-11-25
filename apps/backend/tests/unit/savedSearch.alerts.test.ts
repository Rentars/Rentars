/**
 * End-to-end alert delivery rules for saved searches (issue #933).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const createNotification = mock(async () => ({ success: true }));

let deliveryStatus = 'pending';
const savedSearches = [
  {
    id: 's1',
    user_id: 'u1',
    name: 'Lagos flats',
    filters: { city: 'lagos' },
    is_paused: false,
    digest_frequency: 'immediate',
  },
];

const query = () => ({
  eq: (_column: string, _value: unknown) => ({
    eq: () => ({
      maybeSingle: async () => ({ data: { status: deliveryStatus } }),
      order: () => ({ limit: async () => ({ data: [] }) }),
    }),
    maybeSingle: async () => ({ data: null }),
    limit: async () => ({ data: [] }),
  }),
  maybeSingle: async () => ({ data: null }),
});

const mockSupabase = {
  from: mock((table: string) => {
    if (table === 'saved_searches') {
      return {
        select: () => ({
          eq: async () => ({ data: savedSearches, error: null }),
        }),
      };
    }
    if (table === 'notification_preferences') {
      return { select: query };
    }
    return {
      upsert: async () => ({ error: null }),
      select: query,
      update: () => ({ in: () => ({ eq: async () => ({ error: null }) }) }),
    };
  }),
};

mock.module('../../src/config/supabase.js', () => ({ supabase: mockSupabase }));
mock.module('../../src/services/notification.service.js', () => ({ createNotification }));

import { notifyMatchingSavedSearches } from '../../src/services/savedSearch.service.js';

const property = {
  id: 'p1',
  title: 'Flat in Lagos',
  city: 'Lagos',
  country: 'Nigeria',
  price_per_night: 100,
  bedrooms: 2,
  bathrooms: 1,
  max_guests: 4,
  amenities: ['wifi'],
  property_type: 'apartment',
};

describe('saved-search alert fan-out', () => {
  beforeEach(() => {
    deliveryStatus = 'pending';
    createNotification.mockClear();
  });

  it('notifies once for a new match and suppresses duplicates', async () => {
    const first = await notifyMatchingSavedSearches(property);
    expect(first.success).toBe(true);
    expect(first.data).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);

    deliveryStatus = 'sent';
    const second = await notifyMatchingSavedSearches(property);
    expect(second.data).toBe(0);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does not alert for paused searches', async () => {
    savedSearches[0].is_paused = true;
    // The service queries only non-paused rows; mimic that filter in the mock.
    const originalImpl = mockSupabase.from.getMockImplementation()!;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'saved_searches') {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      return originalImpl(table);
    });
    const result = await notifyMatchingSavedSearches(property);
    expect(result.data).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
    savedSearches[0].is_paused = false;
    mockSupabase.from.mockImplementation(originalImpl);
  });
});
