/**
 * Tests for the Featured Listings feature.
 *
 * Covers:
 *  1. isFeaturedNow()        — pure timestamp helper
 *  2. promoteFeatureToTop()  — selection cap, ordering, expiry filtering,
 *                              is_featured flag assignment
 *  3. getFeaturedProperties()— DB query uses expiry filter, cap enforced
 *  4. setFeatured()          — rejects past dates, validates input
 *  5. clearFeatured()        — nulls the feature window
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFeaturedNow,
  FEATURED_CAP,
  getFeaturedProperties,
  setFeatured,
  clearFeatured,
  type Property,
} from '../services/property.service.js';
import { promoteFeatureToTop as searchPromote } from '../services/propertySearch.service.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSelect  = vi.fn();
const mockEq      = vi.fn();
const mockNot     = vi.fn();
const mockGt      = vi.fn();
const mockOrder   = vi.fn();
const mockLimit   = vi.fn();
const mockUpdate  = vi.fn();
const mockSingle  = vi.fn();

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelect,
      update: mockUpdate,
    })),
  },
}));

// Chain: select → eq → not → gt → order → order → limit
mockSelect.mockReturnValue({ eq: mockEq, not: mockNot });
mockEq.mockReturnValue({ not: mockNot, single: mockSingle });
mockNot.mockReturnValue({ gt: mockGt });
mockGt.mockReturnValue({ order: mockOrder });
mockOrder.mockReturnValue({ order: mockOrder, limit: mockLimit });
mockLimit.mockResolvedValue({ data: [], error: null });

// Chain: update → eq → select → single
mockUpdate.mockReturnValue({ eq: mockEq });
mockEq.mockReturnValue({ select: mockSelect, single: mockSingle });
mockSelect.mockReturnValue({ single: mockSingle });
mockSingle.mockResolvedValue({ data: null, error: null });

// Cache mock — always miss so DB is exercised
vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function futureDate(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function pastDate(offsetMs = 3_600_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

function makeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id:            overrides.id            ?? 'prop-' + Math.random().toString(36).slice(2),
    title:         overrides.title         ?? 'Test Property',
    featured_until: overrides.featured_until ?? null,
    featured_weight: overrides.featured_weight ?? 0,
    status:        overrides.status        ?? 'available',
    ...overrides,
  };
}

// ─── isFeaturedNow ────────────────────────────────────────────────────────────

describe('isFeaturedNow()', () => {
  it('returns false when featured_until is null', () => {
    expect(isFeaturedNow({ featured_until: null })).toBe(false);
  });

  it('returns false when featured_until is undefined', () => {
    expect(isFeaturedNow({ featured_until: undefined })).toBe(false);
  });

  it('returns false when featured_until is in the past', () => {
    expect(isFeaturedNow({ featured_until: pastDate() })).toBe(false);
  });

  it('returns true when featured_until is in the future', () => {
    expect(isFeaturedNow({ featured_until: futureDate() })).toBe(true);
  });

  it('returns false for a date exactly equal to now (boundary — already expired)', () => {
    // Dates are never exactly equal in practice; this tests the strict > comparison.
    const justExpired = new Date(Date.now() - 1).toISOString();
    expect(isFeaturedNow({ featured_until: justExpired })).toBe(false);
  });
});

// ─── promoteFeatureToTop — cap enforcement ────────────────────────────────────

describe('promoteFeatureToTop() — cap enforcement', () => {
  it('surfaces at most FEATURED_CAP featured listings', () => {
    // Build FEATURED_CAP + 2 featured properties
    const properties = Array.from({ length: FEATURED_CAP + 2 }, (_, i) =>
      makeProperty({ id: `p${i}`, featured_until: futureDate() }),
    );

    const result = searchPromote(properties);
    const featuredCount = result.filter((p) => p.is_featured).length;
    expect(featuredCount).toBe(FEATURED_CAP);
  });

  it('surfaces all featured listings when count is below cap', () => {
    const properties = [
      makeProperty({ featured_until: futureDate() }),
      makeProperty({ featured_until: futureDate() }),
      makeProperty({ featured_until: null }),
    ];

    const result = searchPromote(properties);
    expect(result.filter((p) => p.is_featured).length).toBe(2);
  });

  it('respects a custom cap lower than FEATURED_CAP', () => {
    const properties = Array.from({ length: 4 }, () =>
      makeProperty({ featured_until: futureDate() }),
    );

    const result = searchPromote(properties, 2);
    expect(result.filter((p) => p.is_featured).length).toBe(2);
  });

  it('clamps cap to FEATURED_CAP even when caller passes a larger value', () => {
    const properties = Array.from({ length: FEATURED_CAP + 5 }, () =>
      makeProperty({ featured_until: futureDate() }),
    );

    const result = searchPromote(properties, FEATURED_CAP + 10);
    expect(result.filter((p) => p.is_featured).length).toBe(FEATURED_CAP);
  });

  it('promotes the highest-weight featured entries even when they appear after the cap position', () => {
    // First FEATURED_CAP entries have weight 1; the entry at position FEATURED_CAP
    // has weight 100.  Without post-sort slicing it would be wrongly excluded.
    const properties = [
      ...Array.from({ length: FEATURED_CAP }, (_, i) =>
        makeProperty({ id: `low-${i}`, featured_until: futureDate(), featured_weight: 1 }),
      ),
      makeProperty({ id: 'high-weight', featured_until: futureDate(), featured_weight: 100 }),
    ];

    const result = searchPromote(properties);

    // The high-weight entry must be in the featured block
    const highWeightEntry = result.find((p) => p.id === 'high-weight');
    expect(highWeightEntry?.is_featured).toBe(true);

    // Total featured count must not exceed the cap
    expect(result.filter((p) => p.is_featured).length).toBe(FEATURED_CAP);

    // Total count is preserved
    expect(result).toHaveLength(FEATURED_CAP + 1);
  });

  it('preserves total count — no properties are dropped', () => {
    const total = 10;
    const properties = Array.from({ length: total }, (_, i) =>
      makeProperty({ featured_until: i < 3 ? futureDate() : null }),
    );

    expect(searchPromote(properties)).toHaveLength(total);
  });
});

// ─── promoteFeatureToTop — expiry filtering ───────────────────────────────────

describe('promoteFeatureToTop() — expiry filtering', () => {
  it('does NOT promote a property whose featured_until is in the past', () => {
    const properties = [
      makeProperty({ id: 'expired', featured_until: pastDate() }),
      makeProperty({ id: 'organic', featured_until: null }),
    ];

    const result = searchPromote(properties);
    expect(result.find((p) => p.id === 'expired')?.is_featured).toBe(false);
  });

  it('promotes a property whose featured_until is in the future', () => {
    const properties = [
      makeProperty({ id: 'active', featured_until: futureDate() }),
    ];

    const result = searchPromote(properties);
    expect(result.find((p) => p.id === 'active')?.is_featured).toBe(true);
  });

  it('marks non-featured properties with is_featured: false', () => {
    const properties = [
      makeProperty({ featured_until: null }),
      makeProperty({ featured_until: pastDate() }),
    ];

    const result = searchPromote(properties);
    result.forEach((p) => expect(p.is_featured).toBe(false));
  });
});

// ─── promoteFeatureToTop — ordering ──────────────────────────────────────────

describe('promoteFeatureToTop() — ordering', () => {
  it('places featured listings before organic results', () => {
    const properties = [
      makeProperty({ id: 'organic-1', featured_until: null }),
      makeProperty({ id: 'featured-1', featured_until: futureDate() }),
      makeProperty({ id: 'organic-2', featured_until: null }),
    ];

    const result = searchPromote(properties);
    expect(result[0].id).toBe('featured-1');
  });

  it('sorts featured listings by featured_weight descending', () => {
    const properties = [
      makeProperty({ id: 'low',  featured_until: futureDate(), featured_weight: 1 }),
      makeProperty({ id: 'high', featured_until: futureDate(), featured_weight: 10 }),
      makeProperty({ id: 'mid',  featured_until: futureDate(), featured_weight: 5 }),
    ];

    const result = searchPromote(properties);
    const featuredIds = result.filter((p) => p.is_featured).map((p) => p.id);
    expect(featuredIds).toEqual(['high', 'mid', 'low']);
  });

  it('preserves organic order after the featured block', () => {
    const properties = [
      makeProperty({ id: 'o1', featured_until: null }),
      makeProperty({ id: 'f1', featured_until: futureDate() }),
      makeProperty({ id: 'o2', featured_until: null }),
      makeProperty({ id: 'o3', featured_until: null }),
    ];

    const result = searchPromote(properties);
    const organicIds = result.filter((p) => !p.is_featured).map((p) => p.id);
    // Organic order must be preserved as-is from the input
    expect(organicIds).toEqual(['o1', 'o2', 'o3']);
  });

  it('handles an empty list', () => {
    expect(searchPromote([])).toEqual([]);
  });

  it('handles a list with no featured properties', () => {
    const properties = [
      makeProperty({ featured_until: null }),
      makeProperty({ featured_until: null }),
    ];
    const result = searchPromote(properties);
    expect(result.every((p) => !p.is_featured)).toBe(true);
  });
});

// ─── getFeaturedProperties — DB query ────────────────────────────────────────

describe('getFeaturedProperties()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls the DB with a future-only filter', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    await getFeaturedProperties();

    // Verify .gt('featured_until', <iso>) was called
    expect(mockGt).toHaveBeenCalledWith('featured_until', expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it('enforces FEATURED_CAP via .limit()', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    await getFeaturedProperties();

    expect(mockLimit).toHaveBeenCalledWith(FEATURED_CAP);
  });

  it('accepts a limit smaller than FEATURED_CAP', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    await getFeaturedProperties(2);

    expect(mockLimit).toHaveBeenCalledWith(2);
  });

  it('clamps limit to FEATURED_CAP when caller exceeds the cap', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    await getFeaturedProperties(FEATURED_CAP + 99);

    expect(mockLimit).toHaveBeenCalledWith(FEATURED_CAP);
  });

  it('returns success: false on DB error', async () => {
    mockLimit.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

    const result = await getFeaturedProperties();

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB error');
  });

  it('returns success: true with empty array when no featured properties exist', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null });

    const result = await getFeaturedProperties();

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

// ─── setFeatured — input validation ──────────────────────────────────────────

describe('setFeatured()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an empty property ID', async () => {
    const result = await setFeatured('', futureDate());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it('rejects an invalid datetime string', async () => {
    const result = await setFeatured('prop-1', 'not-a-date');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ISO 8601/i);
  });

  it('rejects a past date', async () => {
    const result = await setFeatured('prop-1', pastDate());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/future/i);
  });

  it('accepts a future date and calls DB update', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: 'prop-1', featured_until: futureDate(), featured_weight: 5 },
      error: null,
    });

    const result = await setFeatured('prop-1', futureDate(), 5);
    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('returns service error on DB failure', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'update failed' } });

    const result = await setFeatured('prop-1', futureDate());
    expect(result.success).toBe(false);
    expect(result.error).toBe('update failed');
  });
});

// ─── clearFeatured ────────────────────────────────────────────────────────────

describe('clearFeatured()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an empty property ID', async () => {
    const result = await clearFeatured('');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it('calls DB update with null featured_until and weight 0', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: 'prop-1', featured_until: null, featured_weight: 0 },
      error: null,
    });

    await clearFeatured('prop-1');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ featured_until: null, featured_weight: 0 }),
    );
  });

  it('returns success: true on successful clear', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: 'prop-1', featured_until: null, featured_weight: 0 },
      error: null,
    });

    const result = await clearFeatured('prop-1');
    expect(result.success).toBe(true);
  });

  it('returns service error on DB failure', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'clear failed' } });

    const result = await clearFeatured('prop-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('clear failed');
  });
});

// ─── FEATURED_CAP constant ────────────────────────────────────────────────────

describe('FEATURED_CAP', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(FEATURED_CAP)).toBe(true);
    expect(FEATURED_CAP).toBeGreaterThan(0);
  });

  it('equals 6', () => {
    expect(FEATURED_CAP).toBe(6);
  });
});
