/**
 * Unit tests for cache.service.ts
 *
 * The Redis client is fully mocked so no real Redis connection is needed.
 * Tests cover the four changed behaviours:
 *   1. get() returns cached falsy values (false, 0, "") instead of null
 *   2. get() still returns null for a missing key (Redis returns null)
 *   3. set() throws for invalid TTLs before touching Redis
 *   4. set() calls Redis normally for a valid TTL
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─── Mock Redis module before importing cache service ────────────────────────

const mockGet = mock(async (_key: string): Promise<string | null> => null);
const mockSet = mock(async (..._args: unknown[]): Promise<void> => {});
const mockDel = mock(async (..._args: unknown[]): Promise<void> => {});
const mockKeys = mock(async (_pattern: string): Promise<string[]> => []);

mock.module('../../src/config/redis.js', () => ({
  connectRedis: mock(async () => {}),
  redisClient: {
    get: mockGet,
    set: mockSet,
    del: mockDel,
    keys: mockKeys,
  },
}));

// Import AFTER mocking so the module picks up the mock client
const { get, set } = await import('../../src/services/cache.service.js');

// ─── get() — falsy value round-trips ─────────────────────────────────────────

describe('cache.get — falsy value round-trips', () => {
  beforeEach(() => {
    mockGet.mockClear();
    mockSet.mockClear();
  });

  it('returns false when Redis holds the serialised value "false"', async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify(false));
    const result = await get<boolean>('key:bool');
    expect(result).toBe(false);
  });

  it('returns 0 when Redis holds the serialised value "0"', async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify(0));
    const result = await get<number>('key:zero');
    expect(result).toBe(0);
  });

  it('returns an empty string when Redis holds the serialised value ""', async () => {
    mockGet.mockResolvedValueOnce(JSON.stringify(''));
    const result = await get<string>('key:empty');
    expect(result).toBe('');
  });

  it('returns null when the key is missing (Redis returns null)', async () => {
    mockGet.mockResolvedValueOnce(null);
    const result = await get('key:missing');
    expect(result).toBeNull();
  });

  it('returns a truthy object normally', async () => {
    const obj = { label: 'Berlin, Germany' };
    mockGet.mockResolvedValueOnce(JSON.stringify(obj));
    const result = await get<typeof obj>('key:obj');
    expect(result).toEqual(obj);
  });
});

// ─── set() — TTL validation ───────────────────────────────────────────────────

describe('cache.set — TTL validation', () => {
  beforeEach(() => {
    mockSet.mockClear();
  });

  // Invalid TTLs — Redis must NOT be called

  it('throws for TTL = 0', async () => {
    await expect(set('k', 'v', 0)).rejects.toThrow(/finite positive integer/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('throws for a negative TTL', async () => {
    await expect(set('k', 'v', -1)).rejects.toThrow(/finite positive integer/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('throws for a fractional TTL', async () => {
    await expect(set('k', 'v', 1.5)).rejects.toThrow(/finite positive integer/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('throws for Infinity', async () => {
    await expect(set('k', 'v', Infinity)).rejects.toThrow(/finite positive integer/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('throws for NaN', async () => {
    await expect(set('k', 'v', NaN)).rejects.toThrow(/finite positive integer/i);
    expect(mockSet).not.toHaveBeenCalled();
  });

  // Valid TTL — Redis IS called and existing behaviour is preserved

  it('calls Redis with EX for a valid positive integer TTL', async () => {
    await set('key:ttl', { foo: 'bar' }, 60);
    expect(mockSet).toHaveBeenCalledTimes(1);
    // Confirm the EX option is forwarded
    const [passedKey, passedValue, passedOpts] = mockSet.mock.calls[0] as [string, string, { EX: number }];
    expect(passedKey).toBe('key:ttl');
    expect(JSON.parse(passedValue)).toEqual({ foo: 'bar' });
    expect(passedOpts).toEqual({ EX: 60 });
  });
});
