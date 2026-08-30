/**
 * Unit tests for push notification service.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockSingleFn = mock(async () => ({ data: null, error: null }));
const mockFrom = mock((_: string) => ({
  upsert: mock(() => ({ select: mock(() => ({ single: mockSingleFn })) })),
  select: mock(() => ({
    eq: mock(async () => ({ data: null, error: null })),
  })),
  delete: mock(() => ({
    eq: mock(() => ({
      eq: mock(async () => ({ data: null, error: null })),
    })),
  })),
}));

const mockSupabase = { from: mockFrom };
const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as unknown as Record<string, unknown>).supabase = mockSupabase;

import {
  type PushSubscription,
  getUserPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
  sendPushToUser,
  validatePushSubscription,
} from '../../src/services/push.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('push.service', () => {
  const mockSubscription: PushSubscription = {
    endpoint: 'https://push.example.com/subscription/abc',
    keys: {
      p256dh: 'base64-p256dh-key',
      auth: 'base64-auth-secret',
    },
  };

  beforeEach(() => {
    mockFrom.mockClear();
    mockSingleFn.mockClear();
    process.env.VAPID_PUBLIC_KEY = undefined;
    process.env.VAPID_PRIVATE_KEY = undefined;
  });

  // ── savePushSubscription ────────────────────────────────────────────────────

  describe('savePushSubscription', () => {
    it('should save a push subscription successfully', async () => {
      const stored = {
        id: 'sub-1',
        user_id: 'u1',
        endpoint: mockSubscription.endpoint,
        p256dh: mockSubscription.keys.p256dh,
        auth: mockSubscription.keys.auth,
      };

      mockFrom.mockImplementation((_: string) => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: stored, error: null })),
          })),
        })),
      }));

      const result = await savePushSubscription('u1', mockSubscription);
      expect(result.success).toBe(true);
      expect(result.data?.endpoint).toBe(mockSubscription.endpoint);
    });

    it('should return error when upsert fails', async () => {
      mockFrom.mockImplementation((_: string) => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'DB error' } })),
          })),
        })),
      }));

      const result = await savePushSubscription('u1', mockSubscription);
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  // ── getUserPushSubscriptions ────────────────────────────────────────────────

  describe('getUserPushSubscriptions', () => {
    it('should return user subscriptions', async () => {
      const subs = [
        {
          id: 's1',
          user_id: 'u1',
          endpoint: 'https://push.example.com/1',
          p256dh: 'k1',
          auth: 'a1',
        },
      ];

      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({ data: subs, error: null })),
        })),
      }));

      const result = await getUserPushSubscriptions('u1');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should return empty array when no subscriptions', async () => {
      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({ data: null, error: null })),
        })),
      }));

      const result = await getUserPushSubscriptions('u1');
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should return error on DB failure', async () => {
      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({ data: null, error: { message: 'Connection error' } })),
        })),
      }));

      const result = await getUserPushSubscriptions('u1');
      expect(result.success).toBe(false);
    });
  });

  // ── removePushSubscription ──────────────────────────────────────────────────

  describe('removePushSubscription', () => {
    it('should remove subscription successfully', async () => {
      mockFrom.mockImplementation((_: string) => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ data: null, error: null })),
          })),
        })),
      }));

      const result = await removePushSubscription('u1', mockSubscription.endpoint);
      expect(result.success).toBe(true);
    });

    it('should return error when delete fails', async () => {
      mockFrom.mockImplementation((_: string) => ({
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ data: null, error: { message: 'Delete failed' } })),
          })),
        })),
      }));

      const result = await removePushSubscription('u1', mockSubscription.endpoint);
      expect(result.success).toBe(false);
    });
  });

  // ── sendPushToUser ──────────────────────────────────────────────────────────

  describe('sendPushToUser', () => {
    it('should skip send when VAPID keys are not configured', async () => {
      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({
            data: [
              {
                id: 's1',
                user_id: 'u1',
                endpoint: 'https://push.example.com/1',
                p256dh: 'k1',
                auth: 'a1',
              },
            ],
            error: null,
          })),
        })),
      }));

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
    });

    it('should return 0 when user has no subscriptions', async () => {
      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({ data: [], error: null })),
        })),
      }));

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });
      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
    });

    it('should return error when subscription fetch fails', async () => {
      mockFrom.mockImplementation((_: string) => ({
        select: mock(() => ({
          eq: mock(async () => ({ data: null, error: { message: 'DB error' } })),
        })),
      }));

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });
      expect(result.success).toBe(false);
    });
  });

  // ── validatePushSubscription ────────────────────────────────────────────

  describe('validatePushSubscription', () => {
    it('should accept a valid HTTPS subscription', () => {
      const result = validatePushSubscription(mockSubscription);
      expect(result).toBeNull();
    });

    it('should reject a subscription with blank endpoint', () => {
      const result = validatePushSubscription({
        endpoint: '   ',
        keys: {
          p256dh: 'base64-p256dh-key',
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('endpoint cannot be blank');
    });

    it('should reject a subscription with HTTP endpoint', () => {
      const result = validatePushSubscription({
        endpoint: 'http://push.example.com/subscription/abc',
        keys: {
          p256dh: 'base64-p256dh-key',
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('endpoint must use HTTPS protocol');
    });

    it('should reject a subscription with missing endpoint', () => {
      const result = validatePushSubscription({
        keys: {
          p256dh: 'base64-p256dh-key',
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('endpoint is required and must be a string');
    });

    it('should reject a subscription with empty string endpoint', () => {
      const result = validatePushSubscription({
        endpoint: '',
        keys: {
          p256dh: 'base64-p256dh-key',
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('endpoint is required and must be a string');
    });

    it('should reject a subscription with non-URL endpoint string', () => {
      const result = validatePushSubscription({
        endpoint: 'not-a-url',
        keys: {
          p256dh: 'base64-p256dh-key',
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('endpoint must be a valid HTTPS URL');
    });

    it('should reject a subscription with missing keys', () => {
      const result = validatePushSubscription({
        endpoint: 'https://push.example.com/subscription/abc',
      });
      expect(result).toBe('keys object is required');
    });

    it('should reject a subscription with missing p256dh key', () => {
      const result = validatePushSubscription({
        endpoint: 'https://push.example.com/subscription/abc',
        keys: {
          auth: 'base64-auth-secret',
        },
      });
      expect(result).toBe('keys.p256dh is required and must be a string');
    });

    it('should reject a subscription with missing auth key', () => {
      const result = validatePushSubscription({
        endpoint: 'https://push.example.com/subscription/abc',
        keys: {
          p256dh: 'base64-p256dh-key',
        },
      });
      expect(result).toBe('keys.auth is required and must be a string');
    });
  });
});
