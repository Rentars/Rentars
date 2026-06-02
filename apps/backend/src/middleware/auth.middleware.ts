import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { isTokenRevoked } from '@/services/auth.service.js';

export interface AuthRequest extends Request {
  userId?: string;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as { userId: string };

    if (await isTokenRevoked(token)) {
      res.status(401).json({ error: 'Token has been revoked' });
      return;
    }

    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
