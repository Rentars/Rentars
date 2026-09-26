import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { structuredLog } from './logging.middleware.js';

export interface CsrfRequest extends Request {
  csrfToken?: string;
}

const CSRF_TOKEN_LENGTH = 32;
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const CSRF_COOKIE_NAME = '__Host-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

export function csrfMiddleware(req: CsrfRequest, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();

  if (SAFE_METHODS.has(method)) {
    const token = generateCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600000,
      path: '/',
      signed: false,
    });
    req.csrfToken = token;
    return next();
  }

  const tokenFromHeader = req.headers[CSRF_HEADER_NAME.toLowerCase()];
  const tokenFromCookie = req.cookies?.[CSRF_COOKIE_NAME];

  if (!tokenFromHeader || !tokenFromCookie) {
    structuredLog({
      level: 'warn',
      message: 'CSRF token missing',
      timestamp: new Date().toISOString(),
      method,
      path: req.path,
      hasHeader: !!tokenFromHeader,
      hasCookie: !!tokenFromCookie,
    });
    res.status(403).json({
      error: {
        code: 'CSRF_TOKEN_MISSING',
        message: 'CSRF token is required for state-changing requests',
      },
    });
    return;
  }

  if (tokenFromHeader !== tokenFromCookie) {
    structuredLog({
      level: 'warn',
      message: 'CSRF token mismatch',
      timestamp: new Date().toISOString(),
      method,
      path: req.path,
    });
    res.status(403).json({
      error: {
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token validation failed',
      },
    });
    return;
  }

  next();
}

export function csrfTokenMiddleware(req: CsrfRequest, res: Response, next: NextFunction): void {
  const token = generateCsrfToken();
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 3600000,
    path: '/',
    signed: false,
  });
  req.csrfToken = token;
  next();
}
