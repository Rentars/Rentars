import type { Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  submitReview,
  getReviewsForProperty,
  getReviewsForUser,
  getAverageRating,
} from '../services/review.service.js';

export async function createReview(req: AuthRequest, res: Response): Promise<void> {
  const { bookingId, targetId, rating, comment, propertyId } = req.body;
  const reviewerId = req.userId;

  if (!reviewerId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await submitReview(bookingId, reviewerId, targetId, rating, comment, propertyId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

export async function getPropertyReviews(req: Request, res: Response): Promise<void> {
  const result = await getReviewsForProperty(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getUserReviews(req: Request, res: Response): Promise<void> {
  const result = await getReviewsForUser(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getUserAverageRating(req: Request, res: Response): Promise<void> {
  const result = await getAverageRating(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ average: result.data });
}
