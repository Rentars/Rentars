import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { disputeEvidenceUpload } from '@/middleware/multer.js';
import {
  downloadDisputeEvidence,
  listDisputeEvidence,
  uploadDisputeEvidence,
} from '@/controllers/disputeEvidence.controller.js';

const router = Router({ mergeParams: true });

// POST /api/v1/bookings/:id/dispute/evidence
router.post('/', authenticate, disputeEvidenceUpload.single('file'), uploadDisputeEvidence);

// GET /api/v1/bookings/:id/dispute/evidence
router.get('/', authenticate, listDisputeEvidence);

// GET /api/v1/bookings/:id/dispute/evidence/:evidenceId/download
router.get('/:evidenceId/download', authenticate, downloadDisputeEvidence);

export default router;
