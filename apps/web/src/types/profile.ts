/**
 * Profile types — re-exported from the canonical Zod schema.
 *
 * Import from @/lib/api-schemas/profile.schema to access the Zod validators.
 */

export type {
  UserProfile,
  ProfileUpdateData,
  ProfileCompleteness,
} from '@/lib/api-schemas/profile.schema';

export {
  UserProfileSchema,
  ProfileUpdateDataSchema,
  ProfileCompletenessSchema,
} from '@/lib/api-schemas/profile.schema';
