import { Router } from 'express';
import {
  geocodeHandler,
  locationSearchHandler,
} from '../controllers/location.controller.js';

const router = Router();

// GET /api/locations/geocode?address=... or ?lat=...&lng=...
router.get('/geocode', geocodeHandler);

// GET /api/locations/search?lat=...&lng=...&radius=...
router.get('/search', locationSearchHandler);

export default router;
