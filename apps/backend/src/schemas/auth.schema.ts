/**
 * Canonical Zod schemas for Auth API shapes.
 *
 * Keep in sync with openapi.json #/components/schemas/Auth*.
 */

import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const UserRoleSchema = z.enum(['owner', 'tenant', 'admin']);

// ── User identity returned by GET /auth/me ────────────────────────────────────

export const AuthMeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: UserRoleSchema,
  email_verified: z.boolean().optional(),
  stellar_address: z.string().nullable().optional(),
  created_at: z.string().datetime().optional(),
});

// ── Token pair returned by /auth/login, /auth/register, /auth/refresh ─────────

export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

// ── Full auth success response (login / register) ─────────────────────────────

export const AuthSuccessResponseSchema = z.object({
  user: AuthMeResponseSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

// ── Refresh token request ─────────────────────────────────────────────────────

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type UserRole = z.infer<typeof UserRoleSchema>;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
export type TokenPair = z.infer<typeof TokenPairSchema>;
export type AuthSuccessResponse = z.infer<typeof AuthSuccessResponseSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
