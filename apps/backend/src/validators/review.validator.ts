import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';

export const createReviewSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  targetId: z.string().uuid('targetId must be a valid UUID'),
  propertyId: z.string().uuid('propertyId must be a valid UUID').optional(),
  rating: z.number().int().min(1, 'rating must be between 1 and 5').max(5, 'rating must be between 1 and 5'),
  comment: z.string().min(1).max(1000, 'comment must be at most 1000 characters').trim().optional(),
});

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(422).json({
        error: 'Validation failed',
        details: result.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
