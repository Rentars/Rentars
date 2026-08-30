/**
 * Tests for cache.service — focused on invalidatePattern.
 *
 * Covers:
 *  1. No-key scans (null / undefined / empty array) resolve without
 *     calling DEL — previously a missing scan result could throw.
 *  2. Real matching keys are still deleted.
 *  3. Redis client errors retain the existing silent no-op behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invalidatePattern } from '../services/cache.service.js';

// ─── Redis mock ───────────────────────────────────────────────────────────────

const mockKeys = vi.fn();
const mockDel  = vi.fn();
const mockPing = vi.fn().mockResolvedValue('PONG');

vi.mock('../config/redis.js', () => ({
  connectRedis: vi.fn().mockResolvedValue(undefined),
  redisClient: {
    ping: mockPing,
    keys: mockKeys,
    del:  mockDel,
  },
}));

// ─── invalidatePattern ────────────────────────────────────────────────────────

describe('invalidatePattern()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDel.mockResolvedValue(0);
  });

  // ── No-key / empty-result cases ──────────────────────────────────────────

  it('resolves without calling DEL when keys() returns an empty array', async () => {
    mockKeys.mockResolvedValueOnce([]);
    await expect(invalidatePattern('missing:*')).resolves.toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('resolves without calling DEL when keys() returns null', async () => {
    mockKeys.mockResolvedValueOnce(null);
    await expect(invalidatePattern('missing:*')).resolves.toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('resolves without calling DEL when keys() returns undefined', async () => {
    mockKeys.mockResolvedValueOnce(undefined);
    await expect(invalidatePattern('missing:*')).resolves.toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
  });

  // ── Real-key deletion ────────────────────────────────────────────────────

  it('calls DEL with the matching keys when scan returns results', async () => {
    const matchingKeys = ['property:1', 'property:2', 'property:3'];
    mockKeys.mockResolvedValueOnce(matchingKeys);
    await invalidatePattern('property:*');
    expect(mockDel).toHaveBeenCalledOnce();
    expect(mockDel).toHaveBeenCalledWith(matchingKeys);
  });

  it('calls DEL with a single matching key', async () => {
    mockKeys.mockResolvedValueOnce(['session:abc']);
    await invalidatePattern('session:*');
    expect(mockDel).toHaveBeenCalledWith(['session:abc']);
  });

  it('does not call DEL for an unrelated pattern that matches nothing', async () => {
    mockKeys.mockResolvedValueOnce([]);
    await invalidatePattern('nonexistent:*');
    expect(mockDel).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('resolves (no throw) when keys() rejects — Redis error is swallowed', async () => {
    mockKeys.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(invalidatePattern('any:*')).resolves.toBeUndefined();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it('resolves (no throw) when DEL rejects — Redis error is swallowed', async () => {
    mockKeys.mockResolvedValueOnce(['key:1']);
    mockDel.mockRejectedValueOnce(new Error('write error'));
    await expect(invalidatePattern('key:*')).resolves.toBeUndefined();
  });
});
