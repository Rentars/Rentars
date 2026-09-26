/**
 * Issue #663 — Database connection/query safeguards
 *
 * Validates:
 *   1. Pagination validator rejects page sizes above MAX_PAGE_SIZE (400).
 *   2. Pagination validator rejects non-integer / negative pages (400).
 *   3. executePaginatedQuery hard-caps pageSize regardless of caller input.
 *   4. executePaginatedQuery rejects invalid page / pageSize inputs with error string.
 *   5. Validator attaches parsedPagination to req on success.
 *   6. Legacy `limit` alias is accepted and capped.
 */

import { describe, it, expect } from 'bun:test';
import { validatePagination, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../../src/validators/pagination.validator.js';
import { executePaginatedQuery } from '../../src/utils/pagination.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(query: Record<string, string>) {
  const req: any = { query };
  const res: any = {
    _status: 0,
    _body: null as any,
    status(code: number) { this._status = code; return this; },
    json(body: any) { this._body = body; return this; },
  };
  return { req, res };
}

// ── validatePagination ────────────────────────────────────────────────────────

describe('validatePagination — rejection cases', () => {
  it('rejects pageSize above MAX_PAGE_SIZE', () => {
    const { req, res } = mockReqRes({ page: '1', pageSize: String(MAX_PAGE_SIZE + 1) });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
    expect(res._body.error.code).toBe('INVALID_PAGINATION');
  });

  it('rejects pageSize of 0', () => {
    const { req, res } = mockReqRes({ page: '1', pageSize: '0' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });

  it('rejects negative page', () => {
    const { req, res } = mockReqRes({ page: '-1' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });

  it('rejects page=0', () => {
    const { req, res } = mockReqRes({ page: '0' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });

  it('rejects non-numeric page', () => {
    const { req, res } = mockReqRes({ page: 'abc' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });
});

describe('validatePagination — success cases', () => {
  it('calls next() and attaches parsedPagination for valid inputs', () => {
    const { req, res } = mockReqRes({ page: '2', pageSize: '50' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.parsedPagination).toEqual({ page: 2, pageSize: 50 });
  });

  it('defaults page to 1 and pageSize to DEFAULT_PAGE_SIZE when omitted', () => {
    const { req, res } = mockReqRes({});
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.parsedPagination.page).toBe(1);
    expect(req.parsedPagination.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('accepts legacy limit alias', () => {
    const { req, res } = mockReqRes({ limit: '30' });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.parsedPagination.pageSize).toBe(30);
  });

  it('rejects limit above MAX_PAGE_SIZE', () => {
    const { req, res } = mockReqRes({ limit: String(MAX_PAGE_SIZE + 1) });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(400);
  });

  it('accepts exactly MAX_PAGE_SIZE', () => {
    const { req, res } = mockReqRes({ pageSize: String(MAX_PAGE_SIZE) });
    let called = false;
    validatePagination(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.parsedPagination.pageSize).toBe(MAX_PAGE_SIZE);
  });
});

// ── executePaginatedQuery ─────────────────────────────────────────────────────

describe('executePaginatedQuery — safeguards', () => {
  function makeQuery(rows: unknown[], total: number) {
    return {
      range: async (_from: number, _to: number) => ({
        data: rows,
        error: null,
        count: total,
      }),
    };
  }

  it('returns error string for page < 1', async () => {
    const q = makeQuery([], 0);
    const out = await executePaginatedQuery(q, 0, 20);
    expect(out.error).toBeTruthy();
    expect(out.result).toBeUndefined();
  });

  it('returns error string for pageSize < 1', async () => {
    const q = makeQuery([], 0);
    const out = await executePaginatedQuery(q, 1, 0);
    expect(out.error).toBeTruthy();
  });

  it('caps pageSize to MAX_PAGE_SIZE silently', async () => {
    let capturedTo = 0;
    const q = {
      range: async (from: number, to: number) => {
        capturedTo = to;
        return { data: [], error: null, count: 0 };
      },
    };
    // Request 9999 rows — should be capped to MAX_PAGE_SIZE
    await executePaginatedQuery(q, 1, 9999);
    // to = from + pageSize - 1 = 0 + 100 - 1 = 99
    expect(capturedTo).toBe(MAX_PAGE_SIZE - 1);
  });

  it('computes correct range for page 3, pageSize 20', async () => {
    let capturedFrom = 0;
    let capturedTo = 0;
    const q = {
      range: async (from: number, to: number) => {
        capturedFrom = from;
        capturedTo = to;
        return { data: [], error: null, count: 100 };
      },
    };
    await executePaginatedQuery(q, 3, 20);
    expect(capturedFrom).toBe(40); // (3-1)*20
    expect(capturedTo).toBe(59);   // 40+20-1
  });

  it('returns correct totalPages', async () => {
    const q = makeQuery(new Array(20).fill({}), 55);
    const out = await executePaginatedQuery(q, 1, 20);
    expect(out.result?.pagination.totalPages).toBe(3); // ceil(55/20)
  });

  it('propagates Supabase error string', async () => {
    const q = {
      range: async () => ({ data: null, error: { message: 'db error' }, count: null }),
    };
    const out = await executePaginatedQuery(q as any, 1, 20);
    expect(out.error).toBe('db error');
  });
});
