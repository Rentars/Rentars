/**
 * Tests for finite non-negative integer guards on bedroom and bathroom filters
 * in the getProperties controller.
 *
 * Covers:
 *  #421 — bedrooms: rejects 1.5 (fractional), -1 (negative), accepts 0 and 2
 *  #422 — min_bathrooms: rejects 2.5 (fractional), -1 (negative), accepts 0 and 1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── Hoist mock refs ─────────────────────────────────────────────────────────

const { mockSearchProperties, mockGetAllProperties } = vi.hoisted(() => {
  const mockSearchProperties = vi.fn();
  const mockGetAllProperties = vi.fn();
  return { mockSearchProperties, mockGetAllProperties };
});

vi.mock('../services/property.service.js', () => ({
  searchProperties: mockSearchProperties,
  getAllProperties: mockGetAllProperties,
  getPropertyById: vi.fn(),
  getPropertyBySlug: vi.fn(),
  createProperty: vi.fn(),
  updateProperty: vi.fn(),
  deleteProperty: vi.fn(),
  advancedSearch: vi.fn(),
  duplicateProperty: vi.fn(),
  getFeaturedProperties: vi.fn(),
  setFeatured: vi.fn(),
  clearFeatured: vi.fn(),
  FEATURED_CAP: 6,
}));

vi.mock('../services/availability.service.js', () => ({
  getAvailabilityRanges: vi.fn(),
  setAvailabilityRanges: vi.fn(),
}));

vi.mock('../services/searchAnalytics.service.js', () => ({
  trackSearch: vi.fn(),
  getSearchSuggestions: vi.fn(),
  getTrendingSearches: vi.fn(),
  trackSuggestionEvent: vi.fn(),
}));

vi.mock('../services/propertySearch.service.js', () => ({
  computeZeroResultSuggestions: vi.fn().mockResolvedValue([]),
  getPriceHistogram: vi.fn().mockResolvedValue(null),
}));

vi.mock('../config/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

vi.mock('../utils/locationPrivacy.js', () => ({
  redactExactCoordinates: vi.fn((p: unknown) => p),
}));

vi.mock('../services/propertyView.service.js', () => ({
  recordPropertyView: vi.fn(),
  getPropertyViewStats: vi.fn(),
  getPropertyViewCount: vi.fn(),
}));

vi.mock('../services/occupancy.service.js', () => ({
  getOccupancyHeatmap: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(query: Record<string, string>): Request {
  return { query, headers: {}, params: {} } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ json, send });
  return { status, json, send } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('#421 bedrooms integer guard in getProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: searchProperties succeeds so we can verify it is NOT called on bad input
    mockSearchProperties.mockResolvedValue({ success: true, data: [] });
  });

  it('rejects a fractional bedroom value (1.5) with 400', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ bedrooms: '1.5' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('bedrooms') }),
    );
    expect(mockSearchProperties).not.toHaveBeenCalled();
  });

  it('rejects a negative bedroom value (-1) with 400', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ bedrooms: '-1' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSearchProperties).not.toHaveBeenCalled();
  });

  it('accepts zero bedrooms and forwards to searchProperties', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ bedrooms: '0' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(mockSearchProperties).toHaveBeenCalledWith(
      expect.objectContaining({ bedrooms: 0 }),
    );
  });

  it('accepts a positive integer bedroom count and forwards to searchProperties', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ bedrooms: '2' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(mockSearchProperties).toHaveBeenCalledWith(
      expect.objectContaining({ bedrooms: 2 }),
    );
  });
});

describe('#422 min_bathrooms integer guard in getProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchProperties.mockResolvedValue({ success: true, data: [] });
  });

  it('rejects a fractional bathroom value (2.5) with 400', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ min_bathrooms: '2.5' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('min_bathrooms') }),
    );
    expect(mockSearchProperties).not.toHaveBeenCalled();
  });

  it('rejects a negative bathroom value (-1) with 400', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ min_bathrooms: '-1' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSearchProperties).not.toHaveBeenCalled();
  });

  it('accepts zero min_bathrooms and forwards to searchProperties', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ min_bathrooms: '0' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(mockSearchProperties).toHaveBeenCalledWith(
      expect.objectContaining({ min_bathrooms: 0 }),
    );
  });

  it('accepts a positive integer bathroom count and forwards to searchProperties', async () => {
    const { getProperties } = await import('../controllers/property.controller.js');
    const req = makeReq({ min_bathrooms: '1' });
    const res = makeRes();

    await getProperties(req, res as unknown as Response);

    expect(mockSearchProperties).toHaveBeenCalledWith(
      expect.objectContaining({ min_bathrooms: 1 }),
    );
  });
});
