import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  createReview,
  getPropertyReviews,
  getUserReviews,
  getUserAverageRating,
  respondToReview,
  reportReview,
  reportReviewStructured,
  startModerationHandler,
  moderationActionHandler,
  submitAppealHandler,
  resolveAppealHandler,
  moderateReviewHandler,
  listFlaggedReviews,
  listPendingReviews,
  listModerationQueue,
  listPendingAppeals,
  approveReviewHandler,
  rejectReviewHandler,
  getReviewResponseHistory,
  moderateHostResponseHandler,
  getRepairQueueHandler,
  reconcileReviewsHandler,
  resolveRepairTaskHandler,
} from '../controllers/review.controller.js';
import { validateBody } from '../validators/booking.validator.js';
import {
  createReviewSchema,
  flagReviewSchema,
  reportReviewSchema,
  submitAppealSchema,
  resolveAppealSchema,
  moderationActionSchema,
  rejectReviewSchema,
  resolveRepairTaskSchema,
} from '../validators/review.validator.js';
import { validatePagination } from '../validators/pagination.validator.js';

const router = Router();

// ─── Public / tenant routes ───────────────────────────────────────────────────

// POST /api/v1/reviews — submit a review (tenant only; service checks booking ownership)
router.post('/', authenticate, validateBody(createReviewSchema), createReview);

// GET /api/v1/reviews/property/:id — list approved reviews for a property
router.get('/property/:id', validatePagination, getPropertyReviews);

// GET /api/v1/reviews/user/:id — list approved reviews targeting a user
router.get('/user/:id', validatePagination, getUserReviews);

// GET /api/v1/reviews/user/:id/average — average rating for a user
router.get('/user/:id/average', getUserAverageRating);

// ─── Host response channel ────────────────────────────────────────────────────
//
// Rules (enforced jointly by route + service):
//   - Only authenticated users with role 'host' may attempt a response.
//   - The service further checks that the caller is the current property owner.
//   - One visible response per review; edits are allowed within the 48-hour
//     edit window; removed responses cannot be edited.

// POST /api/v1/reviews/:id/response — host submits or edits their response
router.post('/:id/response', authenticate, requireRole('host', 'admin'), respondToReview);

// GET /api/v1/reviews/:id/response/history — full edit history (admin only)
router.get(
  '/:id/response/history',
  authenticate,
  requireRole('admin', 'moderator'),
  getReviewResponseHistory,
);

// PATCH /api/v1/reviews/:id/response/moderate — approve / reject / remove (admin/moderator)
router.patch(
  '/:id/response/moderate',
  authenticate,
  requireRole('admin', 'moderator'),
  moderateHostResponseHandler,
);

// ─── Reporting ────────────────────────────────────────────────────────────────

// POST /api/v1/reviews/:id/flag — legacy flag (any authenticated user)
router.post('/:id/flag', authenticate, validateBody(flagReviewSchema), reportReview);

// POST /api/v1/reviews/:id/report — structured report with policy reason code
router.post('/:id/report', authenticate, validateBody(reportReviewSchema), reportReviewStructured);

// ─── Appeals ─────────────────────────────────────────────────────────────────

// POST /api/v1/reviews/:id/appeal — submit an appeal (review author only; enforced in service)
router.post('/:id/appeal', authenticate, validateBody(submitAppealSchema), submitAppealHandler);

// PATCH /api/v1/reviews/:id/appeal/resolve — resolve a pending appeal (admin)
router.patch(
  '/:id/appeal/resolve',
  authenticate,
  requireRole('admin', 'moderator'),
  validateBody(resolveAppealSchema),
  resolveAppealHandler,
);

// ─── Moderation queue (admin / moderator) ─────────────────────────────────────

// GET /api/v1/reviews/moderation/flagged
router.get('/moderation/flagged', authenticate, requireRole('admin', 'moderator'), listFlaggedReviews);

// GET /api/v1/reviews/moderation/pending
router.get('/moderation/pending', authenticate, requireRole('admin', 'moderator'), listPendingReviews);

// GET /api/v1/reviews/moderation/queue
router.get('/moderation/queue', authenticate, requireRole('admin', 'moderator'), listModerationQueue);

// GET /api/v1/reviews/moderation/appeals
router.get('/moderation/appeals', authenticate, requireRole('admin', 'moderator'), listPendingAppeals);

// PATCH /api/v1/reviews/:id/moderate — simple approve/reject toggle (admin)
router.patch('/:id/moderate', authenticate, requireRole('admin', 'moderator'), moderateReviewHandler);

// POST /api/v1/reviews/:id/approve
router.post('/:id/approve', authenticate, requireRole('admin', 'moderator'), approveReviewHandler);

// POST /api/v1/reviews/:id/reject
router.post(
  '/:id/reject',
  authenticate,
  requireRole('admin', 'moderator'),
  validateBody(rejectReviewSchema),
  rejectReviewHandler,
);

// PATCH /api/v1/reviews/:id/moderation/start
router.patch(
  '/:id/moderation/start',
  authenticate,
  requireRole('admin', 'moderator'),
  startModerationHandler,
);

// POST /api/v1/reviews/:id/moderation-action — hide / remove / keep
router.post(
  '/:id/moderation-action',
  authenticate,
  requireRole('admin', 'moderator'),
  validateBody(moderationActionSchema),
  moderationActionHandler,
);

// ─── Sync / repair queue (admin) ──────────────────────────────────────────────

// GET /api/v1/reviews/sync/repair-queue
router.get('/sync/repair-queue', authenticate, requireRole('admin'), getRepairQueueHandler);

// POST /api/v1/reviews/sync/reconcile
router.post('/sync/reconcile', authenticate, requireRole('admin'), reconcileReviewsHandler);

// POST /api/v1/reviews/sync/repair/:id/resolve
router.post(
  '/sync/repair/:id/resolve',
  authenticate,
  requireRole('admin'),
  validateBody(resolveRepairTaskSchema),
  resolveRepairTaskHandler,
);

export default router;
