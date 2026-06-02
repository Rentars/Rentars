import { supabase } from '../../src/config/supabase';
import {
  calculatePrice,
  getPricingRules,
  createPricingRule,
  deletePricingRule,
  getPropertySettings,
  upsertPropertySettings,
} from '../../src/services/pricing.service';

jest.mock('../../src/config/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

const PROPERTY_ID = '550e8400-e29b-41d4-a716-446655440000';
const OWNER_ID = 'user-1';

function mockSingle(data: unknown, error: unknown = null) {
  return {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data, error }),
  };
}

describe('pricing.service — calculatePrice', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns error for invalid dates', async () => {
    const result = await calculatePrice(PROPERTY_ID, 'invalid', '2026-07-10');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid date/i);
  });

  it('returns error when check_in >= check_out', async () => {
    const result = await calculatePrice(PROPERTY_ID, '2026-07-10', '2026-07-05');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/before check_out/i);
  });

  it('returns error when property not found', async () => {
    mockSupabase.from.mockReturnValue(mockSingle(null, { message: 'not found' }) as any);
    const result = await calculatePrice(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });

  it('calculates total at base price when no rules', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'properties') {
        return mockSingle({ price_per_night: 100 }) as any;
      }
      // pricing_rules
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({ data: [], error: null }),
      } as any;
    });

    const result = await calculatePrice(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(true);
    expect(result.data?.nights).toBe(5);
    expect(result.data?.total_price).toBe(500);
    expect(result.data?.base_price_per_night).toBe(100);
    expect(result.data?.applied_rules).toHaveLength(0);
  });

  it('applies seasonal rule multiplier for overlapping dates', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'properties') {
        return mockSingle({ price_per_night: 100 }) as any;
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({
          data: [{
            id: 'rule-1',
            property_id: PROPERTY_ID,
            rule_type: 'seasonal',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_override: null,
            multiplier: 1.5,
            priority: 10,
          }],
          error: null,
        }),
      } as any;
    });

    const result = await calculatePrice(PROPERTY_ID, '2026-07-10', '2026-07-15');
    expect(result.success).toBe(true);
    expect(result.data?.total_price).toBe(750); // 5 nights × 150
    expect(result.data?.applied_rules[0].rule_type).toBe('seasonal');
  });

  it('applies price_override over multiplier', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'properties') {
        return mockSingle({ price_per_night: 100 }) as any;
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({
          data: [{
            id: 'rule-2',
            property_id: PROPERTY_ID,
            rule_type: 'demand',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_override: 200,
            multiplier: 2.0,
            priority: 5,
          }],
          error: null,
        }),
      } as any;
    });

    const result = await calculatePrice(PROPERTY_ID, '2026-07-10', '2026-07-12');
    expect(result.success).toBe(true);
    expect(result.data?.total_price).toBe(400); // 2 nights × 200 (price_override wins)
  });
});

describe('pricing.service — getPricingRules', () => {
  it('returns pricing rules for a property', async () => {
    const rules = [{ id: 'r1', property_id: PROPERTY_ID, rule_type: 'seasonal', priority: 0 }];
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: rules, error: null }),
    } as any);

    const result = await getPricingRules(PROPERTY_ID);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(rules);
  });
});

describe('pricing.service — createPricingRule', () => {
  it('returns forbidden when user is not owner', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ owner_id: 'different-user' }) as any);
    const result = await createPricingRule(PROPERTY_ID, OWNER_ID, {
      rule_type: 'seasonal',
      multiplier: 1.2,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/forbidden/i);
  });

  it('returns error when neither price_override nor multiplier is given', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ owner_id: OWNER_ID }) as any);
    const result = await createPricingRule(PROPERTY_ID, OWNER_ID, { rule_type: 'demand' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/price_override or multiplier/i);
  });
});

describe('pricing.service — deletePricingRule', () => {
  it('returns forbidden for non-owner', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ owner_id: 'other' }) as any);
    const result = await deletePricingRule(PROPERTY_ID, 'rule-1', OWNER_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/forbidden/i);
  });
});

describe('pricing.service — getPropertySettings', () => {
  it('returns defaults when no settings row exists', async () => {
    mockSupabase.from.mockReturnValue(mockSingle(null, { code: 'PGRST116' }) as any);
    const result = await getPropertySettings(PROPERTY_ID);
    expect(result.success).toBe(true);
    expect(result.data?.min_stay_nights).toBe(1);
    expect(result.data?.max_stay_nights).toBeNull();
  });

  it('returns existing settings', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ min_stay_nights: 3, max_stay_nights: 14 }) as any);
    const result = await getPropertySettings(PROPERTY_ID);
    expect(result.success).toBe(true);
    expect(result.data?.min_stay_nights).toBe(3);
  });
});

describe('pricing.service — upsertPropertySettings', () => {
  it('returns forbidden for non-owner', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ owner_id: 'other' }) as any);
    const result = await upsertPropertySettings(PROPERTY_ID, OWNER_ID, { min_stay_nights: 3 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/forbidden/i);
  });

  it('returns error for min_stay_nights < 1', async () => {
    mockSupabase.from.mockReturnValue(mockSingle({ owner_id: OWNER_ID }) as any);
    const result = await upsertPropertySettings(PROPERTY_ID, OWNER_ID, { min_stay_nights: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least 1/i);
  });
});
