/**
 * Frontend mirror of apps/backend/src/schemas/profile.schema.ts
 */

import { z } from 'zod';

export const ProfileCompletenessSchema = z.object({
  score: z.number().int().min(0),
  maxScore: z.number().int().min(0),
  missingFields: z.array(z.string()),
});

export const UserProfileSchema = z.object({
  user_id: z.string().uuid(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
  phone: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  stellar_address: z.string().nullable().optional(),
  verification_status: z.enum(['unverified', 'verified']).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  completeness: ProfileCompletenessSchema.optional(),
});

export const ProfileUpdateDataSchema = z.object({
  name: z.string().optional(),
  phone: z.string().nullable().optional(),
  avatar_url: z.string().url().nullable().optional(),
  stellar_address: z.string().nullable().optional(),
  expected_updated_at: z.string().datetime().optional(),
});

export type ProfileCompleteness = z.infer<typeof ProfileCompletenessSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type ProfileUpdateData = z.infer<typeof ProfileUpdateDataSchema>;
