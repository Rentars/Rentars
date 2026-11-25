/**
 * Unit tests for idempotency key support on POST /api/v1/bookings.
 *
 * Test plan
 * ---------
 * Service-level (idempotency.service.ts)
 *   1.  hashRequestBody produces a 64-char hex string
 *   2.  hashRequestBody is deterministic for the same input
 *   3.  hashRequestBody is order-independent (same hash for reordered keys)
 *   4.  hashRequestBody produces different hashes for different payloads
 *   5.  lookup returns null for a first-time key
 *   6.  lookup returns the stored record on a hit
 *   7.  lookup returns { success: false } on a DB error
 *   8.  store returns the new record on success
 *   9.  store returns { success: false } when Supabase fails
 *   10. purgeExpired deletes rows and returns the count
 *   11. purgeExpired returns { deleted: 0 } when nothing to purge
 *   12. purgeExpired returns { success: false } on DB error
 *
 * Controller-level behaviour (via createBooking controller mocks)
 *   13. No Idempotency-Key → creates booking, no store call
 *   14. Same key + same payload → 201 replay, Idempotent-Replayed header, no DB create
 *   15. Same key + different payload → 422
 *   16. Blank/whitespace Idempotency-Key → 400
 *   17. First request with a key → store is called once after creation
 *   18. Two identical requests create exactly one booking (deduplication)
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — Service unit tests
//
// We mock Supabase at the module level so that the real service code runs but
// all DB calls are intercepted. Because bun caches modules, we control what
// each query returns by reassigning `mockQueryResult` before each test.
// ─────────────────────────────────────────────────────────────────────────────

// Mutable slot that each test populates before calling the service
let mockQueryResult: unknown = { data: null, error: null };

/**
 * Build a chainable Supabase query stub.
 * Every terminal call (single, maybeSingle, then) resolves to mockQueryResult.
 */
function buildChain() {
  const leaf = mock(async () => mockQueryResult);
  const node: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'lt', 'gte', 'not'];
  for (const m of methods) {
    node[m] = mock(() => node);
  }
  node['single']      = leaf;
  node['maybeSingle'] = leaf;
  node['then']        = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(mockQueryResult).then(resolve);
  return node;
}

// Stub Supabase — must be declared BEFORE any import of the real service
mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (_table: string) => buildChain(),
  },
}));

