import { Router } from 'express';
import { login, register, requestReset, confirmReset, refreshAccessToken, logout, logoutAllDevices, verifyEmailHandler, resendVerificationHandler } from '@/controllers/auth.controller.js';
import {
  walletChallenge,
  walletVerify,
  walletLinkChallenge,
  walletLink,
  walletUnlinkChallenge,
  walletUnlink,
} from '@/controllers/wallet.controller.js';
import {
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  walletChallengeSchema,
  walletVerifySchema,
  walletUnlinkSchema,
  validateBody,
} from '@/validators/auth.validator.js';
import {
  createAuthRouteLimiter,
  emailFromBody,
  stellarAddressFromBody,
  userFromRequest,
} from '@/middleware/authRateLimit.middleware.js';
import { captchaMiddleware } from '@/middleware/captcha.middleware.js';
import { authenticate } from '@/middleware/auth.middleware.js';

const router = Router();

// Each route has its own budget, keyed by identity class:
//  - anonymous callers are keyed by the trusted-proxy-resolved client IP
//  - authenticated callers are keyed by their user id (never by spoofable headers)
//  - where an account identifier is in the body, an additional per-account bucket applies
// See authRateLimit.middleware.ts for limits and failure policy.
const registerLimiter = createAuthRouteLimiter({ name: 'register', accountKey: emailFromBody });
const loginLimiter = createAuthRouteLimiter({ name: 'login', accountKey: emailFromBody });
const refreshLimiter = createAuthRouteLimiter({ name: 'refresh', userKey: userFromRequest });
const passwordResetRequestLimiter = createAuthRouteLimiter({ name: 'password-reset-request', accountKey: emailFromBody });
const passwordResetConfirmLimiter = createAuthRouteLimiter({ name: 'password-reset-confirm' });
const verifyEmailLimiter = createAuthRouteLimiter({ name: 'verify-email' });
const verifyEmailResendLimiter = createAuthRouteLimiter({ name: 'verify-email-resend', accountKey: emailFromBody });
const walletChallengeLimiter = createAuthRouteLimiter({ name: 'wallet-challenge', accountKey: stellarAddressFromBody });
const walletVerifyLimiter = createAuthRouteLimiter({ name: 'wallet-verify', accountKey: stellarAddressFromBody });
const walletLinkLimiter = createAuthRouteLimiter({ name: 'wallet-link', accountKey: stellarAddressFromBody, userKey: userFromRequest });
const walletUnlinkLimiter = createAuthRouteLimiter({ name: 'wallet-unlink', userKey: userFromRequest });

// POST /api/v1/auth/register — CAPTCHA required
router.post('/register', registerLimiter, validateBody(registerSchema), captchaMiddleware, register);

// POST /api/v1/auth/login — CAPTCHA required
router.post('/login', loginLimiter, validateBody(loginSchema), captchaMiddleware, login);

// POST /api/v1/auth/refresh — rotate access token using refresh token
router.post('/refresh', refreshLimiter, refreshAccessToken);

// POST /api/v1/auth/logout — revoke refresh token
router.post('/logout', refreshLimiter, logout);

// POST /api/v1/auth/logout-all-devices — revoke all refresh tokens for user
router.post('/logout-all-devices', authenticate, refreshLimiter, logoutAllDevices);

// Current identity and server-side role (#916).
router.get('/me', authenticate, getCurrentUserHandler);

// POST /api/v1/auth/verify-email — confirm email address with token
router.post('/verify-email', verifyEmailLimiter, validateBody(verifyEmailSchema), verifyEmailHandler);

// POST /api/v1/auth/verify-email/resend — rate limited per IP and per address; enumeration-safe
router.post('/verify-email/resend', verifyEmailResendLimiter, validateBody(resendVerificationSchema), resendVerificationHandler);

// POST /api/v1/auth/password-reset/request — CAPTCHA required
router.post('/password-reset/request', passwordResetRequestLimiter, validateBody(requestPasswordResetSchema), captchaMiddleware, requestReset);

// POST /api/v1/auth/password-reset/confirm
router.post('/password-reset/confirm', passwordResetConfirmLimiter, validateBody(confirmPasswordResetSchema), confirmReset);

router.post('/wallet/challenge', walletChallengeLimiter, validateBody(walletChallengeSchema), walletChallenge);
router.post('/wallet/verify', walletVerifyLimiter, validateBody(walletVerifySchema), walletVerify);

// Linking and unlinking require an authenticated session plus a fresh signed challenge.
router.post('/wallet/link/challenge', authenticate, walletLinkLimiter, validateBody(walletChallengeSchema), walletLinkChallenge);
router.post('/wallet/link', authenticate, walletLinkLimiter, validateBody(walletVerifySchema), walletLink);
router.post('/wallet/unlink/challenge', authenticate, walletUnlinkLimiter, walletUnlinkChallenge);
router.post('/wallet/unlink', authenticate, walletUnlinkLimiter, validateBody(walletUnlinkSchema), walletUnlink);

export default router;
