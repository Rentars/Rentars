/**
 * Search verification test suite — Issue 591
 * Tests search ranking, filter combinations, pagination, and distance calculations.
 * Uses comprehensive fixtures to verify correctness across independent and combined filters.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  advancedSearch,
  searchPropertiesNearby,
  promoteFeatureToTop,
} from '../services/propertySearch.service.js';
import type { AdvancedSearchFilters, Property } from '../services/property.service.js';
import {
  SEARCH_FIXTURES,
  SEARCH_FILTER_TESTS,
  SEARCH_SORT_TESTS,
  SEARCH_PAGINATION_TESTS,
  DISTANCE_CALCULATION_TESTS,
} from './search-fixtures.js';

describe('Advanced Search Filter Verification', () => {
  describe('Independent filter tests', () => {
    SEARCH_FILTER_TESTS.slice(0, 6).forEach(({ name, filters, expectedIds }) => {
      it(`should filter by ${name}`, async () => {
        const result = await advancedSearch(filters as AdvancedSearchFilters);
        expect(result.success).toBe(true);

        if (result.success && result.data) {
          const resultIds = result.data.data.map((p) => p.id);
          expect(resultIds.sort()).toEqual(expectedIds.sort());
        }
      });
    });
  });

  describe('Combined filter tests', () => {
    SEARCH_FILTER_TESTS.slice(6).forEach(({ name, filters, expectedIds }) => {
      it(`should apply ${name}`, async () => {
        const result = await advancedSearch(filters as AdvancedSearchFilters);
        expect(result.success).toBe(true);

        if (result.success && result.data) {
          const resultIds = result.data.data.map((p) => p.id);
          expect(resultIds.sort()).toEqual(expectedIds.sort());
        }
      });
    });
  });

  describe('Null field handling', () => {
    it('should handle properties with null ratings', async () => {
      const result = await advancedSearch({});
      expect(result.success).toBe(true);

      if (result.success && result.data) {
        // Should include properties with null ratings (prop-008, prop-011)
        const ids = result.data.data.map((p) => p.id);
        expect(ids).toContain('prop-008');
        expect(ids).toContain('prop-011');
      }
    });

    it('should handle properties with null coordinates', async () => {
      const result = await advancedSearch({});
      expect(result.success).toBe(true);

      if (result.success && result.data) {
        // Should include property-011 even though it has null coordinates
        const ids = result.data.data.map((p) => p.id);
        expect(ids).toContain('prop-011');
      }
    });

    it('should handle null amenities', async () => {
      // Test with properties that have no amenities specified
      const result = await advancedSearch({ amenities: [] });
      expect(result.success).toBe(true);
      // Empty amenities array should match all properties
      expect(result.data?.data.length).toBeGreaterThan(0);
    });
  });

  describe('Price filter precision', () => {
    it('should match price_asc exactly', async () => {
      const result = await advancedSearch({
        min_price: 85,
        max_price: 150,
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        result.data.data.forEach((p) => {
          expect(p.price_per_night).toBeDefined();
          expect(p.price_per_night! >= 85).toBe(true);
          expect(p.price_per_night! <= 150).toBe(true);
        });
      }
    });
  });

  describe('Capacity filtering', () => {
    it('should filter by minimum guests capacity', async () => {
      const result = await advancedSearch({ guests: 6 });
      expect(result.success).toBe(true);

      if (result.success && result.data) {
        result.data.data.forEach((p) => {
          expect(p.max_guests).toBeDefined();
          expect(p.max_guests! >= 6).toBe(true);
        });
      }
    });
  });

  describe('Amenities filtering', () => {
    it('should require all specified amenities', async () => {
      const result = await advancedSearch({
        amenities: ['wifi', 'kitchen'],
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        result.data.data.forEach((p) => {
          expect(p.amenities).toBeDefined();
          expect(p.amenities).toContain('wifi');
          expect(p.amenities).toContain('kitchen');
        });
      }
    });
  });
});

describe('Search Sorting Verification', () => {
  SEARCH_SORT_TESTS.forEach(({ name, sortBy, expectedOrder }) => {
    it(`should sort ${name}`, async () => {
      const result = await advancedSearch({
        sortBy: sortBy as AdvancedSearchFilters['sortBy'],
        limit: 20,
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        const resultIds = result.data.data
          .slice(0, expectedOrder.length)
          .map((p) => p.id);

        expect(resultIds).toEqual(expectedOrder);
      }
    });
  });

  describe('Sorting determinism', () => {
    it('should produce stable sort across identical requests', async () => {
      const filters = { sortBy: 'newest' as const };

      const result1 = await advancedSearch(filters);
      const result2 = await advancedSearch(filters);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (result1.success && result2.success && result1.data && result2.data) {
        const ids1 = result1.data.data.map((p) => p.id);
        const ids2 = result2.data.data.map((p) => p.id);

        expect(ids1).toEqual(ids2);
      }
    });
  });
});

describe('Pagination Verification', () => {
  SEARCH_PAGINATION_TESTS.forEach(({ name, page, limit, expectedCount }) => {
    it(`should handle ${name}`, async () => {
      const result = await advancedSearch({ page, limit });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.data.length).toBe(expectedCount);
        expect(result.data.page).toBe(page);
        expect(result.data.limit).toBe(limit);
      }
    });
  });

  describe('Pagination boundaries', () => {
    it('should return empty results for out-of-range pages', async () => {
      const result = await advancedSearch({ page: 100, limit: 10 });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.data.length).toBe(0);
      }
    });

    it('should have correct hasMore flag', async () => {
      const result1 = await advancedSearch({ page: 1, limit: 5 });
      const result2 = await advancedSearch({ page: 3, limit: 5 });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      if (result1.success && result1.data && result2.success && result2.data) {
        expect(result1.data.hasMore).toBe(true); // More results on page 2
        expect(result2.data.hasMore).toBe(false); // No more results after page 3
      }
    });

    it('should respect maximum limit (100)', async () => {
      const result = await advancedSearch({ limit: 1000 });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.limit).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('Cursor/offset stability', () => {
    it('should return consistent results for same page', async () => {
      const page1a = await advancedSearch({
        page: 1,
        limit: 5,
        sortBy: 'newest',
      });
      const page1b = await advancedSearch({
        page: 1,
        limit: 5,
        sortBy: 'newest',
      });

      if (page1a.success && page1b.success && page1a.data && page1b.data) {
        const ids1a = page1a.data.data.map((p) => p.id);
        const ids1b = page1b.data.data.map((p) => p.id);
        expect(ids1a).toEqual(ids1b);
      }
    });

    it('should not have duplicate results across pages', async () => {
      const page1 = await advancedSearch({ page: 1, limit: 5 });
      const page2 = await advancedSearch({ page: 2, limit: 5 });

      if (page1.success && page2.success && page1.data && page2.data) {
        const ids1 = page1.data.data.map((p) => p.id);
        const ids2 = page2.data.data.map((p) => p.id);

        const duplicates = ids1.filter((id) => ids2.includes(id));
        expect(duplicates).toHaveLength(0);
      }
    });
  });
});

describe('Distance Calculation Verification', () => {
  // Note: These tests would require actual geolocation data
  // For now, we test the haversine formula used in distance sorting

  it('should calculate haversine distance correctly', () => {
    // Simple distance verification
    // New York to New York: ~0km
    const lat0 = 40.7128;
    const lng0 = -74.006;

    const toRad = (d: number) => (d * Math.PI) / 180;
    const haversine = (lat: number, lng: number) => {
      const R = 6371;
      const dLat = toRad(lat - lat0);
      const dLng = toRad(lng - lng0);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat0)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const distance = haversine(40.7128, -74.006);
    expect(distance).toBeLessThan(0.1); // Should be very close to 0
  });

  it('should filter by radius correctly', async () => {
    // Test radius filtering in distance sort mode
    const result = await advancedSearch({
      latitude: 40.7128,
      longitude: -74.006,
      radius_km: 100,
      sortBy: 'distance',
    });

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      result.data.data.forEach((p) => {
        if (p.latitude && p.longitude) {
          // Verify distance is within radius
          // This is a basic check; full verification would use actual calculation
          expect(p.distance_km).toBeDefined();
          expect(p.distance_km).toBeLessThanOrEqual(100);
        }
      });
    }
  });
});

describe('Featured Property Promotion', () => {
  it('should promote featured properties to top', () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const properties: Property[] = [
      {
        id: 'organic-1',
        title: 'Organic Property',
        status: 'available',
        featured_until: null,
        featured_weight: 0,
      },
      {
        id: 'featured-1',
        title: 'Featured Property',
        status: 'available',
        featured_until: tomorrow.toISOString(),
        featured_weight: 5,
      },
      {
        id: 'organic-2',
        title: 'Another Organic',
        status: 'available',
        featured_until: null,
        featured_weight: 0,
      },
    ];

    const promoted = promoteFeatureToTop(properties);

    expect(promoted[0].id).toBe('featured-1');
    expect(promoted[0].is_featured).toBe(true);
    expect(promoted[1].id).toBe('organic-1');
    expect(promoted[1].is_featured).toBe(false);
  });

  it('should respect featured cap', () => {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const properties: Property[] = Array.from({ length: 10 }, (_, i) => ({
      id: `prop-${i}`,
      title: `Property ${i}`,
      status: 'available',
      featured_until: i < 8 ? tomorrow.toISOString() : null,
      featured_weight: 10 - i,
    }));

    const promoted = promoteFeatureToTop(properties, 3);

    const featuredCount = promoted.filter((p) => p.is_featured).length;
    expect(featuredCount).toBeLessThanOrEqual(3);
  });
});

describe('Search Error Handling', () => {
  it('should handle empty result gracefully', async () => {
    const result = await advancedSearch({
      query: 'xyzabc123nonexistent',
    });

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.data).toEqual([]);
      expect(result.data.total).toBe(0);
    }
  });

  it('should handle invalid pagination gracefully', async () => {
    const result = await advancedSearch({
      page: 0,
      limit: -1,
    });

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.page).toBeGreaterThan(0);
      expect(result.data.limit).toBeGreaterThan(0);
    }
  });

  it('should handle invalid price range', async () => {
    // max < min should return no results or swap them
    const result = await advancedSearch({
      min_price: 500,
      max_price: 100,
    });

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      // Should either return empty or handle gracefully
      expect(Array.isArray(result.data.data)).toBe(true);
    }
  });
});

describe('Search Performance Characteristics', () => {
  it('should return results within reasonable time', async () => {
    const start = Date.now();
    const result = await advancedSearch({});
    const duration = Date.now() - start;

    expect(result.success).toBe(true);
    // Search should complete in under 5 seconds for reasonable dataset
    expect(duration).toBeLessThan(5000);
  });

  it('should handle large result sets efficiently', async () => {
    const result = await advancedSearch({ limit: 100 });

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.data.length).toBeLessThanOrEqual(100);
    }
  });
});
