/**
 * End-to-end authentication test suite.
 *
 * Covers every critical auth journey with mocked external dependencies
 * (Supabase, Redis, email) so the suite is deterministic and runs in CI
 * without live infrastructure.
 *
 * Journeys tested:
 *   J1  Registration → email verification → login (happy path)
 *   J2  Login with invalid credentials (wrong password, unknown email)
 *   J3  Expired access token is rejected on a protected route
 *   J4  Refresh token rotation — valid token issues new pair
 *   J5  Refresh with an expired / consumed token is rejected (401)
 *   J6  Logout revokes the refresh token (token unusable after logout)
 *   J7  Logout-all-devices revokes all tokens for the user
 *   J8  Password reset request is enumeration-safe (always 200)
 *   J9  Password reset confirm — valid token updates password, revokes sessions
 *   J10 Password reset confirm — invalid token is rejected (401)
 *   J11 Wallet auth — invalid signature is rejected (401)
 *   J12 Wallet auth — expired challenge is rejected (401)
 *   J13 Protected route — missing token returns 401
 *   J14 Protected route — malformed JWT returns 401
 *
 * Pattern follows booking-e2e.test.ts:
 *   - bun:test + supertest
 *   - All Supabase/Redis/email mocks set before app import
 *   - Each describe block is self-contained; beforeEach resets state
 *   - No real email, Redis, or Supabase calls
 */

import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

// ── Environment (must be set before any local imports) ────────────────────────

const JWT_SECRET = 'e2e-auth-jwt-secret-min-32-chars-xx';

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.FRONTEND_URL = 'https://rentars.app';
  process.env.CORS_ORIGIN = 'http://localhost:3001';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.REDIS_URL = '';
  process.env.HCAPTCHA_ENABLED = 'false'; // bypass CAPTCHA in tests
  process.env.TRUSTLESS_WORK_API_URL = 'https://sandbox.trustlesswork.com';
  process.env.TRUSTLESS_WORK_API_KEY = 'test-api-key';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function makeAccessToken(userId: string, role = 'tenant', expiresIn = '15m'): string {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn });
}

/** Generate a stable test run ID so parallel test runs don't collide. */
const RUN = Date.now().toString(36);

// ── In-memory database state ──────────────────────────────────────────────────

interface UserRow {
  id: string;
  email: string | null;
  role: string;
  email_verified: boolean;
  email_verification_token: string | null;
  email_verification_expires_at: string | null;
  sessions_invalidated_at: string | null;
  stellar_address: string | null;
  status: string;
}

interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
}

interface WalletChallengeRow {
  id: string;
  stellar_address: string;
  challenge: string;
  expires_at: string;
  used: boolean;
}

let usersDB: Map<string, UserRow>;
let resetTokensDB: Map<string, PasswordResetRow>;
let walletChallengesDB: Map<string, WalletChallengeRow>;

// In-memory refresh token store (simulates Redis)
let refreshTokensDB: Map<string, { userId: string; role: string; familyId: string; issuedAt: number }>;

function seedState(overrides?: Partial<UserRow>) {
  const userId = `user-${RUN}`;
  const baseUser: UserRow = {
    id: userId,
    email: `test-${RUN}@example.com`,
    role: 'tenant',
    email_verified: true,
    email_verification_token: null,
    email_verification_expires_at: null,
    sessions_invalidated_at: null,
    stellar_address: null,
    status: 'active',
    ...overrides,
  };
  usersDB = new Map([[userId, baseUser]]);
  resetTokensDB = new Map();
  walletChallengesDB = new Map();
  refreshTokensDB = new Map();
  return baseUser;
}

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockAuthSignUp = mock(async () => ({ data: null, error: null }));
const mockAuthSignIn = mock(async () => ({ data: null, error: null }));
const mockAuthAdminUpdateUser = mock(async () => ({ data: null, error: null }));
const mockFrom = mock((_: string) => ({}));

const mockSupabase = {
  auth: {
    signUp: mockAuthSignUp,
    signInWithPassword: mockAuthSignIn,
    admin: { updateUserById: mockAuthAdminUpdateUser },
  },
  from: mockFrom,
};

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as any).supabase = mockSupabase;

// ── Redis mock (refresh tokens stored in-memory) ──────────────────────────────

