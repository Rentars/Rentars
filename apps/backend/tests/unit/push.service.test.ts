/**
 * Unit tests for push notification service.
 */

import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

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
  getActivePushSubscriptions,
  getPushSubscriptionStatus,
  getTransientPushFailureCount,
  getUserPushSubscriptions,
  removeAllPushSubscriptions,
  removePushSubscription,
  replacePushSubscription,
  resetTransientPushFailures,
  savePushSubscription,
  sendPushToUser,
  validatePushSubscription,
} from '../../src/services/push.service.js';
import { decryptPushKey, isEncryptedPushKey } from '../../src/services/push-crypto.js';

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

    it('should remove subscription on 404 response', async () => {
      const endpoint = 'https://push.example.com/1';
      const deleteCalls: Array<{ endpoint: string; userId: string }> = [];

      mockFrom.mockImplementation((table: string) => {
        if (table === 'push_subscriptions') {
          return {
            select: mock(() => ({
              eq: mock(async () => ({
                data: [
                  {
                    id: 's1',
                    user_id: 'u1',
                    endpoint,
                    p256dh: 'k1',
                    auth: 'a1',
                  },
                ],
                error: null,
              })),
            })),
            delete: mock(() => ({
              eq: mock((field: string, value: string) => ({
                eq: mock(async (field2: string, value2: string) => {
                  if (field === 'user_id' && field2 === 'endpoint') {
                    deleteCalls.push({ userId: value, endpoint: value2 });
                  }
                  return { data: null, error: null };
                }),
              })),
            })),
          };
        }
        return { select: mock(), delete: mock() };
      });

      process.env.VAPID_PUBLIC_KEY = 'mock-public-key';
      process.env.VAPID_PRIVATE_KEY = 'mock-private-key';

      // Mock fetch to return 404
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        status: 404,
        ok: false,
      })) as unknown as typeof fetch;

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });

      globalThis.fetch = originalFetch;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0]).toEqual({ userId: 'u1', endpoint });
    });

    it('should remove subscription on 410 response', async () => {
      const endpoint = 'https://push.example.com/1';
      const deleteCalls: Array<{ endpoint: string; userId: string }> = [];

      mockFrom.mockImplementation((table: string) => {
        if (table === 'push_subscriptions') {
          return {
            select: mock(() => ({
              eq: mock(async () => ({
                data: [
                  {
                    id: 's1',
                    user_id: 'u1',
                    endpoint,
                    p256dh: 'k1',
                    auth: 'a1',
                  },
                ],
                error: null,
              })),
            })),
            delete: mock(() => ({
              eq: mock((field: string, value: string) => ({
                eq: mock(async (field2: string, value2: string) => {
                  if (field === 'user_id' && field2 === 'endpoint') {
                    deleteCalls.push({ userId: value, endpoint: value2 });
                  }
                  return { data: null, error: null };
                }),
              })),
            })),
          };
        }
        return { select: mock(), delete: mock() };
      });

      process.env.VAPID_PUBLIC_KEY = 'mock-public-key';
      process.env.VAPID_PRIVATE_KEY = 'mock-private-key';

      // Mock fetch to return 410
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        status: 410,
        ok: false,
      })) as unknown as typeof fetch;

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });

      globalThis.fetch = originalFetch;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0]).toEqual({ userId: 'u1', endpoint });
    });

    it('should not remove subscription on transient errors (e.g., 503)', async () => {
      const endpoint = 'https://push.example.com/1';
      const deleteCalls: Array<{ endpoint: string; userId: string }> = [];

      mockFrom.mockImplementation((table: string) => {
        if (table === 'push_subscriptions') {
          return {
            select: mock(() => ({
              eq: mock(async () => ({
                data: [
                  {
                    id: 's1',
                    user_id: 'u1',
                    endpoint,
                    p256dh: 'k1',
                    auth: 'a1',
                  },
                ],
                error: null,
              })),
            })),
            delete: mock(() => ({
              eq: mock((field: string, value: string) => ({
                eq: mock(async (field2: string, value2: string) => {
                  if (field === 'user_id' && field2 === 'endpoint') {
                    deleteCalls.push({ userId: value, endpoint: value2 });
                  }
                  return { data: null, error: null };
                }),
              })),
            })),
          };
        }
        return { select: mock(), delete: mock() };
      });

      process.env.VAPID_PUBLIC_KEY = 'mock-public-key';
      process.env.VAPID_PRIVATE_KEY = 'mock-private-key';

      // Mock fetch to return 503
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => ({
        status: 503,
        ok: false,
      })) as unknown as typeof fetch;

      const result = await sendPushToUser('u1', { title: 'Test', body: 'Hello' });

      globalThis.fetch = originalFetch;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
      expect(deleteCalls.length).toBe(0);
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


// ── Subscription lifecycle (issue 074) ────────────────────────────────────────
//
// These cases cover the lifecycle work: ownership transfer, replacement,
// removal, permission/status reporting, automatic retirement of endpoints the
// push service rejects, and payload hardening.

/**
 * Supabase returns a thenable that also exposes `.maybeSingle()`; a plain
 * `async` mock cannot express that, so the preference lookup needs a real
 * thenable object.
 */
const chainable = <T>(result: T) =>
  ({
    then: (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => result,
  }) as PromiseLike<T> & { maybeSingle: () => Promise<T> };

const OK = { data: null, error: null };

const PREFERENCES_TABLE = {
  select: mock(() => ({ eq: mock(() => chainable(OK)) })),
};

interface SubscriptionTableOptions {
  rows?: unknown[];
  onDelete?: (fields: Array<[string, string]>) => void;
}

const subscriptionTable = ({ rows = [], onDelete }: SubscriptionTableOptions = {}) => ({
  select: mock(() => ({ eq: mock(async () => ({ data: rows, error: null })) })),
  delete: mock(() => ({
    eq: mock((field: string, value: string) => ({
      eq: mock(async (field2: string, value2: string) => {
        onDelete?.([
          [field, value],
          [field2, value2],
        ]);
        return { data: null, error: null };
      }),
    })),
  })),
});

/** A real P-256 key so the VAPID token can actually be signed. */
function vapidPrivateKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('push subscription lifecycle', () => {
  const subscription: PushSubscription = {
    endpoint: 'https://push.example.com/subscription/abc',
    keys: { p256dh: 'base64-p256dh-key', auth: 'base64-auth-secret' },
  };

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockFrom.mockClear();
    resetTransientPushFailures();
    delete process.env.PUSH_KEY_ENCRYPTION_SECRET;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
  });

  afterEach(() => {
    resetTransientPushFailures();
    delete process.env.PUSH_KEY_ENCRYPTION_SECRET;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    globalThis.fetch = originalFetch;
  });

  describe('registration', () => {
    it('upserts on the endpoint so a device transfers to the account using it', async () => {
      let payload: Record<string, unknown> | null = null;
      let options: Record<string, unknown> | null = null;

      mockFrom.mockImplementation(() => ({
        upsert: mock((values: Record<string, unknown>, upsertOptions: Record<string, unknown>) => {
          payload = values;
          options = upsertOptions;
          return {
            select: mock(() => ({
              single: mock(async () => ({
                data: { id: 'sub-1', ...values },
                error: null,
              })),
            })),
          };
        }),
      }));

      const result = await savePushSubscription('u2', subscription, {
        userAgent: 'Mozilla/5.0 test',
        permission: 'granted',
        expirationTime: 1893456000000,
      });

      expect(result.success).toBe(true);
      // The endpoint is the conflict target: re-registering a device transfers
      // it instead of leaving the previous account subscribed to it.
      expect(options).toEqual({ onConflict: 'endpoint' });
      expect(payload?.user_id).toBe('u2');
      expect(payload?.endpoint).toBe(subscription.endpoint);
      expect(payload?.user_agent).toBe('Mozilla/5.0 test');
      expect(payload?.permission).toBe('granted');
      expect(payload?.expiration_time).toBe(new Date(1893456000000).toISOString());
      expect(typeof payload?.last_seen_at).toBe('string');
    });

    it('never returns the subscription secrets', async () => {
      mockFrom.mockImplementation(() => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({
              data: { id: 'sub-1', endpoint: subscription.endpoint, p256dh: 'k', auth: 'a' },
              error: null,
            })),
          })),
        })),
      }));

      const result = await savePushSubscription('u1', subscription);

      expect(result.data).not.toHaveProperty('p256dh');
      expect(result.data).not.toHaveProperty('auth');
      expect(result.data?.keys_encrypted).toBe(false);
    });

    it('encrypts both keys at rest when the secret is configured', async () => {
      process.env.PUSH_KEY_ENCRYPTION_SECRET = 'test-encryption-secret';

      let payload: Record<string, unknown> | null = null;
      mockFrom.mockImplementation(() => ({
        upsert: mock((values: Record<string, unknown>) => {
          payload = values;
          return {
            select: mock(() => ({
              single: mock(async () => ({ data: { id: 'sub-1' }, error: null })),
            })),
          };
        }),
      }));

      await savePushSubscription('u1', subscription);

      expect(isEncryptedPushKey(payload?.p256dh)).toBe(true);
      expect(isEncryptedPushKey(payload?.auth)).toBe(true);
      expect(decryptPushKey(String(payload?.p256dh))).toBe('base64-p256dh-key');
      expect(decryptPushKey(String(payload?.auth))).toBe('base64-auth-secret');
    });

    it('rejects an invalid subscription before it reaches the database', async () => {
      const result = await savePushSubscription('u1', {
        endpoint: 'http://push.example.com/subscription/abc',
        keys: { p256dh: 'k', auth: 'a' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('endpoint must use HTTPS protocol');
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('replacement', () => {
    it('retires the previous endpoint and registers the new one', async () => {
      const deleted: Array<[string, string]> = [];
      let upsertedEndpoint: unknown = null;

      mockFrom.mockImplementation((table: string) => {
        if (table !== 'push_subscriptions') return PREFERENCES_TABLE;
        return {
          delete: mock(() => ({
            eq: mock((field: string, value: string) => ({
              eq: mock(async (field2: string, value2: string) => {
                deleted.push([field2, value2]);
                return OK;
              }),
            })),
          })),
          upsert: mock((values: Record<string, unknown>) => {
            upsertedEndpoint = values.endpoint;
            return {
              select: mock(() => ({
                single: mock(async () => ({ data: { id: 'sub-2' }, error: null })),
              })),
            };
          }),
        };
      });

      const result = await replacePushSubscription(
        'u1',
        'https://push.example.com/old-endpoint',
        subscription
      );

      expect(result.success).toBe(true);
      expect(deleted).toEqual([['endpoint', 'https://push.example.com/old-endpoint']]);
      expect(upsertedEndpoint).toBe(subscription.endpoint);
    });

    it('does not delete anything when the endpoint is unchanged', async () => {
      let deleteCalled = false;

      mockFrom.mockImplementation((table: string) => {
        if (table !== 'push_subscriptions') return PREFERENCES_TABLE;
        return {
          delete: mock(() => {
            deleteCalled = true;
            return { eq: mock(() => ({ eq: mock(async () => OK) })) };
          }),
          upsert: mock(() => ({
            select: mock(() => ({ single: mock(async () => ({ data: { id: 'sub-1' }, error: null })) })),
          })),
        };
      });

      await replacePushSubscription('u1', subscription.endpoint, subscription);

      expect(deleteCalled).toBe(false);
    });
  });

  describe('removal', () => {
    it('removes every device for the user on logout', async () => {
      const filters: Array<[string, string]> = [];

      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(async (field: string, value: string) => {
            filters.push([field, value]);
            return OK;
          }),
        })),
      }));

      const result = await removeAllPushSubscriptions('u1');

      expect(result.success).toBe(true);
      expect(filters).toEqual([['user_id', 'u1']]);
    });

    it('reports an empty endpoint as an error instead of deleting a whole account', async () => {
      const result = await removePushSubscription('u1', '   ');

      expect(result.success).toBe(false);
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('flags a device the server no longer knows about as out of sync', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(async () => ({
            data: [
              {
                id: 's1',
                user_id: 'u1',
                endpoint: 'https://push.example.com/other-device',
                p256dh: 'k',
                auth: 'a',
                permission: 'granted',
                last_seen_at: '2026-09-01T00:00:00.000Z',
              },
            ],
            error: null,
          })),
        })),
      }));

      const result = await getPushSubscriptionStatus('u1', 'https://push.example.com/this-device');

      expect(result.success).toBe(true);
      expect(result.data?.has_subscription).toBe(false);
      expect(result.data?.subscription_count).toBe(1);
      expect(result.data?.subscription).toBeNull();
    });

    it('confirms a device that is registered, with its reported permission', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(async () => ({
            data: [
              {
                id: 's1',
                user_id: 'u1',
                endpoint: 'https://push.example.com/this-device',
                p256dh: 'k',
                auth: 'a',
                permission: 'denied',
                last_seen_at: '2026-09-20T12:00:00.000Z',
              },
            ],
            error: null,
          })),
        })),
      }));

      const result = await getPushSubscriptionStatus('u1', 'https://push.example.com/this-device');

      expect(result.data?.has_subscription).toBe(true);
      expect(result.data?.permission).toBe('denied');
      expect(result.data?.last_seen_at).toBe('2026-09-20T12:00:00.000Z');
      expect(result.data?.subscription).not.toHaveProperty('auth');
    });

    it('skips rows that were retired', () => {
      const active = getActivePushSubscriptions([
        { id: 's1', user_id: 'u1', endpoint: 'https://push.example.com/live', p256dh: 'k', auth: 'a' },
        {
          id: 's2',
          user_id: 'u1',
          endpoint: 'https://push.example.com/gone',
          p256dh: 'k',
          auth: 'a',
          retired_at: '2026-09-01T00:00:00.000Z',
        } as never,
      ]);

      expect(active.map((row) => row.endpoint)).toEqual(['https://push.example.com/live']);
    });
  });

  describe('provider feedback', () => {
    const endpoint = 'https://push.example.com/device-1';

    function mockDelivery(statuses: number[]) {
      const deleted: string[] = [];

      mockFrom.mockImplementation((table: string) => {
        if (table !== 'push_subscriptions') return PREFERENCES_TABLE;
        return subscriptionTable({
          rows: [{ id: 's1', user_id: 'u1', endpoint, p256dh: 'k', auth: 'a' }],
          onDelete: (fields) => {
            for (const [field, value] of fields) {
              if (field === 'endpoint') deleted.push(value);
            }
          },
        });
      });

      let call = 0;
      globalThis.fetch = mock(async () => {
        const status = statuses[Math.min(call, statuses.length - 1)];
        call += 1;
        return { status, ok: status >= 200 && status < 300 };
      }) as unknown as typeof fetch;

      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = vapidPrivateKey();

      return { deleted };
    }

    it('retires an endpoint the provider rejects permanently', async () => {
      const { deleted } = mockDelivery([400]);

      const result = await sendPushToUser('u1', { title: 't', body: 'b' });

      expect(result.success).toBe(true);
      expect(result.data).toBe(0);
      expect(deleted).toEqual([endpoint]);
    });

    it('retires an endpoint reported as gone (410)', async () => {
      const { deleted } = mockDelivery([410]);

      await sendPushToUser('u1', { title: 't', body: 'b' });

      expect(deleted).toEqual([endpoint]);
    });

    it('keeps an endpoint after a single transient failure', async () => {
      const { deleted } = mockDelivery([503]);

      await sendPushToUser('u1', { title: 't', body: 'b' });

      expect(deleted).toEqual([]);
      expect(getTransientPushFailureCount(endpoint)).toBe(1);
    });

    it('retires an endpoint after repeated transient failures', async () => {
      const { deleted } = mockDelivery([429]);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await sendPushToUser('u1', { title: 't', body: 'b' });
      }

      expect(deleted).toEqual([endpoint]);
      expect(getTransientPushFailureCount(endpoint)).toBe(0);
    });

    it('resets the failure tally after a successful delivery', async () => {
      const { deleted } = mockDelivery([429, 429, 429, 429, 200, 429, 429, 429, 429]);

      for (let attempt = 0; attempt < 9; attempt += 1) {
        await sendPushToUser('u1', { title: 't', body: 'b' });
      }

      // The 5th attempt succeeded, so the four failures after it are a new run.
      expect(deleted).toEqual([]);
      expect(getTransientPushFailureCount(endpoint)).toBe(4);
    });

    it('counts a network failure as transient', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table !== 'push_subscriptions') return PREFERENCES_TABLE;
        return subscriptionTable({
          rows: [{ id: 's1', user_id: 'u1', endpoint, p256dh: 'k', auth: 'a' }],
        });
      });

      globalThis.fetch = mock(async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch;

      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = vapidPrivateKey();

      const result = await sendPushToUser('u1', { title: 't', body: 'b' });

      expect(result.success).toBe(true);
      expect(getTransientPushFailureCount(endpoint)).toBe(1);
    });
  });

  describe('payload hardening', () => {
    const withEndpoint = (endpoint: string) => ({
      endpoint,
      keys: { p256dh: 'base64-p256dh-key', auth: 'base64-auth-secret' },
    });

    it('refuses endpoints that point back into internal networks', () => {
      const blocked = [
        'https://localhost/push',
        'https://127.0.0.1/push',
        'https://10.0.0.5/push',
        'https://192.168.1.10/push',
        'https://172.16.4.2/push',
        'https://169.254.169.254/latest/meta-data',
        'https://metadata.google.internal/push',
        'https://push.internal/push',
        'https://printer.local/push',
      ];

      for (const endpoint of blocked) {
        expect(validatePushSubscription(withEndpoint(endpoint))).toMatch(/endpoint host is not allowed/);
      }
    });

    it('accepts a normal push service endpoint', () => {
      expect(validatePushSubscription(withEndpoint('https://fcm.googleapis.com/fcm/send/abc'))).toBeNull();
      expect(validatePushSubscription(withEndpoint('https://push.example.com/subscription/abc'))).toBeNull();
    });

    it('rejects an oversized endpoint', () => {
      const endpoint = `https://push.example.com/${'a'.repeat(2048)}`;
      expect(validatePushSubscription(withEndpoint(endpoint))).toMatch(/at most 2048 characters/);
    });

    it('rejects keys that are not base64url encoded', () => {
      expect(
        validatePushSubscription({
          endpoint: subscription.endpoint,
          keys: { p256dh: 'not a key!', auth: 'base64-auth-secret' },
        })
      ).toBe('keys.p256dh must be a valid base64 encoded key');

      expect(
        validatePushSubscription({
          endpoint: subscription.endpoint,
          keys: { p256dh: 'base64-p256dh-key', auth: 'auth key with spaces' },
        })
      ).toBe('keys.auth must be a valid base64 encoded key');
    });

    it('rejects an oversized key', () => {
      expect(
        validatePushSubscription({
          endpoint: subscription.endpoint,
          keys: { p256dh: 'a'.repeat(513), auth: 'base64-auth-secret' },
        })
      ).toBe('keys.p256dh must be at most 512 characters');
    });
  });
});
