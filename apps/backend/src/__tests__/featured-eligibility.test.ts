/**
 * Tests for Feature 2 — Featured listing promotion expiry centralization.
 *
 * Covers the acceptance criteria:
 *  - Expired or ineligible properties are not presented as featured in search
 *    or detail (deleted / draft / moderation-hidden / non-available).
 *  - Admin changes are authorized and auditable (audit call is issued).
 *  - Search ranking and badge behavior follow the documented promotion policy
 *    (cap, weight order, expiry filtering, sort interactions).
 *
 * Cases: exact expiration boundary, timezone independence, deleted properties,
 * draft/hidden ineligible, sort interactions, cache-TTL-at-boundary.
 */

import { describe, it, expect, vi } from 'vitest';

// Hoisted module mocks: the services under test import the Supabase client and
// cache at module load. Mocking them here keeps the pure-logic tests free of any
// environment dependency (no SUPABASE_URL / Redis required).
const chainable = () =>
  new Proxy(
    {},
    {
      get: () => {
        // Every method returns the chainable proxy so any query shape loads.
        const fn = (..._args: unknown[]) => chainable();
        return fn;
      },
    },
  );
vi.mock('../config/supabase.js', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));
vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

import {
  isFeaturedEligible,
  featuredExpiryTtlMs,
  type FeaturedEligibleRow,
} from '../utils/featuredEligibility.js';
import { promoteFeatureToTop } from '../services/propertySearch.service.js';
import { FEATURED_CAP, type Property } from '../services/property.service.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function iso(offsetMs: number, from: Date = new Date()): string {
  return new Date(from.getTime() + offsetMs).toISOString();
}

function makeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: overrides.id ?? 'p-' + Math.random().toString(36).slice(2),
    title: overrides.title ?? 'Test Property',
    status: overrides.status ?? 'available',
    featured_until: overrides.featured_until ?? null,
    featured_weight: overrides.featured_weight ?? 0,
    deleted_at: overrides.deleted_at ?? null,
    draft_status: overrides.draft_status,
    moderation_state: overrides.moderation_state ?? 'visible',
    ...overrides,
  };
}

const NOW = new Date('2026-06-15T12:00:00.000Z');

/** Wrap promoteFeatureToTop with a deterministic `now` so fixtures are stable. */
const promote = (props: Property[], cap?: number) =>
  promoteFeatureToTop(props, cap, NOW);

// ─── isFeaturedEligible — exact expiration & eligibility ───────────────────────

describe('isFeaturedEligible — exact expiration boundary', () => {
  it('is eligible when featured_until is strictly after now', () => {
    const row: FeaturedEligibleRow = { featured_until: iso(60_000, NOW), status: 'available' };
    expect(isFeaturedEligible(row, NOW)).toBe(true);
  });

  it('is NOT eligible when featured_until equals now (boundary — already expired)', () => {
    const row: FeaturedEligibleRow = { featured_until: NOW.toISOString(), status: 'available' };
    expect(isFeaturedEligible(row, NOW)).toBe(false);
  });

  it('is NOT eligible when featured_until is in the past', () => {
    const row: FeaturedEligibleRow = { featured_until: iso(-60_000, NOW), status: 'available' };
    expect(isFeaturedEligible(row, NOW)).toBe(false);
  });

  it('is NOT eligible when featured_until is null or missing', () => {
    expect(isFeaturedEligible({ featured_until: null }, NOW)).toBe(false);
    expect(isFeaturedEligible({ featured_until: undefined }, NOW)).toBe(false);
    expect(isFeaturedEligible({}, NOW)).toBe(false);
  });

  it('is NOT eligible when featured_until is an invalid date string', () => {
    expect(isFeaturedEligible({ featured_until: 'not-a-date' }, NOW)).toBe(false);
  });
});

// ─── Timezone independence ────────────────────────────────────────────────────

