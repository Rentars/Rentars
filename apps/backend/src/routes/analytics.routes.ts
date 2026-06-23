import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import {
  getHostAnalytics,
  getTenantAnalytics,
  exportHostEarnings,
  exportTenantBookings,
} from '@/controllers/analytics.controller.js';

const router = Router();

// GET /api/analytics/host  — host earnings, booking stats, performance
router.get('/host', authenticate, getHostAnalytics);

// GET /api/analytics/tenant  — tenant spending, booking history stats
router.get('/tenant', authenticate, getTenantAnalytics);

// GET /api/analytics/host/export?format=csv|json
router.get('/host/export', authenticate, exportHostEarnings);

// GET /api/analytics/tenant/export?format=csv|json
router.get('/tenant/export', authenticate, exportTenantBookings);

export default router;
