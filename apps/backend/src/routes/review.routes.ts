import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  createReview,
  getPropertyReviews,
  getUserReviews,
  getUserAverageRating,
} from '../controllers/review.controller.js';
import { createReviewSchema, validateBody } from '../validators/review.validator.js';

const router = Router();

// POST /api/reviews
router.post('/', authenticate, validateBody(createReviewSchema), createReview);

// GET /api/reviews/property/:id
router.get('/property/:id', getPropertyReviews);

// GET /api/reviews/user/:id
router.get('/user/:id', getUserReviews);

// GET /api/reviews/user/:id/average
router.get('/user/:id/average', getUserAverageRating);

export default router;
