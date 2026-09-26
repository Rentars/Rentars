import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { create, list, remove, pause, resume, updateFrequency, update } from '../controllers/savedSearch.controller.js';

const router = Router();

// POST /api/v1/saved-searches - create
router.post('/', authenticate, create);

// GET /api/v1/saved-searches - list
router.get('/', authenticate, list);

// PUT /api/v1/saved-searches/:id - update name/filters
router.put('/:id', authenticate, update);

// PATCH /api/v1/saved-searches/:id/pause - pause notifications
router.patch('/:id/pause', authenticate, pause);

// PATCH /api/v1/saved-searches/:id/resume - resume notifications
router.patch('/:id/resume', authenticate, resume);

// PATCH /api/v1/saved-searches/:id/frequency - update digest frequency
router.patch('/:id/frequency', authenticate, updateFrequency);

// DELETE /api/v1/saved-searches/:id - delete
router.delete('/:id', authenticate, remove);

export default router;
