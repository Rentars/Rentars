import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────
// bun:test requires mock.module() to intercept ES module exports.
// The mock must be set up before the tested module is imported.

const mockRpc = mock(async () => ({ data: null, error: null }));
const mockFrom = mock((_: string) => ({}));

mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    get rpc() { return mockRpc; },
    get from() { return mockFrom; },
  },
}));

const { searchPropertiesNearby, searchPropertiesByQuery } =
  await import('../../src/services/propertySearch.service.js');

// ─────────────────────────────────────────────────────────────────────────────

const BASE_RESULT = {
  id: 'p1',
  title: 'Beach House',
  price_per_night: 120,
  city: 'Miami',
  country: 'US',
  bedrooms: 2,
  amenities: ['wifi', 'pool'],
};

describe('searchPropertiesNearby', () => {
  beforeEach(() => {
    mockRpc.mockClear();
  });

  it('returns properties within the radius ordered by distance', async () => {
    const nearby = [
      { ...BASE_RESULT, id: 'p1', distance_km: 3 },
      { ...BASE_RESULT, id: 'p2', distance_km: 8 },
    ];
    mockRpc.mockImplementation(async () => ({ data: nearby, error: null }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 10 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].distance_km).toBeLessThan(result.data![1].distance_km);
  });

  it('excludes properties outside the radius', async () => {
    // DB function already filters; service returns only what the RPC gives back
    const insideBoundary = [{ ...BASE_RESULT, id: 'p1', distance_km: 9.9 }];
    mockRpc.mockImplementation(async () => ({ data: insideBoundary, error: null }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 10 });

    expect(result.success).toBe(true);
    expect(result.data!.every((p) => p.distance_km <= 10)).toBe(true);
  });

  it('returns empty array when no properties are within the radius', async () => {
    mockRpc.mockImplementation(async () => ({ data: [], error: null }));

    const result = await searchPropertiesNearby({ lat: 0, lng: 0, radiusKm: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });

  it('returns distance_km with each result', async () => {
    const nearby = [{ ...BASE_RESULT, id: 'p1', distance_km: 5.2 }];
    mockRpc.mockImplementation(async () => ({ data: nearby, error: null }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 20 });

    expect(result.success).toBe(true);
    expect(typeof result.data![0].distance_km).toBe('number');
  });

  it('forwards rpc error as failure', async () => {
    mockRpc.mockImplementation(async () => ({
      data: null,
      error: { message: 'PostGIS unavailable' },
    }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('PostGIS unavailable');
  });

  it('calls the search_nearby_properties rpc with correct params', async () => {
    mockRpc.mockImplementation(async () => ({ data: [], error: null }));

    await searchPropertiesNearby({ lat: 48.85, lng: 2.35, radiusKm: 25 });

    expect(mockRpc).toHaveBeenCalledWith('search_nearby_properties', {
      lat: 48.85,
      lng: 2.35,
      radius_km: 25,
    });
  });

  // ── #426: null data normalisation ──────────────────────────────────────────

  it('returns empty array when rpc resolves { data: null, error: null }', async () => {
    mockRpc.mockImplementation(async () => ({ data: null, error: null }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 10 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  // ── #427: radius validation ─────────────────────────────────────────────────

  it('rejects a zero radius before calling the database', async () => {
    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/finite positive/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a negative radius before calling the database', async () => {
    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: -5 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/finite positive/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects NaN radius before calling the database', async () => {
    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: NaN });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/finite positive/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects Infinity radius before calling the database', async () => {
    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: Infinity });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/finite positive/i);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('accepts a positive finite radius and calls the database', async () => {
    mockRpc.mockImplementation(async () => ({ data: [], error: null }));

    const result = await searchPropertiesNearby({ lat: 25.77, lng: -80.19, radiusKm: 15 });

    expect(result.success).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('searchPropertiesByQuery', () => {
  beforeEach(() => {
    mockRpc.mockClear();
  });

  it('returns empty array for empty query', async () => {
    const result = await searchPropertiesByQuery('');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('calls the search_properties_ranked rpc with correct params', async () => {
    mockRpc.mockImplementation(async () => ({ data: [], error: null }));

    await searchPropertiesByQuery('beach house');

    expect(mockRpc).toHaveBeenCalledWith('search_properties_ranked', {
      search_query: 'beach house',
      result_limit: 50,
      result_offset: 0,
    });
  });

  it('returns properties ordered by rank from rpc', async () => {
    const ranked = [
      { id: 'p1', title: 'Beach House Miami', city: 'Miami', rank: 0.8 },
      { id: 'p2', title: 'Cozy Cottage', city: 'Miami', description: 'Near the beach house', rank: 0.3 },
    ];
    mockRpc.mockImplementation(async () => ({ data: ranked, error: null }));

    const result = await searchPropertiesByQuery('beach house');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data![0].id).toBe('p1');
    expect(result.data![1].id).toBe('p2');
  });

  it('title match outranks description-only match', async () => {
    // The RPC returns results ordered by ts_rank_cd DESC.
    // Title match (weight A) should have higher rank than description-only match (weight C).
    const ranked = [
      { id: 'title-match', title: 'Beach House', city: 'Miami', rank: 0.9 },
      { id: 'desc-match', title: 'Cozy Cottage', city: 'Miami', description: 'A quiet beach house retreat', rank: 0.2 },
    ];
    mockRpc.mockImplementation(async () => ({ data: ranked, error: null }));

    const result = await searchPropertiesByQuery('beach house');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    // Title match should appear first (higher rank from ts_rank_cd)
    expect(result.data![0].id).toBe('title-match');
    expect(result.data![1].id).toBe('desc-match');
  });

  it('forwards rpc error as failure', async () => {
    mockRpc.mockImplementation(async () => ({
      data: null,
      error: { message: 'RPC function not found' },
    }));

    const result = await searchPropertiesByQuery('test');

    expect(result.success).toBe(false);
    expect(result.error).toBe('RPC function not found');
  });

  it('returns empty array when no results match', async () => {
    mockRpc.mockImplementation(async () => ({ data: [], error: null }));

    const result = await searchPropertiesByQuery('xyznonexistent');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });
});
