import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { validateBody } from '../validators/booking.validator.js';
import {
  createReportSchema,
  resolveReportSchema,
  createExportSchema,
} from '../validators/report.validator.js';
import {
  createReport,
  listReportsHandler,
  resolveReportHandler,
  assignReportHandler,
  setSeverityHandler,
  addEvidenceHandler,
  hidePropertyHandler,
  unhidePropertyHandler,
  escalateReportHandler,
  submitAppealHandler,
  reviewAppealHandler,
  getReportImpactHandler,
  createExportHandler,
  listExportsHandler,
  downloadExportHandler,
} from '../controllers/report.controller.js';

const router = Router();

// POST /api/v1/reports — report a listing or review
router.post('/', authenticate, validateBody(createReportSchema), createReport);

// GET /api/v1/reports — list/filter reports (moderator-only)
router.get('/', authenticate, requireRole('admin'), listReportsHandler);

// PATCH /api/v1/reports/:id/resolve — resolve or dismiss a report (moderator-only)
router.patch(
  '/:id/resolve',
  authenticate,
  requireRole('admin'),
  validateBody(resolveReportSchema),
  resolveReportHandler,
);

// ─── Moderation Workflow ──────────────────────────────────────────────────────

// PATCH /api/v1/reports/:id/assign — assign to moderator
router.patch('/:id/assign', authenticate, requireRole('admin'), assignReportHandler);

// PATCH /api/v1/reports/:id/escalate — hand a pending report to senior review
router.patch('/:id/escalate', authenticate, requireRole('admin'), escalateReportHandler);

// PATCH /api/v1/reports/:id/severity — set severity level
router.patch('/:id/severity', authenticate, requireRole('admin'), setSeverityHandler);

// POST /api/v1/reports/:id/evidence — add evidence
router.post('/:id/evidence', authenticate, requireRole('admin'), addEvidenceHandler);

// PATCH /api/v1/reports/:id/hide — hide property from search
router.patch('/:id/hide', authenticate, requireRole('admin'), hidePropertyHandler);

// PATCH /api/v1/reports/:id/unhide — unhide property
router.patch('/:id/unhide', authenticate, requireRole('admin'), unhidePropertyHandler);

// POST /api/v1/reports/:id/appeal — host submits appeal
router.post('/:id/appeal', authenticate, submitAppealHandler);

// PATCH /api/v1/reports/:id/appeal/review — review appeal (moderator-only)
router.patch('/:id/appeal/review', authenticate, requireRole('admin'), reviewAppealHandler);

// GET /api/v1/reports/impact — get report impact stats
router.get('/impact', getReportImpactHandler);

// ─── Report & Analytics Exports ──────────────────────────────────────────────

// POST /api/v1/reports/exports — request a role-scoped export (host or admin)
router.post(
  '/exports',
  authenticate,
  requireRole('host', 'admin'),
  validateBody(createExportSchema),
  createExportHandler,
);

// GET /api/v1/reports/exports — list exports owned by the requesting account
router.get('/exports', authenticate, requireRole('host', 'admin'), listExportsHandler);

// GET /api/v1/reports/exports/:token/download — short-lived, ownership-checked download
router.get(
  '/exports/:token/download',
  authenticate,
  requireRole('host', 'admin'),
  downloadExportHandler,
);

export default router;
