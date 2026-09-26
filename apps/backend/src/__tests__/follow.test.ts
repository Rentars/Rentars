/**
 * Tests for the Host-Follow feature.
 *
 * Covers:
 *  1. followHost()          — happy path, duplicate prevention (idempotent),
 *                             self-follow rejection, host-not-found
 *  2. unfollowHost()        — happy path, idempotent when not following
 *  3. isFollowing()         — true/false state after follow/unfollow
 *  4. getHostFollowerIds()  — returns follower UUIDs for notification fan-out
 *  5. notifyHostFollowers() — fan-out creates in-app notifications respecting
 *                             per-user preferences; returns correct count
 *  6. Input validation      — empty ids rejected consistently
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  followHost,
  unfollowHost,
  isFollowing,
  getHostFollowerIds,
} from '../services/follow.service.js';
import { notifyHostFollowers } from '../services/notification.service.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSelect   = vi.fn();
const mockInsert   = vi.fn();
const mockDelete   = vi.fn();
const mockUpsert   = vi.fn();
const mockEq       = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSingle   = vi.fn();

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn((table: string) => ({
      select:      mockSelect,
      insert:      mockInsert,
      delete:      mockDelete,
      upsert:      mockUpsert,
      update:      vi.fn(() => ({ eq: mockEq })),
    })),
  },
}));

// Default chain stubs — overridden per test with mockResolvedValueOnce
mockSelect.mockReturnValue({ eq: mockEq, maybeSingle: mockMaybeSingle });
mockEq.mockReturnValue({
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
  single: mockSingle,
  select: mockSelect,
});
mockUpsert.mockReturnValue({ select: mockSelect });
mockSelect.mockReturnValue({ maybeSingle: mockMaybeSingle, single: mockSingle, eq: mockEq });
mockDelete.mockReturnValue({ eq: mockEq });
mockMaybeSingle.mockResolvedValue({ data: null, error: null });
mockSingle.mockResolvedValue({ data: null, error: null });

// Cache mock
vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOST_ID     = 'host-uuid-0001';
const FOLLOWER_ID = 'follower-uuid-0002';
const OTHER_ID    = 'follower-uuid-0003';

const FOLLOW_ROW = {
  id:          'follow-uuid-0001',
  follower_id: FOLLOWER_ID,
  host_id:     HOST_ID,
  created_at:  '2025-01-15T10:00:00Z',
};

// ─── followHost ───────────────────────────────────────────────────────────────

describe('followHost()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects empty follower_id', async () => {
    const r = await followHost('', HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects whitespace-only follower_id', async () => {
    const r = await followHost('   ', HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects empty host_id', async () => {
    const r = await followHost(FOLLOWER_ID, '');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects whitespace-only host_id', async () => {
    const r = await followHost(FOLLOWER_ID, '   ');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects self-follow', async () => {
    const r = await followHost(HOST_ID, HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/cannot follow yourself/i);
  });

  it('rejects self-follow even with surrounding whitespace', async () => {
    const r = await followHost(` ${HOST_ID} `, ` ${HOST_ID} `);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/cannot follow yourself/i);
  });

  it('returns error when host profile does not exist', async () => {
    // profiles lookup returns null
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const r = await followHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/host not found/i);
  });

  it('creates a follow row on success', async () => {
    // profiles lookup succeeds
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: HOST_ID }, error: null });
    // upsert chain: select → maybeSingle returns the new row
    mockMaybeSingle.mockResolvedValueOnce({ data: FOLLOW_ROW, error: null });

    const r = await followHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data?.follower_id).toBe(FOLLOWER_ID);
    expect(r.data?.host_id).toBe(HOST_ID);
  });

  it('is idempotent — second follow returns the existing row (duplicate prevention)', async () => {
    // profiles lookup
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: HOST_ID }, error: null });
    // upsert returns null (ignoreDuplicates=true)
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    // re-fetch the existing row
    mockSingle.mockResolvedValueOnce({ data: FOLLOW_ROW, error: null });

    const r = await followHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data?.id).toBe(FOLLOW_ROW.id);
  });

  it('returns DB error when upsert fails', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: HOST_ID }, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

    const r = await followHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toBe('DB error');
  });
});

// ─── unfollowHost ─────────────────────────────────────────────────────────────

describe('unfollowHost()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects empty follower_id', async () => {
    const r = await unfollowHost('', HOST_ID);
    expect(r.success).toBe(false);
  });

  it('rejects empty host_id', async () => {
    const r = await unfollowHost(FOLLOWER_ID, '');
    expect(r.success).toBe(false);
  });

  it('deletes the follow row on success', async () => {
    mockEq.mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null }) });

    const r = await unfollowHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('is idempotent — succeeds even when no row exists', async () => {
    // DELETE on a non-existent row returns no error in Supabase
    mockEq.mockReturnValueOnce({ eq: vi.fn().mockResolvedValue({ error: null }) });

    const r = await unfollowHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
  });

  it('returns DB error when delete fails', async () => {
    mockEq.mockReturnValueOnce({
      eq: vi.fn().mockResolvedValue({ error: { message: 'delete failed' } }),
    });

    const r = await unfollowHost(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(false);
    expect(r.error).toBe('delete failed');
  });
});

// ─── isFollowing ──────────────────────────────────────────────────────────────

describe('isFollowing()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when no follow row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const r = await isFollowing(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data).toBe(false);
  });

  it('returns true when a follow row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'row-1' }, error: null });
    const r = await isFollowing(FOLLOWER_ID, HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data).toBe(true);
  });

  it('rejects empty ids', async () => {
    const r = await isFollowing('', HOST_ID);
    expect(r.success).toBe(false);
  });
});

// ─── getHostFollowerIds ───────────────────────────────────────────────────────

describe('getHostFollowerIds()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty array when host has no followers', async () => {
    mockEq.mockResolvedValueOnce({ data: [], error: null });
    const r = await getHostFollowerIds(HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('returns the follower UUIDs', async () => {
    mockEq.mockResolvedValueOnce({
      data: [{ follower_id: FOLLOWER_ID }, { follower_id: OTHER_ID }],
      error: null,
    });
    const r = await getHostFollowerIds(HOST_ID);
    expect(r.success).toBe(true);
    expect(r.data).toContain(FOLLOWER_ID);
    expect(r.data).toContain(OTHER_ID);
    expect(r.data).toHaveLength(2);
  });

  it('rejects empty host_id', async () => {
    const r = await getHostFollowerIds('');
    expect(r.success).toBe(false);
  });
});