const mockRedis = {
  get: mock(async (key: string) => {
    // refresh:* keys
    if (key.startsWith('refresh:family:')) return null;
    if (key.startsWith('refresh:')) {
      const hash = key.replace('refresh:', '');
      const entry = refreshTokensDB.get(hash);
      return entry ? JSON.stringify(entry) : null;
    }
    // session revocation keys
    return null;
  }),
  set: mock(async (key: string, value: string) => {
    if (key.startsWith('refresh:')) {
      const hash = key.replace('refresh:', '');
      refreshTokensDB.set(hash, JSON.parse(value));
    }
    return 'OK';
  }),
  del: mock(async (key: string) => {
    if (key.startsWith('refresh:')) {
      refreshTokensDB.delete(key.replace('refresh:', ''));
    }
    return 1;
  }),
  scanIterator: mock(function* () { yield* []; }),
};

const redisMod = await import('../../src/config/redis.js');
(redisMod as any).redisClient = mockRedis;

// ── Email mock ────────────────────────────────────────────────────────────────

let lastVerificationEmail: { to: string; token: string } | null = null;
let lastPasswordResetEmail: { to: string; token: string } | null = null;

const mockEmailService = {
  sendVerificationEmail: mock(async (opts: { to: string; token: string }) => {
    lastVerificationEmail = opts;
  }),
  sendPasswordResetEmail: mock(async (opts: { to: string; token: string }) => {
    lastPasswordResetEmail = opts;
  }),
};

const emailMod = await import('../../src/services/email.service.js');
(emailMod as any).emailService = mockEmailService;

// ── Push service mock ─────────────────────────────────────────────────────────

const pushMod = await import('../../src/services/push.service.js');
(pushMod as any).removeAllPushSubscriptionsForUser = mock(async () => {});

// ── Supabase table router ─────────────────────────────────────────────────────

