import { Router } from 'express';
import {
  createProperty,
  deleteProperty,
  getFeatured,
  getAvailability,
  getProperties,
  getProperty,
  setAvailability,
  updateProperty,
} from '../controllers/property.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  propertySchema,
  propertySearchSchema,
  updatePropertySchema,
  validateBody,
  validateQuery,
} from '../validators/property.validator.js';
import { z } from 'zod';

const router = Router();

// ── Public routes ─────────────────────────────────────────────────────────────

// GET /api/properties?city=&country=&min_price=&max_price=&amenities=&...
router.get('/', validateQuery(propertySearchSchema), getProperties);

// GET /api/properties/featured
router.get('/featured', getFeatured);

// GET /api/properties/:id
router.get('/:id', getProperty);

// GET /api/properties/:id/availability
router.get('/:id/availability', getAvailability);

// ── Authenticated routes ──────────────────────────────────────────────────────

// POST /api/properties
router.post('/', authenticate, validateBody(propertySchema), createProperty);

// PUT /api/properties/:id
router.put('/:id', authenticate, validateBody(updatePropertySchema), updateProperty);

// DELETE /api/properties/:id
router.delete('/:id', authenticate, deleteProperty);

// PUT /api/properties/:id/availability  (owner sets blocked date ranges)
const availabilityRangeSchema = z.object({
  ranges: z.array(
    z.object({
      start_date: z.string().date('start_date must be a valid ISO date'),
      end_date: z.string().date('end_date must be a valid ISO date'),
    }),
  ),
});

router.put(
  '/:id/availability',
  authenticate,
  validateBody(availabilityRangeSchema),
  setAvailability,
);

export default router;
