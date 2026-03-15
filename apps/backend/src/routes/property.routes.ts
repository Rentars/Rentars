import { Router } from 'express';
import {
  createProperty,
  deleteProperty,
  getProperties,
  getProperty,
  updateProperty,
} from '../controllers/property.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.get('/', getProperties);
router.get('/:id', getProperty);
router.post('/', authenticate, createProperty);
router.put('/:id', authenticate, updateProperty);
router.delete('/:id', authenticate, deleteProperty);

export default router;
