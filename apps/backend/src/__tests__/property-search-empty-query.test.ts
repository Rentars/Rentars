/**
 * Tests for whitespace-only search text rejection in propertySearch.controller.ts
 *
 * Covers #423:
 *  - A query of only spaces returns 422 without invoking the search service
 *  - A query of only tabs/newlines returns 422 without invoking the search service
 *  - A missing q returns 422 without invoking the search service
 *  - Valid text is forwarded to the search service (trimmed)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── Hoist mock refs ─────────────────────────────────────────────────────────

const { mockSearchByQuery } = vi.hoisted(() => {
  const mockSearchByQuery = vi.fn();
  return { mockSearchByQuery };
});

vi.mock('../services/propertySearch.service.js', () => ({
  searchPropertiesByQuery: mockSearchByQuery,
  searchPropertiesNearby: vi.fn(),
  computeZeroResultSuggestions: vi.fn().mockResolvedValue([]),
  getPriceHistogram: vi.fn().mockResolvedValue(null),
  promoteFeatureToTop: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(query: Record<string, string | undefined>): Request {
  return { query, headers: {}, params: {} } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const send = vi.fn();
  const jsonFn = vi.fn();
  const statusObj = { json: jsonFn, send };
  const status = vi.fn().mockReturnValue(statusObj);
  return { status, json, statusObj } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    statusObj: typeof statusObj;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('#423 reject whitespace-only search text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchByQuery.mockResolvedValue({ success: true, data: [] });
  });

  it('returns 422 when q is spaces only', async () => {
    const { searchPropertiesEndpoint } = await import('../controllers/propertySearch.controller.js');
    const req = makeReq({ q: '   ' });
    const res = makeRes();

    await searchPropertiesEndpoint(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res as unknown as { statusObj: { json: ReturnType<typeof vi.fn> } }).statusObj.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(mockSearchByQuery).not.toHaveBeenCalled();
  });

  it('returns 422 when q is a tab character', async () => {
    const { searchPropertiesEndpoint } = await import('../controllers/propertySearch.controller.js');
    const req = makeReq({ q: '\t' });
    const res = makeRes();

    await searchPropertiesEndpoint(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockSearchByQuery).not.toHaveBeenCalled();
  });

  it('returns 422 when q is absent', async () => {
    const { searchPropertiesEndpoint } = await import('../controllers/propertySearch.controller.js');
    const req = makeReq({});
    const res = makeRes();

    await searchPropertiesEndpoint(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockSearchByQuery).not.toHaveBeenCalled();
  });

  it('forwards trimmed text to searchPropertiesByQuery for a valid query', async () => {
    const { searchPropertiesEndpoint } = await import('../controllers/propertySearch.controller.js');
    const req = makeReq({ q: '  beach house  ' });
    const res = makeRes();

    await searchPropertiesEndpoint(req, res as unknown as Response);

    expect(mockSearchByQuery).toHaveBeenCalledWith('beach house');
  });

  it('forwards plain text without extra whitespace stripping of internal spaces', async () => {
    const { searchPropertiesEndpoint } = await import('../controllers/propertySearch.controller.js');
    const req = makeReq({ q: 'sea view' });
    const res = makeRes();

    await searchPropertiesEndpoint(req, res as unknown as Response);

    expect(mockSearchByQuery).toHaveBeenCalledWith('sea view');
  });
});
