/**
 * Unit tests for the forward-only notification sync service (issue #646).
 *
 * The realtime reconnection back-fill depends on `getNotificationsSince`
 * walking *forward* in time from a client-supplied high-water mark. A
 * regression that flipped the ordering to DESC, or dropped the `since`
 * filter, would silently re-deliver the user's entire inbox on every
 * reconnect — so the query shape is asserted explicitly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted Supabase query-builder mock ──────────────────────────────────────

/**
 * A chainable builder: every filter/order/limit method returns the same
 * object, so the service's call order does not matter while each call stays
 * individually assertable. The object is thenable, standing in for the
 * awaited query result.
 */
const db = vi.hoisted(() => {
  const from = vi.fn();
  const select = vi.fn();
  const eq = vi.fn();
  const gt = vi.fn();
  const or = vi.fn();
  const order = vi.fn();
  const limit = vi.fn();

  // Every builder method returns the same chainable object.
  const builder: Record<string, unknown> = {
    from,
    select,
    eq,
    gt,
    or,
    order,
    limit,
  };
  for (const fn of [select, eq, gt, or, order, limit]) {
    fn.mockReturnValue(builder);
  }
  from.mockReturnValue(builder);

  let page: { data: unknown; error: unknown } = { data: [], error: null };
  // Stands in for Supabase's thenable query object, which the service awaits.
  const thenable = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(page));
  Object.defineProperty(builder, 'then', { value: thenable });

  return {
    from,
    select,
    eq,
    gt,
    or,
    order,
    limit,
    setPage: (next: { data: unknown; error: unknown }) => {
      page = next;
    },
  };
});

vi.mock('../config/supabase.js', () => ({ supabase: { from: db.from } }));
vi.mock('../services/email.service.js', () => ({ emailService: { sendEmail: vi.fn() } }));
vi.mock('../services/preferenceToken.js', () => ({ buildPreferenceUrlForUser: vi.fn() }));

import { getNotificationsSince } from '../services/notification.service.js';

const SINCE = '2024-06-01T10:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  db.setPage({ data: [], error: null });
});

// ─── Query shape ──────────────────────────────────────────────────────────────

describe('getNotificationsSince — query shape', () => {
  it('scopes the query to the authenticated user', async () => {
    await getNotificationsSince('user-1', SINCE);

    expect(db.from).toHaveBeenCalledWith('notifications');
    expect(db.eq).toHaveBeenCalledWith('user_id', 'user-1');
  });

  it('orders ascending so the client can replay oldest-first', async () => {
    await getNotificationsSince('user-1', SINCE);

    // ASC is the whole point: DESC would re-deliver the entire history.
    expect(db.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
    expect(db.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
  });

  it('filters strictly after the high-water mark', async () => {
    await getNotificationsSince('user-1', SINCE);

    expect(db.gt).toHaveBeenCalledWith('created_at', SINCE);
    expect(db.or).not.toHaveBeenCalled();
  });

  it('applies no time filter when no mark is supplied', async () => {
    await getNotificationsSince('user-1', null);

    expect(db.gt).not.toHaveBeenCalled();
    expect(db.or).not.toHaveBeenCalled();
  });

  it('prefers the cursor over the since mark when both are present', async () => {
    // Cursors are base64url-encoded { created_at, id } payloads.
    const cursor = Buffer.from(
      JSON.stringify({ created_at: '2024-06-01T11:00:00Z', id: 'mid-page' }),
      'utf8'
    ).toString('base64url');

    await getNotificationsSince('user-1', SINCE, cursor);

    // The cursor position is further along the same walk, so `since` must
    // NOT be re-applied — doing both would skip rows between the two marks.
    expect(db.gt).not.toHaveBeenCalled();
    expect(db.or).toHaveBeenCalledWith(
      'created_at.gt.2024-06-01T11:00:00Z,and(created_at.eq.2024-06-01T11:00:00Z,id.gt.mid-page)'
    );
  });

  it('falls back to the since mark when the cursor is malformed', async () => {
    await getNotificationsSince('user-1', SINCE, 'not-a-cursor');

    expect(db.gt).toHaveBeenCalledWith('created_at', SINCE);
    expect(db.or).not.toHaveBeenCalled();
  });

  it('fetches limit+1 rows to detect a further page', async () => {
    await getNotificationsSince('user-1', SINCE, null, 50);

    expect(db.limit).toHaveBeenCalledWith(51);
  });
});

// ─── Limit validation ─────────────────────────────────────────────────────────

describe('getNotificationsSince — limit validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects a non-integer limit (%s) before touching Supabase',
    async (limit) => {
      const result = await getNotificationsSince('user-1', null, null, limit as number);

      expect(result.success).toBe(false);
      expect(result.error).toBe('limit must be a finite integer');
      expect(db.from).not.toHaveBeenCalled();
    }
  );

  it('defaults to a page size of 50', async () => {
    await getNotificationsSince('user-1', null);

    expect(db.limit).toHaveBeenCalledWith(51);
  });

  it('clamps an oversized limit to 100', async () => {
    await getNotificationsSince('user-1', null, null, 5000);

    expect(db.limit).toHaveBeenCalledWith(101);
  });

  it('clamps a zero limit up to 1', async () => {
    await getNotificationsSince('user-1', null, null, 0);

    expect(db.limit).toHaveBeenCalledWith(2);
  });
});

// ─── Pagination envelope ──────────────────────────────────────────────────────

describe('getNotificationsSince — pagination envelope', () => {
  it('returns data and a nextCursor when more pages remain', async () => {
    db.setPage({
      data: [
        { id: 'n1', created_at: '2024-06-01T10:01:00Z' },
        { id: 'n2', created_at: '2024-06-01T10:02:00Z' },
      ],
      error: null,
    });

    // limit 1 with 2 rows back means a further page exists.
    const result = await getNotificationsSince('user-1', null, null, 1);

    expect(result.success).toBe(true);
    expect(result.data?.data).toHaveLength(1);
    expect(result.data?.nextCursor).toEqual(expect.any(String));
  });

  it('returns a null cursor when the page is the last one', async () => {
    db.setPage({ data: [{ id: 'n1', created_at: '2024-06-01T10:01:00Z' }], error: null });

    const result = await getNotificationsSince('user-1', SINCE);

    expect(result.success).toBe(true);
    expect(result.data?.nextCursor).toBeNull();
  });

  it('returns an empty page when there is nothing new', async () => {
    const result = await getNotificationsSince('user-1', SINCE);

    expect(result.success).toBe(true);
    expect(result.data?.data).toEqual([]);
    expect(result.data?.nextCursor).toBeNull();
  });

  it('treats a null data payload as an empty page', async () => {
    db.setPage({ data: null, error: null });

    const result = await getNotificationsSince('user-1', null);

    expect(result.success).toBe(true);
    expect(result.data?.data).toEqual([]);
  });

  it('surfaces query errors', async () => {
    db.setPage({ data: null, error: { message: 'boom' } });

    const result = await getNotificationsSince('user-1', null);

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});