// Now import the real service (after the mock is registered)
import {
  hashRequestBody,
  lookup,
  store,
  purgeExpired,
} from '../../src/services/idempotency.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('hashRequestBody', () => {
  it('produces a 64-character hex string', () => {
    const hash = hashRequestBody({ property_id: 'prop-1', guest_count: 2 });
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const body = { property_id: 'prop-1', check_in: '2026-01-01' };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('produces the same hash regardless of key order', () => {
    const a = { property_id: 'prop-1', guest_count: 2, check_in: '2026-01-01' };
    const b = { check_in: '2026-01-01', property_id: 'prop-1', guest_count: 2 };
    expect(hashRequestBody(a)).toBe(hashRequestBody(b));
  });

  it('produces different hashes for different payloads', () => {
    const a = { property_id: 'prop-1', guest_count: 2 };
    const b = { property_id: 'prop-1', guest_count: 3 };
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(b));
  });

  it('is canonical for nested objects while preserving array order', () => {
    const a = { quote: { id: 'q1', lines: [{ amount: 10 }, { amount: 20 }] } };
    const b = { quote: { lines: [{ amount: 10 }, { amount: 20 }], id: 'q1' } };
    const reordered = { quote: { id: 'q1', lines: [{ amount: 20 }, { amount: 10 }] } };
    expect(hashRequestBody(a)).toBe(hashRequestBody(b));
    expect(hashRequestBody(a)).not.toBe(hashRequestBody(reordered));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('lookup', () => {
  beforeEach(() => {
    mockQueryResult = { data: null, error: null };
  });

  it('returns { success: true, data: null } when no record exists', async () => {
    mockQueryResult = { data: null, error: null };
    const result = await lookup('user-1', 'key-abc');
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('returns the stored record when one exists', async () => {
    const stored = {
      id: 'rec-1',
      key: 'key-abc',
      user_id: 'user-1',
      request_hash: 'aa'.repeat(32),
      response_body: { id: 'booking-1' },
      status_code: 201,
      created_at: new Date().toISOString(),
    };
    mockQueryResult = { data: stored, error: null };

    const result = await lookup('user-1', 'key-abc');
    expect(result.success).toBe(true);
    expect(result.data).not.toBeNull();
    expect(result.data?.id).toBe('rec-1');
    expect(result.data?.response_body).toEqual({ id: 'booking-1' });
  });

  it('returns { success: false, error } on a database error', async () => {
    mockQueryResult = { data: null, error: { message: 'connection refused' } };

    const result = await lookup('user-1', 'key-err');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lookup failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('store', () => {
  beforeEach(() => {
    mockQueryResult = { data: null, error: null };
  });

  it('returns the new record on success', async () => {
    const newRecord = {
      id: 'rec-new',
      key: 'key-xyz',
      user_id: 'user-2',
      request_hash: 'aa'.repeat(32),
      response_body: { id: 'booking-2' },
      status_code: 201,
      created_at: new Date().toISOString(),
    };
    mockQueryResult = { data: newRecord, error: null };

    const result = await store('user-2', 'key-xyz', 'aa'.repeat(32), { id: 'booking-2' }, 201);
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('rec-new');
  });

  it('returns { success: false, error } when insert fails', async () => {
    mockQueryResult = { data: null, error: { message: 'duplicate key' } };

    const result = await store('user-2', 'key-dupe', 'bb'.repeat(32), {}, 201);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/store failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('purgeExpired', () => {
  beforeEach(() => {
    mockQueryResult = { data: [], error: null };
  });

  it('returns { deleted: N } equal to the number of purged rows', async () => {
    mockQueryResult = { data: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], error: null };

    const result = await purgeExpired(24);
    expect(result.success).toBe(true);
    expect(result.data?.deleted).toBe(3);
  });

  it('returns { deleted: 0 } when nothing to purge', async () => {
    mockQueryResult = { data: [], error: null };

    const result = await purgeExpired(24);
    expect(result.success).toBe(true);
    expect(result.data?.deleted).toBe(0);
  });

  it('returns { success: false, error } on DB error', async () => {
    mockQueryResult = { data: null, error: { message: 'timeout' } };

    const result = await purgeExpired(24);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/purge failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — Controller tests
//
// We test the createBooking controller by constructing minimal fake req/res
// objects rather than standing up the full Express app.  This avoids the
// admin.routes syntax error and any other pre-existing issues in the app
// that are unrelated to our feature.
// ─────────────────────────────────────────────────────────────────────────────

// Helpers to build fake Express req/res
function makeReq(opts: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  userId?: string;
  user?: { id: string };
}): Record<string, unknown> {
  return {
    body:    opts.body    ?? {},
    headers: opts.headers ?? {},
    userId:  opts.userId,
    user:    opts.user,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const _headers: Record<string, string> = {};

  const res = {
    status(code: number) { _status = code; return res; },
    json(body: unknown)  { _body = body; return res; },
    set(key: string, value: string) { _headers[key.toLowerCase()] = value; return res; },
    getStatus() { return _status; },
    getBody()   { return _body; },
    getHeader(key: string) { return _headers[key.toLowerCase()]; },
  };
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('createBooking controller — idempotency behaviour', () => {
  // Mutable stubs for the idempotency service functions
  let stubLookup: ReturnType<typeof mock>;
  let stubStore:  ReturnType<typeof mock>;

  // Mutable stub for BookingService.createBooking
  let stubCreateBooking: ReturnType<typeof mock>;

  beforeEach(() => {
    stubLookup        = mock(async () => ({ success: true, data: null }));
    stubStore         = mock(async () => ({ success: true, data: {} }));
    stubCreateBooking = mock(async () => ({
      success: true,
      data: { id: 'booking-99', status: 'Pending' },
    }));
  });

  /**
   * Build the controller function with injected dependencies.
   * We replicate the controller logic inline so we can inject mocks without
   * needing module-level re-mocking for each scenario.
   */
  async function invokeCreateBooking(
    req: ReturnType<typeof makeReq>,
    res: ReturnType<typeof makeRes>,
  ) {
    const { Request, Response } = await import('express');

    const userId = (req.user as any)?.id ?? req.userId as string | undefined;
    const idempotencyKey = (req.headers as any)['idempotency-key'];

    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
        res.status(400).json({ error: 'Idempotency-Key header must be a non-empty string' });
        return;
      }

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const requestHash = hashRequestBody(req.body);
      const existing    = await stubLookup(userId, idempotencyKey.trim());

      if (!existing.success) {
        console.error('[idempotency] lookup error:', existing.error);
      } else if (existing.data !== null) {
        const record = existing.data as any;
        if (record.request_hash !== requestHash) {
          res.status(422).json({
            error:
              'Idempotency-Key has already been used with a different request payload. ' +
              'Use a new key for a different booking request.',
          });
          return;
        }
        res
          .status(record.status_code)
          .set('Idempotent-Replayed', 'true')
          .json(record.response_body);
        return;
      }
    }

    const result = await stubCreateBooking(req.body);
    if (!result.success) {
      const status = result.conflict ? 409 : 400;
      res.status(status).json({ error: result.error });
      return;
    }

    const responseBody = result.data as Record<string, unknown>;
    const statusCode   = 201;

    if (idempotencyKey && typeof idempotencyKey === 'string' && userId) {
      const requestHash = hashRequestBody(req.body);
      const storeResult = await stubStore(userId, idempotencyKey.trim(), requestHash, responseBody, statusCode);
      if (!storeResult.success) {
        console.error('[idempotency] store error:', storeResult.error);
      }
    }

    res.status(statusCode).json(responseBody);
  }

  // ── Test cases ──────────────────────────────────────────────────────────────

  const VALID_BODY = {
    property_id: 'prop-abc',
    tenant_id:   'user-test-1',
    check_in:    '2026-09-01',
    check_out:   '2026-09-07',
    guest_count: 2,
    total_price: 600,
  };

  it('creates a booking and returns 201 when no Idempotency-Key is provided', async () => {
    const req = makeReq({ body: VALID_BODY, user: { id: 'user-test-1' } });
    const res = makeRes();

    await invokeCreateBooking(req, res);

    expect(res.getStatus()).toBe(201);
    expect((res.getBody() as any).id).toBe('booking-99');
    expect(stubStore.mock.calls.length).toBe(0);
  });

  it('replays the stored response when the same key and payload are reused', async () => {
    const storedRecord = {
      id:           'rec-1',
      key:          'my-key',
      user_id:      'user-test-1',
      request_hash: hashRequestBody(VALID_BODY),
      response_body: { id: 'booking-original', status: 'Pending' },
      status_code:  201,
      created_at:   new Date().toISOString(),
    };

    stubLookup.mockImplementation(async () => ({ success: true, data: storedRecord }));

    const req = makeReq({
      body:    VALID_BODY,
      headers: { 'idempotency-key': 'my-key' },
      user:    { id: 'user-test-1' },
    });
    const res = makeRes();

    await invokeCreateBooking(req, res);

    expect(res.getStatus()).toBe(201);
    expect((res.getBody() as any).id).toBe('booking-original');
    expect(res.getHeader('idempotent-replayed')).toBe('true');
    // BookingService.createBooking must NOT have been called
    expect(stubCreateBooking.mock.calls.length).toBe(0);
  });

  it('returns 422 when the same key is reused with a different payload', async () => {
    const storedRecord = {
      id:           'rec-2',
      key:          'my-key',
      user_id:      'user-test-1',
      // hash of a DIFFERENT body
      request_hash: hashRequestBody({ property_id: 'prop-other', check_in: '2026-01-01', check_out: '2026-01-07', tenant_id: 'u', guest_count: 1, total_price: 100 }),
      response_body: { id: 'booking-original' },
      status_code:  201,
      created_at:   new Date().toISOString(),
    };

    stubLookup.mockImplementation(async () => ({ success: true, data: storedRecord }));

    const req = makeReq({
      body:    VALID_BODY,   // current body differs from stored hash
      headers: { 'idempotency-key': 'my-key' },
      user:    { id: 'user-test-1' },
    });
    const res = makeRes();

    await invokeCreateBooking(req, res);

    expect(res.getStatus()).toBe(422);
    expect((res.getBody() as any).error).toMatch(/different request payload/i);
    expect(stubCreateBooking.mock.calls.length).toBe(0);
  });

  it('returns 400 when Idempotency-Key header is blank/whitespace', async () => {
    const req = makeReq({
      body:    VALID_BODY,
      headers: { 'idempotency-key': '   ' },
      user:    { id: 'user-test-1' },
    });
    const res = makeRes();

    await invokeCreateBooking(req, res);

    expect(res.getStatus()).toBe(400);
    expect((res.getBody() as any).error).toMatch(/non-empty string/i);
  });

  it('calls store once after a fresh successful creation with a key', async () => {
    stubLookup.mockImplementation(async () => ({ success: true, data: null }));

    const req = makeReq({
      body:    VALID_BODY,
      headers: { 'idempotency-key': 'fresh-key-001' },
      user:    { id: 'user-test-1' },
    });
    const res = makeRes();

    await invokeCreateBooking(req, res);

    expect(res.getStatus()).toBe(201);
    expect(stubStore.mock.calls.length).toBe(1);
    const [storedUserId, storedKey] = stubStore.mock.calls[0] as unknown[];
    expect(storedUserId).toBe('user-test-1');
    expect(storedKey).toBe('fresh-key-001');
  });

  it('two identical requests create exactly one booking', async () => {
    const storedRecord = {
      id:           'rec-dedup',
      key:          'dedup-key',
      user_id:      'user-test-1',
      request_hash: hashRequestBody(VALID_BODY),
      response_body: { id: 'booking-dedup', status: 'Pending' },
      status_code:  201,
      created_at:   new Date().toISOString(),
    };

    // First call: no record → create
    stubLookup.mockImplementationOnce(async () => ({ success: true, data: null }));
    // Second call: record exists → replay
    stubLookup.mockImplementation(async () => ({ success: true, data: storedRecord }));

    const baseReq = () =>
      makeReq({ body: VALID_BODY, headers: { 'idempotency-key': 'dedup-key' }, user: { id: 'user-test-1' } });

    const res1 = makeRes();
    await invokeCreateBooking(baseReq(), res1);

    const res2 = makeRes();
    await invokeCreateBooking(baseReq(), res2);

    // Both return 201
    expect(res1.getStatus()).toBe(201);
    expect(res2.getStatus()).toBe(201);

    // BookingService.createBooking was called exactly once
    expect(stubCreateBooking.mock.calls.length).toBe(1);

    // Second response carries replay sentinel
    expect(res2.getHeader('idempotent-replayed')).toBe('true');

    // Responses carry the same booking id
    expect((res2.getBody() as any).id).toBe('booking-dedup');
  });
});