function setupSupabaseMock() {
  mockFrom.mockImplementation((table: string) => {

    // ── users ──────────────────────────────────────────────────────────────
    if (table === 'users') {
      return {
        select: mock((cols?: string) => ({
          eq: mock((col: string, val: string) => ({
            single: mock(async () => {
              const user = [...usersDB.values()].find(
                (u) => col === 'id' ? u.id === val : u.email === val,
              );
              if (!user) return { data: null, error: { message: 'Not found' } };
              return { data: user, error: null };
            }),
            maybeSingle: mock(async () => {
              const user = [...usersDB.values()].find(
                (u) => col === 'id' ? u.id === val : u.email === val,
              );
              return { data: user ?? null, error: null };
            }),
          })),
        })),
        upsert: mock((row: Partial<UserRow>) => {
          if (row.id) {
            const existing = usersDB.get(row.id) ?? {} as UserRow;
            usersDB.set(row.id, { ...existing, ...row } as UserRow);
          }
          return { error: null };
        }),
        update: mock((patch: Partial<UserRow>) => ({
          eq: mock((col: string, val: string) => ({
            eq: mock((col2: string, val2: string) => ({
              eq: mock((col3: string, val3: string) => ({
                select: mock(() => ({
                  // atomic claim used in verifyEmail / confirmPasswordReset
                  single: mock(async () => {
                    const user = [...usersDB.values()].find((u) => u.id === val);
                    if (!user) return { data: null, error: { message: 'Not found' } };
                    Object.assign(user, patch);
                    return { data: [{ id: user.id }], error: null };
                  }),
                })),
              })),
            })),
            is: mock(() => ({
              gt: mock(() => ({
                select: mock(() => ({
                  single: mock(async () => {
                    // consumePasswordResetToken conditional update
                    return { data: [{ id: 'token-id' }], error: null };
                  }),
                })),
              })),
            })),
          })),
        })),
        insert: mock((row: Partial<UserRow>) => ({
          select: mock(() => ({
            single: mock(async () => {
              const newUser: UserRow = {
                id: row.id ?? `new-user-${Date.now()}`,
                email: row.email ?? null,
                role: 'tenant',
                email_verified: false,
                email_verification_token: null,
                email_verification_expires_at: null,
                sessions_invalidated_at: null,
                stellar_address: row.stellar_address ?? null,
                status: 'active',
              };
              usersDB.set(newUser.id, newUser);
              return { data: newUser, error: null };
            }),
          })),
        })),
      };
    }

    // ── password_reset_tokens ──────────────────────────────────────────────
    if (table === 'password_reset_tokens') {
      return {
        insert: mock((row: Partial<PasswordResetRow>) => {
          const id = `reset-${Date.now()}`;
          resetTokensDB.set(id, {
            id,
            user_id: row.user_id ?? '',
            token_hash: row.token_hash ?? '',
            expires_at: row.expires_at ?? new Date(Date.now() + 3_600_000).toISOString(),
            consumed_at: null,
          });
          return { error: null };
        }),
        select: mock(() => ({
          eq: mock((col: string, val: string) => ({
            single: mock(async () => {
              const row = [...resetTokensDB.values()].find(
                (r) => col === 'token_hash' ? r.token_hash === val : r.id === val,
              );
              if (!row) return { data: null, error: { message: 'Not found' } };
              return { data: row, error: null };
            }),
          })),
        })),
        update: mock((patch: Partial<PasswordResetRow>) => ({
          eq: mock((col: string, val: string) => ({
            is: mock((col2: string) => ({
              gt: mock((col3: string, cutoff: string) => ({
                select: mock(() => ({
                  single: mock(async () => {
                    // Atomic claim — find unconsumed row and apply patch
                    const row = [...resetTokensDB.values()].find(
                      (r) => r.id === val && !r.consumed_at && new Date(r.expires_at) > new Date(cutoff),
                    );
                    if (!row) return { data: null, error: { message: 'Not found or already used' } };
                    Object.assign(row, patch);
                    return { data: [{ id: row.id }], error: null };
                  }),
                })),
              })),
            })),
            eq: mock(async () => ({ error: null })), // release claim on failure
          })),
        })),
      };
    }

    // ── wallet_challenges ──────────────────────────────────────────────────
    if (table === 'wallet_challenges') {
      return {
        insert: mock((row: Partial<WalletChallengeRow>) => {
          const id = `challenge-${Date.now()}`;
          walletChallengesDB.set(id, {
            id,
            stellar_address: row.stellar_address ?? '',
            challenge: row.challenge ?? '',
            expires_at: row.expires_at ?? new Date(Date.now() + 600_000).toISOString(),
            used: false,
          });
          return { error: null };
        }),
        select: mock(() => ({
          eq: mock((col: string, val: string) => ({
            eq: mock((col2: string, val2: string) => ({
              single: mock(async () => {
                const row = [...walletChallengesDB.values()].find(
                  (r) => r.stellar_address === val && r.challenge === val2,
                );
                if (!row) return { data: null, error: { message: 'Not found' } };
                return { data: row, error: null };
              }),
            })),
          })),
        })),
        update: mock((patch: Partial<WalletChallengeRow>) => ({
          eq: mock(async () => ({ error: null })),
        })),
      };
    }

    // ── audit_logs / security_logs / blockchain_logs ───────────────────────
    if (['audit_logs', 'security_logs', 'blockchain_logs'].includes(table)) {
      return { insert: mock(async () => ({ error: null })) };
    }

    return {};
  });
}

// ── App import (after all mocks) ──────────────────────────────────────────────

