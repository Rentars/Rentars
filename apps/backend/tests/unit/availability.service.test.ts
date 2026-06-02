import { supabase } from '../../src/config/supabase';
import {
  checkDateRangeAvailability,
  isDateRangeAvailable,
} from '../../src/services/availability.service';

jest.mock('../../src/config/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

const PROPERTY_ID = '550e8400-e29b-41d4-a716-446655440000';

/** Helper to build a chainable Supabase mock that returns a given value at .single() */
function mockChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {};
  const terminal = jest.fn().mockResolvedValue(result);
  const addChain = (name: string) => {
    chain[name] = jest.fn().mockReturnValue(chain);
  };
  ['select', 'eq', 'not', 'lt', 'gt', 'order', 'limit', 'insert', 'delete', 'update', 'upsert'].forEach(addChain);
  chain.single = terminal;
  return chain;
}

describe('availability.service — checkDateRangeAvailability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns error for invalid dates', async () => {
    const result = await checkDateRangeAvailability(PROPERTY_ID, 'bad-date', '2026-07-10');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid date/i);
  });

  it('returns error when check_in >= check_out', async () => {
    const result = await checkDateRangeAvailability(PROPERTY_ID, '2026-07-10', '2026-07-05');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/before check_out/i);
  });

  it('returns unavailable when min_stay not met', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'property_settings') {
        return mockChain({ data: { min_stay_nights: 5, max_stay_nights: null }, error: null }) as any;
      }
      // availability_ranges and bookings shouldn't be hit
      return mockChain({ data: [], error: null }) as any;
    });

    const result = await checkDateRangeAvailability(PROPERTY_ID, '2026-07-10', '2026-07-12');
    expect(result.success).toBe(true);
    expect(result.data?.is_available).toBe(false);
    expect(result.data?.unavailable_reason).toMatch(/minimum stay/i);
  });

  it('returns unavailable when blocked range overlaps', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'property_settings') {
        return mockChain({ data: null, error: { code: 'PGRST116' } }) as any;
      }
      if (table === 'availability_ranges') {
        // simulate a blocked range overlapping
        const chain = mockChain({ data: null, error: null });
        chain.limit = jest.fn().mockResolvedValue({ data: [{ id: 'range-1' }], error: null });
        return chain as any;
      }
      return mockChain({ data: [], error: null }) as any;
    });

    const result = await checkDateRangeAvailability(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(true);
    expect(result.data?.is_available).toBe(false);
    expect(result.data?.unavailable_reason).toMatch(/blocked/i);
  });

  it('returns unavailable when booking conflict exists', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'property_settings') {
        return mockChain({ data: null, error: { code: 'PGRST116' } }) as any;
      }
      if (table === 'availability_ranges') {
        const chain = mockChain({ data: null, error: null });
        chain.limit = jest.fn().mockResolvedValue({ data: [], error: null });
        return chain as any;
      }
      if (table === 'bookings') {
        const chain = mockChain({ data: null, error: null });
        chain.limit = jest.fn().mockResolvedValue({ data: [{ id: 'booking-1' }], error: null });
        return chain as any;
      }
      return mockChain({ data: [], error: null }) as any;
    });

    const result = await checkDateRangeAvailability(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(true);
    expect(result.data?.is_available).toBe(false);
    expect(result.data?.unavailable_reason).toMatch(/already booked/i);
  });

  it('returns available when no conflicts', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'property_settings') {
        return mockChain({ data: { min_stay_nights: 1, max_stay_nights: null }, error: null }) as any;
      }
      const chain = mockChain({ data: null, error: null });
      chain.limit = jest.fn().mockResolvedValue({ data: [], error: null });
      return chain as any;
    });

    const result = await checkDateRangeAvailability(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(true);
    expect(result.data?.is_available).toBe(true);
    expect(result.data?.nights).toBe(5);
  });
});

describe('availability.service — isDateRangeAvailable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns true when no blocked ranges overlap', async () => {
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        lt: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      }),
    } as any);

    const result = await isDateRangeAvailable(PROPERTY_ID, '2026-08-01', '2026-08-05');
    expect(result).toBe(true);
  });

  it('returns false when a blocked range overlaps', async () => {
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnThis(),
        lt: jest.fn().mockReturnThis(),
        gt: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [{ id: 'r1' }], error: null }),
      }),
    } as any);

    const result = await isDateRangeAvailable(PROPERTY_ID, '2026-08-01', '2026-08-05');
    expect(result).toBe(false);
  });
});
