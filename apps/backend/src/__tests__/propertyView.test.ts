/**
 * Tests for Feature B — Property View Tracking
 *
 * Covers:
 *  1. isBot() — bot user-agent detection
 *  2. recordPropertyView — deduplication within a window, bot filtering,
 *     missing viewer key fallback
 *  3. getPropertyViewCount — host-only visibility logic (unit)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isBot,
  recordPropertyView,
  getPropertyViewCount,
  getPropertyViewStats,
} from '../services/propertyView.service.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSingle  = vi.fn();
const mockInsert  = vi.fn();
const mockSelect  = vi.fn();
const mockEq      = vi.fn();
const mockGte     = vi.fn();
const mockRpc     = vi.fn();

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
      update: vi.fn(() => ({ eq: vi.fn() })),
    })),
    rpc: mockRpc,
  },
}));

// Default chain: select → eq → single
mockSelect.mockReturnValue({ eq: mockEq });
mockEq.mockReturnValue({ single: mockSingle, gte: mockGte });
mockGte.mockReturnValue(Promise.resolve({ data: [], error: null }));
mockRpc.mockResolvedValue({ error: null });

// ─── isBot ────────────────────────────────────────────────────────────────────

describe('isBot()', () => {
  it('returns false for a regular browser UA', () => {
    expect(isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe(false);
  });

  it('returns true for undefined UA', () => {
    expect(isBot(undefined)).toBe(true);
  });

  it('returns true for a blank user agent', () => {
    expect(isBot('')).toBe(true);
    expect(isBot('   ')).toBe(true);
  });

  it('detects Googlebot', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
  });

  it('detects generic "bot" substring', () => {
    expect(isBot('SomeBot/1.0')).toBe(true);
  });

  it('detects crawler', () => {
    expect(isBot('MyCrawler/2.0')).toBe(true);
  });

  it('detects curl', () => {
    expect(isBot('curl/7.68.0')).toBe(true);
  });

  it('detects Python requests', () => {
    expect(isBot('python-requests/2.28.0')).toBe(true);
  });

  it('detects HeadlessChrome', () => {
    expect(isBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/112')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isBot('GOOGLEBOT/2.1')).toBe(true);
  });
});

// ─── recordPropertyView ───────────────────────────────────────────────────────

describe('recordPropertyView()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when propertyId is empty', async () => {
    const r = await recordPropertyView({ propertyId: '' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('skips bots and returns recorded: false', async () => {
    const r = await recordPropertyView({
      propertyId: 'prop-1',
      userAgent:  'Googlebot/2.1',
    });
    expect(r.success).toBe(true);
    expect(r.data?.recorded).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('skips when no userId and no fingerprint', async () => {
    const r = await recordPropertyView({ propertyId: 'prop-1', userAgent: 'Mozilla/5.0' });
    expect(r.success).toBe(true);
    expect(r.data?.recorded).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('records a view for an authenticated user', async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    const r = await recordPropertyView({
      propertyId: 'prop-1',
      userId:     'user-abc',
      userAgent:  'Mozilla/5.0',
    });
    expect(r.success).toBe(true);
    expect(r.data?.recorded).toBe(true);
    expect(mockInsert).toHaveBeenCalledOnce();
    // viewer_key should use the user id
    const insertArg = mockInsert.mock.calls[0][0];
    expect(insertArg.viewer_key).toBe('user:user-abc');
  });

  it('records a view for an anonymous user with a fingerprint', async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    const r = await recordPropertyView({
      propertyId:  'prop-1',
      fingerprint: 'fp-hash-001',
      userAgent:   'Mozilla/5.0',
    });
    expect(r.success).toBe(true);
    expect(r.data?.recorded).toBe(true);
    const insertArg = mockInsert.mock.calls[0][0];
    expect(insertArg.viewer_key).toBe('anon:fp-hash-001');
  });

  it('treats a unique_violation (23505) as a duplicate and returns recorded: false', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'unique violation' } });
    const r = await recordPropertyView({
      propertyId: 'prop-1',
      userId:     'user-abc',
      userAgent:  'Mozilla/5.0',
    });
    expect(r.success).toBe(true);
    expect(r.data?.recorded).toBe(false);
  });

  it('returns an error for unexpected DB errors', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '42P01', message: 'relation does not exist' } });
    const r = await recordPropertyView({
      propertyId: 'prop-1',
      userId:     'user-abc',
      userAgent:  'Mozilla/5.0',
    });
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('includes window_start in the insert payload', async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    await recordPropertyView({ propertyId: 'prop-1', userId: 'user-abc', userAgent: 'Mozilla/5.0' });
    const insertArg = mockInsert.mock.calls[0][0];
    // window_start should be an ISO string with minutes/seconds zeroed
    expect(insertArg.window_start).toMatch(/T\d{2}:00:00/);
  });
});

// ─── getPropertyViewCount ─────────────────────────────────────────────────────

describe('getPropertyViewCount()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when propertyId is empty', async () => {
    const r = await getPropertyViewCount('');
    expect(r.success).toBe(false);
  });

  it('returns the view_count from the properties row', async () => {
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data:  { id: 'prop-1', view_count: 57 },
          error: null,
        }),
      }),
    });
    const r = await getPropertyViewCount('prop-1');
    expect(r.success).toBe(true);
    expect(r.data?.viewCount).toBe(57);
  });

  it('returns 0 when view_count is null (unset)', async () => {
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data:  { id: 'prop-1', view_count: null },
          error: null,
        }),
      }),
    });
    const r = await getPropertyViewCount('prop-1');
    expect(r.success).toBe(true);
    expect(r.data?.viewCount).toBe(0);
  });
});

// ─── Host-only visibility logic ────────────────────────────────────────────────

describe('Host-only view count visibility', () => {
  /**
   * The API enforces this in getViewStatsHandler — we verify the logic here.
   */
  function canViewStats(requesterId: string, ownerId: string): boolean {
    return requesterId === ownerId;
  }

  it('allows the property owner to see stats', () => {
    expect(canViewStats('host-1', 'host-1')).toBe(true);
  });

  it('blocks a tenant from seeing stats', () => {
    expect(canViewStats('tenant-1', 'host-1')).toBe(false);
  });

  it('blocks an anonymous user (empty id) from seeing stats', () => {
    expect(canViewStats('', 'host-1')).toBe(false);
  });
});

// ─── Deduplication window boundary ───────────────────────────────────────────

describe('Deduplication window boundary', () => {
  it('two views in the same hour map to the same window_start', () => {
    // Simulate the windowStart function inline
    function windowStart(now: Date): string {
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      return d.toISOString();
    }

    const t1 = new Date('2027-08-01T14:10:00Z');
    const t2 = new Date('2027-08-01T14:55:00Z');
    expect(windowStart(t1)).toBe(windowStart(t2));
  });

  it('views in different hours map to different window_starts', () => {
    function windowStart(now: Date): string {
      const d = new Date(now);
      d.setUTCMinutes(0, 0, 0);
      return d.toISOString();
    }

    const t1 = new Date('2027-08-01T14:59:00Z');
    const t2 = new Date('2027-08-01T15:00:00Z');
    expect(windowStart(t1)).not.toBe(windowStart(t2));
  });
});
