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
  addAvailabilityBlock,
  removeAvailabilityBlock,
} from '@/controllers/availability.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';
import { requirePropertyOwner } from '@/middleware/rbac.middleware.js';
import { upload } from '@/middleware/multer.js';
import { propertySchema, updatePropertySchema, validateBody } from '@/validators/property.validator.js';

const router = Router();

// GET /api/v1/properties
router.get('/', getProperties);

// GET /api/v1/properties/search?q=...
router.get('/search', searchPropertiesEndpoint);

// GET /api/v1/properties/:id
router.get('/:id', getProperty);

// POST /api/v1/properties
router.post('/', authenticate, validateBody(propertySchema), createPropertyHandler);

// PUT /api/v1/properties/:id  — owner only
router.put('/:id', authenticate, requirePropertyOwner, validateBody(updatePropertySchema), updatePropertyHandler);

// DELETE /api/v1/properties/:id  — owner only
router.delete('/:id', authenticate, requirePropertyOwner, deletePropertyHandler);

// ── Image management ───────────────────────────────────────────────────────────

router.get('/:id/images', listImages);
router.post('/:id/images', authenticate, requirePropertyOwner, upload.single('image'), uploadImage);
router.delete('/:id/images/:imageId', authenticate, requirePropertyOwner, deleteImage);
router.patch('/:id/images/:imageId/primary', authenticate, requirePropertyOwner, setAsPrimary);

// ── Availability management ────────────────────────────────────────────────────

router.get('/:id/availability', getAvailability);
router.post('/:id/availability', authenticate, requirePropertyOwner, addAvailabilityBlock);
router.delete('/:id/availability/:rangeId', authenticate, requirePropertyOwner, removeAvailabilityBlock);

export default router;

