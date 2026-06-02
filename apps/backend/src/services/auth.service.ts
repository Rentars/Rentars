/**
 * Auth service — wraps Supabase Auth operations.
 *
 * Controllers should call these functions instead of touching Supabase directly.
 */

import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { Keypair, TransactionBuilder, Networks, BASE_FEE } from '@stellar/stellar-sdk';
import { supabase } from '@/config/supabase.js';
import { AuthError, AuthErrorCode } from '@/types/errors.js';
import { redisClient } from '@/config/redis.js';
import { securityLogger } from './logging.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string | undefined;
  created_at: string | undefined;
}

export interface RegisterResult {
  user: AuthUser;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export interface RefreshResult {
  token: string;
  refreshToken: string;
}

export interface WalletChallengeResult {
  challenge: string;
  expiresAt: string;
}

export interface WalletVerifyResult {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

const JWT_SECRET = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'JWT_SECRET not configured');
  return secret;
};

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function signAccessToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET(), { expiresIn: ACCESS_TOKEN_TTL });
}

async function createRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(40).toString('hex');
  const key = `refresh:${token}`;
  if (redisClient) {
    await redisClient.set(key, userId, { EX: REFRESH_TOKEN_TTL_SECONDS });
  } else {
    // Fallback: store in Supabase
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();
    await supabase.from('refresh_tokens').insert({ token, user_id: userId, expires_at: expiresAt });
  }
  return token;
}

async function resolveRefreshToken(token: string): Promise<string> {
  if (redisClient) {
    const userId = await redisClient.get(`refresh:${token}`);
    if (!userId) throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Invalid or expired refresh token');
    return userId;
  }
  // Fallback: Supabase
  const { data, error } = await supabase
    .from('refresh_tokens')
    .select('user_id, expires_at')
    .eq('token', token)
    .single();
  if (error || !data) throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Invalid or expired refresh token');
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from('refresh_tokens').delete().eq('token', token);
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Refresh token expired');
  }
  return data.user_id;
}

async function revokeRefreshToken(token: string): Promise<void> {
  if (redisClient) {
    await redisClient.del(`refresh:${token}`);
  } else {
    await supabase.from('refresh_tokens').delete().eq('token', token);
  }
}

/** Add an access token to the revocation list until its natural expiry. */
export async function revokeAccessToken(token: string): Promise<void> {
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp) {
      const ttl = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0 && redisClient) {
        await redisClient.set(`blocklist:${token}`, '1', { EX: ttl });
      }
    }
  } catch {
    // best-effort
  }
}

/** Check if an access token is revoked. */
export async function isTokenRevoked(token: string): Promise<boolean> {
  if (!redisClient) return false;
  const val = await redisClient.get(`blocklist:${token}`);
  return val !== null;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Register a new user via Supabase Auth.
 *
 * @param email - User's email address.
 * @param password - Plain-text password (Supabase hashes it).
 * @returns ServiceResponse with the created user on success.
 */
export async function registerUser(
  email: string,
  password: string,
): Promise<ServiceResponse<RegisterResult>> {
  if (!email || !password) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Email and password are required',
    );
  }

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    throw new AuthError(AuthErrorCode.USER_ALREADY_EXISTS, error.message);
  }

  if (!data.user) {
    throw new AuthError(
      AuthErrorCode.USER_NOT_FOUND,
      'Registration failed: no user returned',
    );
  }

  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    created_at: data.user.created_at,
  };

  return { success: true, data: { user } };
}

/**
 * Authenticate an existing user and issue a JWT.
 *
 * @param email - User's email address.
 * @param password - Plain-text password.
 * @returns ServiceResponse with a signed JWT and user info on success.
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<ServiceResponse<LoginResult>> {
  if (!email || !password) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Email and password are required',
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    await securityLogger.logAuthEvent('login_failure', undefined, { email });
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, error.message);
  }

  if (!data.user) {
    throw new AuthError(AuthErrorCode.USER_NOT_FOUND, 'Login failed: no user returned');
  }

  const token = signAccessToken(data.user.id);
  const refreshToken = await createRefreshToken(data.user.id);

  await securityLogger.logAuthEvent('login_success', data.user.id);

  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    created_at: data.user.created_at,
  };

  return { success: true, data: { token, refreshToken, user } };
}

/**
 * Generate a wallet challenge for Stellar address authentication.
 *
 * @param stellarAddress - Stellar public key (G...)
 * @returns ServiceResponse with challenge string and expiration
 */
