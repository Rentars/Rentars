import { Router } from 'express';
import {
  createBooking,
  deleteBooking,
  getBooking,
  updateBooking,
} from '../controllers/booking.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.get('/:id', authenticate, getBooking);
router.post('/', authenticate, createBooking);
router.patch('/:id', authenticate, updateBooking);
router.delete('/:id', authenticate, deleteBooking);

export default router;
