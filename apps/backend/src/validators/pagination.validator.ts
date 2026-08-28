import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const result = paginationSchema.safeParse(req.query);
  if (!result.success) {
    res.status(400).json({ error: 'page and pageSize must be positive integers; pageSize must not exceed 100' });
    return;
  }
  (req as Request & { parsedPagination: { page: number; pageSize: number } }).parsedPagination = {
    page: result.data.page,
    pageSize: Math.min(result.data.pageSize ?? result.data.limit ?? 20, 100),
  };
  next();
}