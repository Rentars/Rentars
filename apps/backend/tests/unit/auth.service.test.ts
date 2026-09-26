/**
 * Unit tests for auth service.
 * Tests registration, login, and wallet auth flows.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockAuthSignUp = mock(async () => ({ data: null, error: null }));
const mockAuthSignIn = mock(async () => ({ data: null, error: null }));
const mockFrom = mock((_: string) => ({}));

const mockSupabase = {
  from: mockFrom,
  auth: {
    signUp: mockAuthSignUp,
    signInWithPassword: mockAuthSignIn,
  },
};

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as any).supabase = mockSupabase;

import { registerUser, loginUser, generateWalletChallenge, verifyWalletChallenge } from '../../src/services/auth.service.js';
import { AuthError } from '../../src/types/errors.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('auth.service', () => {
  beforeEach(() => {
    mockAuthSignUp.mockClear();
    mockAuthSignIn.mockClear();
    mockFrom.mockClear();
  });

  // ── registerUser ────────────────────────────────────────────────────────────

  describe('registerUser', () => {
    it('should register a user successfully', async () => {
      const mockUser = { id: 'user-1', email: 'test@example.com', created_at: '2026-01-01T00:00:00Z' };
      mockAuthSignUp.mockImplementation(async () => ({ data: { user: mockUser }, error: null }));

      const result = await registerUser('test@example.com', 'Password123!');
      expect(result.success).toBe(true);
      expect(result.data?.user.email).toBe('test@example.com');
    });

    it('should throw AuthError when email is missing', async () => {
      let thrown = false;
      try {
        await registerUser('', 'Password123!');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when password is missing', async () => {
      let thrown = false;
      try {
        await registerUser('test@example.com', '');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when Supabase returns error', async () => {
      mockAuthSignUp.mockImplementation(async () => ({
        data: { user: null },
        error: { message: 'Email already in use' },
      }));

      let thrown = false;
      try {
        await registerUser('existing@example.com', 'Password123!');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).message).toContain('Email already in use');
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when no user is returned', async () => {
      mockAuthSignUp.mockImplementation(async () => ({
        data: { user: null },
        error: null,
      }));

      let thrown = false;
      try {
        await registerUser('test@example.com', 'Password123!');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });
  });

  // ── loginUser ───────────────────────────────────────────────────────────────

  describe('loginUser', () => {
    it('should login user and return a JWT token', async () => {
      const mockUser = { id: 'user-1', email: 'user@example.com', created_at: '2026-01-01T00:00:00Z' };
      mockAuthSignIn.mockImplementation(async () => ({ data: { user: mockUser }, error: null }));

      const result = await loginUser('user@example.com', 'Password123!');
      expect(result.success).toBe(true);
      expect(result.data?.token).toBeDefined();
      expect(typeof result.data?.token).toBe('string');
      expect(result.data?.user.id).toBe('user-1');
    });

    it('should throw AuthError with invalid credentials', async () => {
      mockAuthSignIn.mockImplementation(async () => ({
        data: { user: null },
        error: { message: 'Invalid login credentials' },
      }));

      let thrown = false;
      try {
        await loginUser('wrong@example.com', 'wrongpass');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when email is missing', async () => {
      let thrown = false;
      try {
        await loginUser('', 'password');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when password is missing', async () => {
      let thrown = false;
      try {
        await loginUser('test@example.com', '');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });
  });

  // ── generateWalletChallenge ─────────────────────────────────────────────────

  describe('generateWalletChallenge', () => {
    const validAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3';

    it('should generate a challenge for a valid Stellar address', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(async () => ({ data: {}, error: null })),
      }));

      const result = await generateWalletChallenge(validAddress);
      expect(result.success).toBe(true);
      expect(result.data?.challenge).toBeDefined();
      expect(result.data?.expiresAt).toBeDefined();
      // expiresAt should be ~10 minutes in the future
      const expiry = new Date(result.data!.expiresAt);
      expect(expiry.getTime()).toBeGreaterThan(Date.now());
    });

    it('should throw AuthError when stellar address is missing', async () => {
      let thrown = false;
      try {
        await generateWalletChallenge('');
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should throw AuthError when challenge insert fails', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(async () => ({ data: null, error: { message: 'Insert failed' } })),
      }));

      let thrown = false;
      try {
        await generateWalletChallenge(validAddress);
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });
  });

  // ── loginUser — email normalisation (issue #488) ────────────────────────────

  describe('loginUser — email normalisation', () => {
    it('should pass a trimmed, lowercased email to the auth provider for a padded mixed-case address', async () => {
      // Capture the email argument that reaches signInWithPassword
      let capturedEmail: string | undefined;
      mockAuthSignIn.mockImplementation(async (opts: { email: string; password: string }) => {
        capturedEmail = opts.email;
        return {
          data: { user: { id: 'user-1', email: opts.email, created_at: '2026-01-01T00:00:00Z' } },
          error: null,
        };
      });

      await loginUser('  User@Example.COM  ', 'Password123!');

      // The value sent to the provider must be the canonical lowercase+trimmed form
      expect(capturedEmail).toBe('user@example.com');
    });

    it('should not alter the password when normalising the email', async () => {
      const rawPassword = '  MyP@ssw0rd!!  '; // leading/trailing spaces are intentional
      let capturedPassword: string | undefined;
      mockAuthSignIn.mockImplementation(async (opts: { email: string; password: string }) => {
        capturedPassword = opts.password;
        return {
          data: { user: { id: 'user-2', email: 'user@example.com', created_at: '2026-01-01T00:00:00Z' } },
          error: null,
        };
      });

      await loginUser('user@example.com', rawPassword);

      // Password must reach the provider byte-for-byte as supplied
      expect(capturedPassword).toBe(rawPassword);
    });

    it('should succeed and return a token for a padded mixed-case address equivalent to the registered one', async () => {
      mockAuthSignIn.mockImplementation(async () => ({
        data: { user: { id: 'user-3', email: 'user@example.com', created_at: '2026-01-01T00:00:00Z' } },
        error: null,
      }));

      const result = await loginUser('  USER@EXAMPLE.COM  ', 'Password123!');
      expect(result.success).toBe(true);
      expect(result.data?.token).toBeDefined();
      expect(typeof result.data?.token).toBe('string');
    });
  });

  // ── verifyWalletChallenge — expiration guard (issue #490) ───────────────────

  describe('verifyWalletChallenge — expiration timestamp guard', () => {
    const stellarAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3';
    const challenge = 'test-challenge-string';
    const signature = Buffer.from('fake-sig').toString('base64');

    /**
     * Helper — set up mockFrom so that wallet_challenges returns the given
     * `expires_at` value. Signature verification is bypassed by giving a
     * non-Stellar challenge string (the Keypair.verify path throws, which the
     * service catches and re-throws as AuthError — but expiry is checked first,
     * so invalid-expiry cases never reach that branch).
     */
    function mockChallengeRow(expiresAt: string | null | undefined) {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'wallet_challenges') {
          // Support both .select().eq().eq().single() chain and .update().eq() chain
          const row = expiresAt !== undefined
            ? { id: 'chal-1', expires_at: expiresAt, used: false }
            : { id: 'chal-1', used: false }; // expires_at key absent entirely

          const single = mock(async () => ({ data: row, error: null }));
          const eqInner = mock(() => ({ single }));
          const eqOuter = mock(() => ({ eq: eqInner }));
          const select = mock(() => ({ eq: eqOuter }));
          const eqUpdate = mock(async () => ({ data: null, error: null }));
          const update = mock(() => ({ eq: eqUpdate }));
          return { select, update };
        }
        // users table — return no existing user to trigger creation path
        const single = mock(async () => ({ data: null, error: { message: 'not found' } }));
        const eq = mock(() => ({ single }));
        const select = mock(() => ({ eq }));
        const eqInsert = mock(async () => ({
          data: [{ id: 'new-user', email: null, created_at: '2026-01-01T00:00:00Z', role: 'tenant' }],
          error: null,
        }));
        const selectAfterInsert = mock(() => ({ single: mock(async () => ({ data: { id: 'new-user', email: null, created_at: '2026-01-01T00:00:00Z', role: 'tenant' }, error: null })) }));
        const insert = mock(() => ({ select: selectAfterInsert }));
        return { select, insert };
      });
    }

    it('should reject a challenge whose expires_at is null (missing)', async () => {
      mockChallengeRow(null);
      let thrown = false;
      try {
        await verifyWalletChallenge(stellarAddress, challenge, signature);
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should reject a challenge whose expires_at is an invalid date string (NaN timestamp)', async () => {
      mockChallengeRow('not-a-date');
      let thrown = false;
      try {
        await verifyWalletChallenge(stellarAddress, challenge, signature);
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should reject a challenge that has already elapsed', async () => {
      // 1 second in the past
      const past = new Date(Date.now() - 1000).toISOString();
      mockChallengeRow(past);
      let thrown = false;
      try {
        await verifyWalletChallenge(stellarAddress, challenge, signature);
      } catch (err) {
        thrown = true;
        expect(err).toBeInstanceOf(AuthError);
      }
      expect(thrown).toBe(true);
    });

    it('should proceed past the expiry check for a valid future timestamp', async () => {
      // 10 minutes in the future — expiry check should pass; the test will then
      // fail at signature verification (expected AuthError from that branch), NOT
      // from the expiry guard. This proves the guard does not over-reject live challenges.
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockChallengeRow(future);
      let thrown = false;
      let thrownError: unknown;
      try {
        await verifyWalletChallenge(stellarAddress, challenge, signature);
      } catch (err) {
        thrown = true;
        thrownError = err;
      }
      // Must throw (signature will be invalid), but NOT with TOKEN_EXPIRED
      expect(thrown).toBe(true);
      expect(thrownError).toBeInstanceOf(AuthError);
      expect((thrownError as AuthError).message).not.toContain('expired');
    });
  });
});
