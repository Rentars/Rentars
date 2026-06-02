import { Router } from 'express';
import { login, register, refresh, logout } from '@/controllers/auth.controller.js';
import { walletChallenge, walletVerify } from '@/controllers/wallet.controller.js';
import {
  loginSchema,
  registerSchema,
  walletChallengeSchema,
  walletVerifySchema,
  validateBody,
} from '@/validators/auth.validator.js';
import { authRateLimiter } from '@/middleware/rateLimiter.js';
import { authenticate } from '@/middleware/auth.middleware.js';

const router = Router();

// POST /auth/register
router.post('/register', authRateLimiter, validateBody(registerSchema), register);

// POST /auth/login
router.post('/login', authRateLimiter, validateBody(loginSchema), login);

// POST /auth/refresh
router.post('/refresh', authRateLimiter, refresh);

// POST /auth/logout  (auth required to revoke the access token)
router.post('/logout', authenticate, logout);

router.post('/wallet/challenge', authRateLimiter, validateBody(walletChallengeSchema), walletChallenge);
router.post('/wallet/verify', authRateLimiter, validateBody(walletVerifySchema), walletVerify);

export default router;
