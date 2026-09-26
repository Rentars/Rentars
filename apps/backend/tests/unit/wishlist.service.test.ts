/**
 * Unit tests for wishlist service.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = mock((_: string) => ({}));
const mockSupabase = { from: mockFrom };

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as any).supabase = mockSupabase;

import {
  addToWishlist,
  removeFromWishlist,
  getWishlist,
} from '../../src/services/wishlist.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('wishlist.service', () => {
  beforeEach(() => {
    mockFrom.mockClear();
  });

  // ── addToWishlist ───────────────────────────────────────────────────────────

  describe('addToWishlist', () => {
    it('should add a property to wishlist', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(async () => ({ error: null })),
      }));

      const result = await addToWishlist('u1', 'p1');
      expect(result.success).toBe(true);
    });

    it('should succeed silently when property is already in wishlist (unique violation)', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(async () => ({ error: { code: '23505', message: 'Duplicate' } })),
      }));

      const result = await addToWishlist('u1', 'p1');
      expect(result.success).toBe(true);
    });

    it('should return error on other DB failure', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(async () => ({ error: { code: '42000', message: 'Syntax error' } })),
      }));

      const result = await addToWishlist('u1', 'p1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Syntax error');
    });

    it('rejects a whitespace-only property ID without issuing a DB query', async () => {
      const result = await addToWishlist('u1', '   ');
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID and property ID are required');
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only user ID without issuing a DB query', async () => {
      const result = await addToWishlist('  ', 'p1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID and property ID are required');
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace from valid IDs before inserting', async () => {
      let capturedPayload: unknown;
      mockFrom.mockImplementation(() => ({
        insert: mock(async (payload: unknown) => {
          capturedPayload = payload;
          return { error: null };
        }),
      }));

      const result = await addToWishlist('  u1  ', '  p1  ');
      expect(result.success).toBe(true);
      expect(capturedPayload).toEqual({ user_id: 'u1', property_id: 'p1' });
    });
  });

  // ── removeFromWishlist ──────────────────────────────────────────────────────

  describe('removeFromWishlist', () => {
    it('should remove a property from wishlist', async () => {
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ error: null, count: 1 })),
          })),
        })),
      }));

      const result = await removeFromWishlist('u1', 'p1');
      expect(result.success).toBe(true);
    });

    it('returns not-found when zero rows were deleted', async () => {
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ error: null, count: 0 })),
          })),
        })),
      }));

      const result = await removeFromWishlist('u1', 'p-not-in-list');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Item not found in wishlist');
    });

    it('treats a null count (older Supabase) as a successful deletion', async () => {
      // When PostgREST omits the count header the client returns null.
      // We should not reject those as not-found.
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ error: null, count: null })),
          })),
        })),
      }));

      const result = await removeFromWishlist('u1', 'p1');
      expect(result.success).toBe(true);
    });

    it('should return error on DB failure', async () => {
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ error: { message: 'Delete failed' }, count: null })),
          })),
        })),
      }));

      const result = await removeFromWishlist('u1', 'p1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Delete failed');
    });
  });

  // ── getWishlist ─────────────────────────────────────────────────────────────

  describe('getWishlist', () => {
    it('should return wishlist items with joined property data', async () => {
      const items = [
        { property_id: 'p1', created_at: '2026-01-01', properties: { title: 'Beach House' } },
        { property_id: 'p2', created_at: '2026-01-02', properties: { title: 'City Loft' } },
      ];

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: items, error: null })),
          })),
        })),
      }));

      const result = await getWishlist('u1');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
    });

    it('should return empty array when wishlist is empty', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: null, error: null })),
          })),
        })),
      }));

      const result = await getWishlist('u1');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should return error on DB failure', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: null, error: { message: 'DB timeout' } })),
          })),
        })),
      }));

      const result = await getWishlist('u1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB timeout');
    });
  });
});
