import { Router } from 'express';
import {
  createPropertyHandler,
  deletePropertyHandler,
  getProperties,
  getProperty,
  updatePropertyHandler,
} from '@/controllers/property.controller.js';
import {
  uploadImage,
  listImages,
  deleteImage,
  setAsPrimary,
} from '@/controllers/propertyImage.controller.js';
import {
  getAvailability,
  checkAvailabilityWindow,
  addAvailabilityBlock,
  removeAvailabilityBlock,
} from '@/controllers/availability.controller.js';
import {
  getPriceBreakdown,
  listPricingRules,
  addPricingRule,
  removePricingRule,
  getSettings,
  updateSettings,
} from '@/controllers/pricing.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';
import { upload } from '@/middleware/multer.js';

const router = Router();

// ── Property CRUD ──────────────────────────────────────────────────────────────

router.get('/', getProperties);
router.get('/:id', getProperty);
router.post('/', authenticate, createPropertyHandler);
router.put('/:id', authenticate, updatePropertyHandler);
router.delete('/:id', authenticate, deletePropertyHandler);

// ── Image management ───────────────────────────────────────────────────────────

router.get('/:id/images', listImages);
router.post('/:id/images', authenticate, upload.single('image'), uploadImage);
router.delete('/:id/images/:imageId', authenticate, deleteImage);
router.patch('/:id/images/:imageId/primary', authenticate, setAsPrimary);

// ── Availability management ────────────────────────────────────────────────────

// GET  /api/v1/properties/:id/availability               — list blocked ranges
router.get('/:id/availability', getAvailability);

// GET  /api/v1/properties/:id/availability/check?check_in=&check_out=  — full check
router.get('/:id/availability/check', checkAvailabilityWindow);

// POST   /api/v1/properties/:id/availability             — block dates (owner)
router.post('/:id/availability', authenticate, addAvailabilityBlock);

// DELETE /api/v1/properties/:id/availability/:rangeId    — unblock (owner)
router.delete('/:id/availability/:rangeId', authenticate, removeAvailabilityBlock);

// ── Pricing ────────────────────────────────────────────────────────────────────

// GET  /api/v1/properties/:id/pricing?check_in=&check_out=  — price breakdown
router.get('/:id/pricing', getPriceBreakdown);

// GET  /api/v1/properties/:id/pricing/rules              — list rules
router.get('/:id/pricing/rules', listPricingRules);

// POST   /api/v1/properties/:id/pricing/rules            — create rule (owner)
router.post('/:id/pricing/rules', authenticate, addPricingRule);

// DELETE /api/v1/properties/:id/pricing/rules/:ruleId    — delete rule (owner)
router.delete('/:id/pricing/rules/:ruleId', authenticate, removePricingRule);

// ── Property settings (min/max stay) ──────────────────────────────────────────

// GET /api/v1/properties/:id/settings
router.get('/:id/settings', getSettings);

// PUT /api/v1/properties/:id/settings    (owner only)
router.put('/:id/settings', authenticate, updateSettings);

export default router;