export async function generateWalletChallenge(
  stellarAddress: string,
): Promise<ServiceResponse<WalletChallengeResult>> {
  if (!stellarAddress) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Stellar address is required',
    );
  }

  // Generate a random challenge
  const challenge = Keypair.random().publicKey();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const { error } = await supabase.from('wallet_challenges').insert({
    stellar_address: stellarAddress,
    challenge,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      `Failed to generate challenge: ${error.message}`,
    );
  }

  return {
    success: true,
    data: {
      challenge,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

/**
 * Verify a signed wallet challenge and issue JWT.
 *
 * @param stellarAddress - Stellar public key
 * @param challenge - Challenge string
 * @param signature - Signed challenge (base64)
 * @returns ServiceResponse with JWT and user info
 */
export async function verifyWalletChallenge(
  stellarAddress: string,
  challenge: string,
  signature: string,
): Promise<ServiceResponse<WalletVerifyResult>> {
  if (!stellarAddress || !challenge || !signature) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Stellar address, challenge, and signature are required',
    );
  }

  // Fetch the challenge from database
  const { data: challengeData, error: fetchError } = await supabase
    .from('wallet_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('challenge', challenge)
    .single();

  if (fetchError || !challengeData) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Challenge not found or expired');
  }

  const dbChallenge = challengeData as {
    id: string;
    expires_at: string;
    used: boolean;
  };

  // Check expiration
  if (new Date(dbChallenge.expires_at) < new Date()) {
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Challenge has expired');
  }

  // Check if already used
  if (dbChallenge.used) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Challenge has already been used');
  }

  // Verify signature
  try {
    const keypair = Keypair.fromPublicKey(stellarAddress);
    const signatureBuffer = Buffer.from(signature, 'base64');

    const isValid = keypair.verify(Buffer.from(challenge), signatureBuffer);

    if (!isValid) {
      throw new AuthError(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Invalid signature',
      );
    }
  } catch (err) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      `Signature verification failed: ${String(err)}`,
    );
  }

  // Mark challenge as used
  await supabase
    .from('wallet_challenges')
    .update({ used: true })
    .eq('id', dbChallenge.id);

  // Find or create user with this Stellar address
  let { data: userData, error: userError } = await supabase
    .from('users')
    .select('id, email, created_at')
    .eq('stellar_address', stellarAddress)
    .single();

  if (userError || !userData) {
    // Create new user with Stellar address
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        stellar_address: stellarAddress,
        email: null,
        password_hash: null,
      })
      .select()
      .single();

    if (createError || !newUser) {
      throw new AuthError(
        AuthErrorCode.USER_NOT_FOUND,
        'Failed to create user',
      );
    }

    userData = newUser as { id: string; email: string | null; created_at: string };
  }

  // Issue JWT
  const token = signAccessToken(userData.id);
  const refreshToken = await createRefreshToken(userData.id);

  const user: AuthUser = {
    id: userData.id,
    email: userData.email || undefined,
    created_at: userData.created_at,
  };

  return {
    success: true,
    data: { token, refreshToken, user },
  };
}

/**
 * Issue new access + refresh tokens given a valid refresh token (rotation).
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<ServiceResponse<RefreshResult>> {
  const userId = await resolveRefreshToken(refreshToken);
  await revokeRefreshToken(refreshToken); // rotate
  const token = signAccessToken(userId);
  const newRefreshToken = await createRefreshToken(userId);
  return { success: true, data: { token, refreshToken: newRefreshToken } };
}

/**
 * Logout: revoke both access and refresh tokens.
 */
export async function logoutUser(
  accessToken: string,
  refreshToken: string,
): Promise<ServiceResponse<void>> {
  await Promise.all([
    revokeAccessToken(accessToken),
    revokeRefreshToken(refreshToken),
  ]);
  const decoded = jwt.decode(accessToken) as { userId?: string } | null;
  if (decoded?.userId) await securityLogger.logAuthEvent('logout', decoded.userId);
  return { success: true };
}