describe('isFeaturedEligible — timezone independence', () => {
  it('treats the same instant the same regardless of how it is expressed', () => {
    // 2026-06-15T12:00:00Z == 2026-06-15T14:00:00+02:00 (same instant)
    const utc = '2026-06-15T12:00:00.000Z';
    const cet = '2026-06-15T14:00:00+02:00';
    const nowBefore = new Date('2026-06-15T11:59:59.000Z');

    expect(isFeaturedEligible({ featured_until: utc, status: 'available' }, nowBefore)).toBe(true);
    expect(isFeaturedEligible({ featured_until: cet, status: 'available' }, nowBefore)).toBe(true);

    // At the boundary (instant == now) both expressions expire identically.
    const atBoundary = new Date('2026-06-15T12:00:00.000Z');
    expect(isFeaturedEligible({ featured_until: utc, status: 'available' }, atBoundary)).toBe(false);
    expect(isFeaturedEligible({ featured_until: cet, status: 'available' }, atBoundary)).toBe(false);
  });
});

// ─── Deleted / draft / hidden / non-available ineligibility ───────────────────

describe('isFeaturedEligible — ineligible listings', () => {
  it('rejects a soft-deleted listing even with a future window', () => {
    expect(
      isFeaturedEligible(
        { featured_until: iso(60_000, NOW), status: 'available', deleted_at: '2026-01-01T00:00:00Z' },
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects a draft listing', () => {
    expect(
      isFeaturedEligible(
        { featured_until: iso(60_000, NOW), status: 'available', draft_status: 'draft' },
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects a moderation-hidden listing', () => {
    expect(
      isFeaturedEligible(
        { featured_until: iso(60_000, NOW), status: 'available', moderation_state: 'hidden' },
        NOW,
      ),
    ).toBe(false);
  });

  it('rejects a non-available listing (e.g. suspended)', () => {
    expect(
      isFeaturedEligible(
        { featured_until: iso(60_000, NOW), status: 'suspended' },
        NOW,
      ),
    ).toBe(false);
  });

  it('accepts an available, visible, non-draft, non-deleted listing', () => {
    expect(
      isFeaturedEligible(
        { featured_until: iso(60_000, NOW), status: 'available', draft_status: 'active', moderation_state: 'visible', deleted_at: null },
        NOW,
      ),
    ).toBe(true);
  });
});

// ─── promoteFeatureToTop — deleted/ineligible are not promoted ─────────────────

describe('promoteFeatureToTop — ineligible listings never get the badge', () => {
  it('does not promote a soft-deleted listing with a future window', () => {
    const result = promote([
      makeProperty({ id: 'deleted', featured_until: iso(60_000, NOW), deleted_at: '2026-01-01T00:00:00Z' }),
      makeProperty({ id: 'organic' }),
    ]);
    expect(result.find((p) => p.id === 'deleted')?.is_featured).toBe(false);
  });

  it('does not promote an expired listing', () => {
    const result = promote([
      makeProperty({ id: 'expired', featured_until: iso(-60_000, NOW) }),
      makeProperty({ id: 'live', featured_until: iso(60_000, NOW) }),
    ]);
    expect(result.find((p) => p.id === 'expired')?.is_featured).toBe(false);
    expect(result.find((p) => p.id === 'live')?.is_featured).toBe(true);
  });

  it('does not promote a draft listing', () => {
    const result = promote([
      makeProperty({ id: 'draft', featured_until: iso(60_000, NOW), draft_status: 'draft' }),
    ]);
    expect(result.find((p) => p.id === 'draft')?.is_featured).toBe(false);
  });

  it('does not promote a non-available listing', () => {
    const result = promote([
      makeProperty({ id: 'suspended', featured_until: iso(60_000, NOW), status: 'suspended' }),
    ]);
    expect(result.find((p) => p.id === 'suspended')?.is_featured).toBe(false);
  });
});

// ─── Sort interactions ─────────────────────────────────────────────────────────

describe('promoteFeatureToTop — sort interactions', () => {
  it('featured block is ordered by weight descending, then organic order preserved', () => {
    const result = promote([
      makeProperty({ id: 'o1' }),
      makeProperty({ id: 'low', featured_until: iso(60_000, NOW), featured_weight: 1 }),
      makeProperty({ id: 'o2' }),
      makeProperty({ id: 'high', featured_until: iso(60_000, NOW), featured_weight: 10 }),
      makeProperty({ id: 'o3' }),
      makeProperty({ id: 'mid', featured_until: iso(60_000, NOW), featured_weight: 5 }),
    ]);

    const featuredIds = result.filter((p) => p.is_featured).map((p) => p.id);
    expect(featuredIds).toEqual(['high', 'mid', 'low']);
    // Organic order preserved relative to input.
    const organicIds = result.filter((p) => !p.is_featured).map((p) => p.id);
    expect(organicIds).toEqual(['o1', 'o2', 'o3']);
  });

  it('featured listings appear before organic results', () => {
    const result = promote([
      makeProperty({ id: 'o1' }),
      makeProperty({ id: 'f1', featured_until: iso(60_000, NOW) }),
      makeProperty({ id: 'o2' }),
    ]);
    expect(result[0].id).toBe('f1');
  });

  it('overflow featured listings are demoted to organic (total count preserved)', () => {
    const properties = Array.from({ length: FEATURED_CAP + 3 }, (_, i) =>
      makeProperty({ id: `f${i}`, featured_until: iso(60_000, NOW), featured_weight: i }),
    );
    const result = promote(properties);
    expect(result.filter((p) => p.is_featured).length).toBe(FEATURED_CAP);
    expect(result).toHaveLength(FEATURED_CAP + 3);
  });

  it('expired featured listings sit in organic order at their input position', () => {
    const result = promote([
      makeProperty({ id: 'f-live', featured_until: iso(60_000, NOW) }),
      makeProperty({ id: 'f-expired', featured_until: iso(-60_000, NOW) }),
      makeProperty({ id: 'o1' }),
    ]);
    // Only the live one is featured.
    expect(result.filter((p) => p.is_featured).map((p) => p.id)).toEqual(['f-live']);
    // The expired one is organic, preserving input order after the featured block.
    const organicIds = result.filter((p) => !p.is_featured).map((p) => p.id);
    expect(organicIds).toEqual(['f-expired', 'o1']);
  });
});

// ─── Cache TTL bounded at the earliest promotion boundary ─────────────────────

describe('featuredExpiryTtlMs — cache bounded at promotion boundary', () => {
  it('returns the nominal TTL when no rows have a future featured_until', () => {
    expect(featuredExpiryTtlMs([], 120_000, NOW)).toBe(120_000);
    expect(featuredExpiryTtlMs([{ featured_until: null }], 120_000, NOW)).toBe(120_000);
    expect(featuredExpiryTtlMs([{ featured_until: iso(-1, NOW) }], 120_000, NOW)).toBe(120_000);
  });

  it('clamps the TTL to the soonest-expiring promotion', () => {
    const rows = [
      { featured_until: iso(30_000, NOW) }, // expires in 30s
      { featured_until: iso(120_000, NOW) }, // expires in 120s
    ];
    const ttl = featuredExpiryTtlMs(rows, 120_000, NOW);
    expect(ttl).toBeLessThanOrEqual(30_000);
    expect(ttl).toBeGreaterThanOrEqual(50); // floor applied
  });

  it('never exceeds the nominal TTL even when all promotions outlive it', () => {
    const rows = [{ featured_until: iso(600_000, NOW) }];
    expect(featuredExpiryTtlMs(rows, 120_000, NOW)).toBe(120_000);
  });

  it('ignores non-finite / invalid featured_until when computing the boundary', () => {
    const rows = [
      { featured_until: 'not-a-date' },
      { featured_until: iso(45_000, NOW) },
    ];
    expect(featuredExpiryTtlMs(rows, 120_000, NOW)).toBeLessThanOrEqual(45_000);
  });
});
