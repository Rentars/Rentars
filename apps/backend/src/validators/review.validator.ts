import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z
    .string({ required_error: 'bookingId is required' })
    .uuid('bookingId must be a valid UUID'),
  targetId: z
    .string({ required_error: 'targetId is required' })
    .uuid('targetId must be a valid UUID'),
  rating: z
    .number({ required_error: 'rating is required', invalid_type_error: 'rating must be a number' })
    .int('rating must be an integer')
    .min(1, 'Rating must be between 1 and 5')
    .max(5, 'Rating must be between 1 and 5'),
  comment: z.string().max(2000, 'Comment must be at most 2000 characters').optional(),
  propertyId: z.string().uuid('propertyId must be a valid UUID').optional(),
});

export const flagReviewSchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(1, 'Flag reason cannot be blank'),
});
