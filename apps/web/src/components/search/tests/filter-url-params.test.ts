import { describe, it, expect } from 'vitest';

// Mirror the functions from the search page so we can test them in isolation
interface FilterState {
  priceMin: number;
  priceMax: number;
  amenities: string[];
  guests: number;
  checkIn?: string;
  checkOut?: string;
  propertyType: string;
  bedrooms?: number;
  minBathrooms?: number;
  sortBy?: string;
}

function filtersToParams(filters: FilterState, query: string): URLSearchParams {
  const p = new URLSearchParams();
  if (query) p.set('q', query);
  if (filters.priceMin > 0) p.set('priceMin', String(filters.priceMin));
  if (filters.priceMax < 1000) p.set('priceMax', String(filters.priceMax));
  if (filters.guests > 1) p.set('guests', String(filters.guests));
  if (filters.bedrooms) p.set('bedrooms', String(filters.bedrooms));
  if (filters.minBathrooms !== undefined) p.set('minBathrooms', String(filters.minBathrooms));
  if (filters.checkIn) p.set('checkIn', filters.checkIn);
  if (filters.checkOut) p.set('checkOut', filters.checkOut);
  if (filters.propertyType) p.set('type', filters.propertyType);
  if (filters.sortBy && filters.sortBy !== 'newest') p.set('sortBy', filters.sortBy);
  filters.amenities?.forEach(a => p.append('amenities', a));
  return p;
}

function paramsToFilters(p: URLSearchParams): FilterState {
  return {
    priceMin: p.has('priceMin') ? Number(p.get('priceMin')) : 0,
    priceMax: p.has('priceMax') ? Number(p.get('priceMax')) : 1000,
    guests: p.has('guests') ? Number(p.get('guests')) : 1,
    bedrooms: p.has('bedrooms') ? Number(p.get('bedrooms')) : undefined,
    amenities: p.getAll('amenities'),
    checkIn: p.get('checkIn') ?? undefined,
    checkOut: p.get('checkOut') ?? undefined,
    propertyType: p.get('type') ?? '',
    sortBy: (p.get('sortBy') ?? 'newest') as FilterState['sortBy'],
    minBathrooms: p.has('minBathrooms') ? Number(p.get('minBathrooms')) : undefined,
  };
}

describe('filter URL serialization', () => {
  const defaults: FilterState = {
    priceMin: 0, priceMax: 1000, amenities: [], guests: 1,
    propertyType: '', sortBy: 'newest',
  };

  it('round-trips a full filter set', () => {
    const filters: FilterState = {
      priceMin: 50, priceMax: 300, amenities: ['WiFi', 'Pool'],
      guests: 3, bedrooms: 2, minBathrooms: 1,
      checkIn: '2026-12-01', checkOut: '2026-12-07',
      propertyType: 'Villa', sortBy: 'price_asc',
    };
    const params = filtersToParams(filters, 'Barcelona');
    const restored = paramsToFilters(params);
    expect(restored.priceMin).toBe(50);
    expect(restored.priceMax).toBe(300);
    expect(restored.amenities).toEqual(['WiFi', 'Pool']);
    expect(restored.guests).toBe(3);
    expect(restored.bedrooms).toBe(2);
    expect(restored.minBathrooms).toBe(1);
    expect(restored.checkIn).toBe('2026-12-01');
    expect(restored.checkOut).toBe('2026-12-07');
    expect(restored.propertyType).toBe('Villa');
    expect(restored.sortBy).toBe('price_asc');
  });

  it('defaults are not emitted for default values', () => {
    const params = filtersToParams(defaults, '');
    expect(params.toString()).toBe('');
  });

  it('invalid numeric param falls back gracefully', () => {
    const p = new URLSearchParams('priceMin=notanumber');
    const result = paramsToFilters(p);
    expect(Number.isNaN(result.priceMin)).toBe(true); // caller should validate
  });

  it('back-nav URL with unknown params does not crash', () => {
    const p = new URLSearchParams('q=test&unknownParam=xyz');
    expect(() => paramsToFilters(p)).not.toThrow();
  });

  it('empty amenities list is not emitted', () => {
    const params = filtersToParams({ ...defaults }, '');
    expect(params.getAll('amenities')).toHaveLength(0);
  });
});
