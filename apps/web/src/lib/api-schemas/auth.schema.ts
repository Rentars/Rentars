/**
 * Frontend mirror of apps/backend/src/schemas/auth.schema.ts
 */

import { z } from 'zod';

export const UserRoleSchema = z.enum(['owner', 'tenant', 'admin']);

export const AuthMeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: UserRoleSchema,
  email_verified: z.boolean().optional(),
  stellar_address: z.string().nullable().optional(),
  created_at: z.string().datetime().optional(),
});

export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

export const AuthSuccessResponseSchema = z.object({
  user: AuthMeResponseSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

export type UserRole = z.infer<typeof UserRoleSchema>;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
export type TokenPair = z.infer<typeof TokenPairSchema>;
export type AuthSuccessResponse = z.infer<typeof AuthSuccessResponseSchema>;