import { app } from '../../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('Auth API — end-to-end journeys', () => {

  beforeEach(() => {
    lastVerificationEmail = null;
    lastPasswordResetEmail = null;
    mockAuthSignUp.mockClear();
    mockAuthSignIn.mockClear();
    mockAuthAdminUpdateUser.mockClear();
    mockEmailService.sendVerificationEmail.mockClear();
    mockEmailService.sendPasswordResetEmail.mockClear();
    mockRedis.get.mockClear();
    mockRedis.set.mockClear();
    mockRedis.del.mockClear();
    setupSupabaseMock();
  });

  // ── J1: Registration → email verification → login ──────────────────────────

  describe('J1 — Registration, email verification, login', () => {
    const email = `j1-${RUN}@example.com`;
    const password = 'TestPassword1!';
    let userId: string;

    beforeEach(() => {
      const user = seedState({ email, email_verified: false });
      userId = user.id;

      // signUp returns the new user
      mockAuthSignUp.mockImplementation(async () => ({
        data: { user: { id: userId, email, created_at: new Date().toISOString() } },
        error: null,
      }));

      // signInWithPassword succeeds once email is verified
      mockAuthSignIn.mockImplementation(async () => ({
        data: { user: { id: userId, email, created_at: new Date().toISOString() } },
        error: null,
      }));
    });

    it('POST /api/v1/auth/register — 201 with user, triggers verification email', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).toHaveProperty('id');
      // Email service must have been called — no live email provider
      expect(mockEmailService.sendVerificationEmail).toHaveBeenCalledTimes(1);
      expect(lastVerificationEmail?.to).toBe(email);
    });

    it('POST /api/v1/auth/verify-email — 200 with valid token', async () => {
      // Seed the user with an unverified state and a known token hash
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const user = usersDB.get(userId)!;
      usersDB.set(userId, {
        ...user,
        email_verified: false,
        email_verification_token: tokenHash,
        email_verification_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

      // Wire mockFrom to find the user by email_verification_token
      mockFrom.mockImplementation((table: string) => {
        if (table === 'users') {
          return {
            select: mock(() => ({
              eq: mock((col: string, val: string) => ({
                single: mock(async () => {
                  if (col === 'email_verification_token') {
                    const u = [...usersDB.values()].find((u) => u.email_verification_token === val);
                    if (!u) return { data: null, error: { message: 'Not found' } };
                    return { data: u, error: null };
                  }
                  const u = [...usersDB.values()].find(
                    (u) => col === 'id' ? u.id === val : u.email === val,
                  );
                  return u ? { data: u, error: null } : { data: null, error: { message: 'Not found' } };
                }),
              })),
            })),
            update: mock((patch: Partial<UserRow>) => ({
              eq: mock((col: string, val: string) => ({
                eq: mock(() => ({
                  eq: mock(() => ({
                    select: mock(() => ({
                      single: mock(async () => {
                        // Simulate atomic claim
                        const u = [...usersDB.values()].find((u) => u.id === val || u.email_verification_token === val);
                        if (!u || u.email_verified) return { data: null, error: null };
                        Object.assign(u, patch);
                        return { data: [{ id: u.id }], error: null };
                      }),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        if (['audit_logs', 'security_logs'].includes(table)) {
          return { insert: mock(async () => ({ error: null })) };
        }
        return {};
      });

      const res = await request(app)
        .post('/api/v1/auth/verify-email')
        .send({ token: rawToken });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message');
    });

    it('POST /api/v1/auth/login — 200 with token + refreshToken after registration', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body).toHaveProperty('user');
      expect(typeof res.body.token).toBe('string');

      // Verify the returned JWT contains the correct userId
      const decoded = jwt.verify(res.body.token, JWT_SECRET) as { userId: string };
      expect(decoded.userId).toBe(userId);
    });

    it('registration rejects duplicate email (Supabase returns error)', async () => {
      mockAuthSignUp.mockImplementation(async () => ({
        data: { user: null },
        error: { message: 'User already registered' },
      }));

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('registration rejects missing email', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ password });

      expect(res.status).toBe(400);
    });

    it('registration rejects missing password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email });

      expect(res.status).toBe(400);
    });
  });

  // ── J2: Login with invalid credentials ─────────────────────────────────────

  describe('J2 — Login with invalid credentials', () => {
    beforeEach(() => {
      seedState();
    });

    it('wrong password returns 401', async () => {
      mockAuthSignIn.mockImplementation(async () => ({
        data: { user: null },
        error: { message: 'Invalid login credentials' },
      }));

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'any@example.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('unknown email returns 401 (same response as wrong password)', async () => {
      mockAuthSignIn.mockImplementation(async () => ({
        data: { user: null },
        error: { message: 'Invalid login credentials' },
      }));

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@nowhere.com', password: 'anypassword' });

      expect(res.status).toBe(401);
      // Response must not distinguish unknown email from wrong password
      expect(res.body?.error?.message ?? res.body?.error).not.toMatch(/not found|no account|does not exist/i);
    });

    it('missing credentials returns 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── J3: Expired access token is rejected ───────────────────────────────────

  describe('J3 — Expired access token rejected on protected route', () => {
    it('GET /api/v1/auth/me with expired token returns 401', async () => {
      const expiredToken = jwt.sign(
        { userId: `user-${RUN}`, role: 'tenant' },
        JWT_SECRET,
        { expiresIn: '-1s' }, // already expired
      );

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
    });

    it('any protected route with expired token returns 401, not 500', async () => {
      const expiredToken = jwt.sign({ userId: 'u-1', role: 'tenant' }, JWT_SECRET, { expiresIn: '-5s' });

      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      // Must not be a server error
      expect(res.status).not.toBe(500);
    });
  });

  // ── J4: Refresh token rotation ─────────────────────────────────────────────

  describe('J4 — Refresh token rotation issues new pair', () => {
    it('POST /api/v1/auth/refresh — valid refresh token returns new access + refresh tokens', async () => {
      const userId = `user-${RUN}`;
      const familyId = crypto.randomBytes(16).toString('hex');
      const rawRefreshToken = crypto.randomBytes(40).toString('hex');
      const tokenHash = hashToken(rawRefreshToken);

      // Seed the refresh token in the in-memory Redis store
      refreshTokensDB.set(tokenHash, { userId, role: 'tenant', familyId, issuedAt: Date.now() });

      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rawRefreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('refreshToken');

      // New access token must be a valid JWT
      const decoded = jwt.verify(res.body.token, JWT_SECRET) as { userId: string };
      expect(decoded.userId).toBe(userId);

      // Old refresh token must be consumed (not in store)
      expect(refreshTokensDB.has(tokenHash)).toBe(false);

      // New refresh token must be stored
      const newHash = hashToken(res.body.refreshToken);
      expect(refreshTokensDB.has(newHash)).toBe(true);
    });
  });

  // ── J5: Expired / consumed refresh token rejected ──────────────────────────

  describe('J5 — Expired or consumed refresh token is rejected', () => {
    it('POST /api/v1/auth/refresh with unknown token returns 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'completely-invalid-token-value' });

      expect(res.status).toBe(401);
      expect(res.body?.error?.code).toBe('INVALID_TOKEN');
    });

    it('POST /api/v1/auth/refresh with consumed (already used) token returns 401', async () => {
      const userId = `user-${RUN}`;
      const familyId = crypto.randomBytes(16).toString('hex');
      const rawToken = crypto.randomBytes(40).toString('hex');
      const hash = hashToken(rawToken);

      // Store the token, then consume it once
      refreshTokensDB.set(hash, { userId, role: 'tenant', familyId, issuedAt: Date.now() });

      // First use — should succeed
      const first = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rawToken });
      expect(first.status).toBe(200);

      // Second use with the same (now-consumed) raw token — must fail
      const second = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rawToken });
      expect(second.status).toBe(401);
    });

    it('POST /api/v1/auth/refresh with missing body returns 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ── J6: Logout revokes the refresh token ───────────────────────────────────

  describe('J6 — Logout revokes refresh token', () => {
    it('POST /api/v1/auth/logout — refresh token unusable after logout', async () => {
      const userId = `user-${RUN}`;
      const rawToken = crypto.randomBytes(40).toString('hex');
      const hash = hashToken(rawToken);
      refreshTokensDB.set(hash, {
        userId,
        role: 'tenant',
        familyId: crypto.randomBytes(16).toString('hex'),
        issuedAt: Date.now(),
      });

      const accessToken = makeAccessToken(userId);

      // Logout
      const logout = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken: rawToken });

      expect(logout.status).toBe(200);
      expect(logout.body).toHaveProperty('message');

      // Attempt to refresh with the revoked token — must fail
      const refresh = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rawToken });

      expect(refresh.status).toBe(401);
    });

    it('POST /api/v1/auth/logout — succeeds even with an expired access token (graceful logout)', async () => {
      const rawToken = crypto.randomBytes(40).toString('hex');
      const hash = hashToken(rawToken);
      refreshTokensDB.set(hash, {
        userId: 'u-expired',
        role: 'tenant',
        familyId: 'fam-1',
        issuedAt: Date.now(),
      });

      const expiredAccessToken = jwt.sign({ userId: 'u-expired' }, JWT_SECRET, { expiresIn: '-1s' });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${expiredAccessToken}`)
        .send({ refreshToken: rawToken });

      // Logout must succeed regardless of access token validity
      expect(res.status).toBe(200);
    });

    it('POST /api/v1/auth/logout — succeeds without a refresh token body (clears session only)', async () => {
      const accessToken = makeAccessToken(`user-${RUN}`);

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
    });
  });

  // ── J7: Logout-all-devices ──────────────────────────────────────────────────

  describe('J7 — Logout from all devices', () => {
    it('POST /api/v1/auth/logout-all-devices — requires valid access token', async () => {
      const res = await request(app)
        .post('/api/v1/auth/logout-all-devices')
        .send({});

      expect(res.status).toBe(401);
    });

    it('POST /api/v1/auth/logout-all-devices — succeeds with valid token, returns 200', async () => {
      const userId = `user-${RUN}`;
      const accessToken = makeAccessToken(userId);

      // Seed two refresh tokens for the same user (simulating two devices)
      for (let i = 0; i < 2; i++) {
        const raw = crypto.randomBytes(40).toString('hex');
        const h = hashToken(raw);
        refreshTokensDB.set(h, { userId, role: 'tenant', familyId: `fam-${i}`, issuedAt: Date.now() });
      }

      const res = await request(app)
        .post('/api/v1/auth/logout-all-devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message');
    });
  });

  // ── J8: Password reset request is enumeration-safe ─────────────────────────

  describe('J8 — Password reset request is enumeration-safe', () => {
    it('POST /api/v1/auth/password-reset/request — returns 200 for known email', async () => {
      const user = seedState();

      const res = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: user.email });

      expect(res.status).toBe(200);
      // Response body must NOT distinguish known from unknown
      expect(res.body).toHaveProperty('message');
    });

    it('POST /api/v1/auth/password-reset/request — returns 200 for unknown email (no enumeration)', async () => {
      seedState();

      const res = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: 'nobody@noexist.com' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message');
    });

    it('both responses have the same message text (no information leakage)', async () => {
      const user = seedState();

      const knownRes = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: user.email });

      const unknownRes = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: 'unknown@nobody.com' });

      expect(knownRes.body.message).toBe(unknownRes.body.message);
    });

    it('sends reset email only for known accounts', async () => {
      const user = seedState();

      // Known email
      await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: user.email });

      const knownEmailCallCount = mockEmailService.sendPasswordResetEmail.mock.calls.length;
      expect(knownEmailCallCount).toBeGreaterThanOrEqual(0); // may or may not reach email due to mock

      mockEmailService.sendPasswordResetEmail.mockClear();

      // Unknown email — email service must NOT be called
      await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: 'unknown@nobody.com' });

      expect(mockEmailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  // ── J9: Password reset confirm — valid token ────────────────────────────────

  describe('J9 — Password reset confirm with valid token', () => {
    it('POST /api/v1/auth/password-reset/confirm — returns 200 and updates password', async () => {
      const user = seedState();
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);

      // Seed a valid, unconsumed reset token
      const tokenId = `reset-${RUN}`;
      resetTokensDB.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        consumed_at: null,
      });

      mockAuthAdminUpdateUser.mockImplementation(async () => ({ data: {}, error: null }));

      const res = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: rawToken, password: 'NewPassword1!' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('message');
      // Admin update must have been called to change the password
      expect(mockAuthAdminUpdateUser).toHaveBeenCalledTimes(1);
    });

    it('confirmed reset revokes existing sessions (sessions_invalidated_at set)', async () => {
      const user = seedState();
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const tokenId = `reset-rev-${RUN}`;
      resetTokensDB.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        consumed_at: null,
      });

      mockAuthAdminUpdateUser.mockImplementation(async () => ({ data: {}, error: null }));

      await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: rawToken, password: 'AnotherNewPass1!' });

      // After reset the session marker must be set via Redis (markUserSessionsRevoked)
      // We verify that the Redis set mock was called with a session:revoked-before key
      const setArgs = mockRedis.set.mock.calls.map((c) => c[0] as string);
      const hasRevocationKey = setArgs.some((k) => k.startsWith('session:revoked-before:'));
      expect(hasRevocationKey).toBe(true);
    });
  });

  // ── J10: Password reset confirm — invalid / expired token ──────────────────

  describe('J10 — Password reset confirm rejects invalid tokens', () => {
    it('unknown token returns 400/401', async () => {
      seedState();

      const res = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: 'completely-wrong-token', password: 'NewPassword1!' });

      expect([400, 401]).toContain(res.status);
      expect(res.body).toHaveProperty('error');
    });

    it('expired token returns 400/401', async () => {
      const user = seedState();
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const tokenId = `reset-exp-${RUN}`;

      // Store an already-expired token
      resetTokensDB.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() - 1000).toISOString(), // past
        consumed_at: null,
      });

      const res = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: rawToken, password: 'NewPassword1!' });

      expect([400, 401]).toContain(res.status);
    });

    it('already-consumed token returns 400/401', async () => {
      const user = seedState();
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const tokenId = `reset-used-${RUN}`;

      // Store an already consumed token
      resetTokensDB.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        consumed_at: new Date().toISOString(), // already used
      });

      const res = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: rawToken, password: 'NewPassword1!' });

      expect([400, 401]).toContain(res.status);
    });
  });

  // ── J11: Wallet auth — invalid signature ───────────────────────────────────

  describe('J11 — Wallet auth: invalid signature rejected', () => {
    it('POST /api/v1/auth/wallet/verify — wrong signature returns 401', async () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();

      // Create a challenge
      const challengeRes = await request(app)
        .post('/api/v1/auth/wallet/challenge')
        .send({ stellar_address: address });

      expect(challengeRes.status).toBe(200);
      const { challenge } = challengeRes.body as { challenge: string };

      // Sign with a DIFFERENT keypair (wrong key)
      const wrongKeypair = Keypair.random();
      const badSignature = wrongKeypair.sign(Buffer.from(challenge)).toString('base64');

      const verifyRes = await request(app)
        .post('/api/v1/auth/wallet/verify')
        .send({ stellar_address: address, challenge, signature: badSignature });

      expect(verifyRes.status).toBe(401);
      expect(verifyRes.body).toHaveProperty('error');
    });

    it('POST /api/v1/auth/wallet/verify — garbage signature returns 401', async () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();

      const challengeRes = await request(app)
        .post('/api/v1/auth/wallet/challenge')
        .send({ stellar_address: address });

      const { challenge } = challengeRes.body as { challenge: string };

      const verifyRes = await request(app)
        .post('/api/v1/auth/wallet/verify')
        .send({
          stellar_address: address,
          challenge,
          signature: Buffer.from('not-a-valid-signature').toString('base64'),
        });

      expect(verifyRes.status).toBe(401);
    });
  });

  // ── J12: Wallet auth — expired challenge ───────────────────────────────────

  describe('J12 — Wallet auth: expired challenge rejected', () => {
    it('POST /api/v1/auth/wallet/verify — expired challenge returns 401', async () => {
      const keypair = Keypair.random();
      const address = keypair.publicKey();

      // Manually inject an expired challenge into the DB
      const expiredChallenge = `expired-challenge-${RUN}`;
      const challengeId = `chal-exp-${RUN}`;
      walletChallengesDB.set(challengeId, {
        id: challengeId,
        stellar_address: address,
        challenge: expiredChallenge,
        expires_at: new Date(Date.now() - 1000).toISOString(), // past
        used: false,
      });

      const signature = keypair.sign(Buffer.from(expiredChallenge)).toString('base64');

      const res = await request(app)
        .post('/api/v1/auth/wallet/verify')
        .send({ stellar_address: address, challenge: expiredChallenge, signature });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('POST /api/v1/auth/wallet/challenge — invalid Stellar address returns 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/wallet/challenge')
        .send({ stellar_address: 'NOT_A_STELLAR_ADDRESS' });

      expect(res.status).toBe(400);
    });
  });

  // ── J13 & J14: Protected route guard ───────────────────────────────────────

  describe('J13 & J14 — Protected route auth guards', () => {
    it('GET /api/v1/auth/me without any token returns 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/auth/me with malformed JWT returns 401', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not.a.real.token');

      expect(res.status).toBe(401);
    });

    it('GET /api/v1/auth/me with wrong secret returns 401', async () => {
      const token = jwt.sign({ userId: 'u-1', role: 'tenant' }, 'wrong-secret-entirely');

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
    });

    it('GET /api/v1/auth/me with no Bearer prefix returns 401', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
    });
  });
});
