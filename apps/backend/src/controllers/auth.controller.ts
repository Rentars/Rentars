import type { Request, Response } from 'express';
import {
  loginUser,
  registerUser,
  generateWalletChallenge,
  verifyWalletChallenge,
  refreshTokens,
  logoutUser,
} from '@/services/auth.service.js';
import { AuthError } from '@/types/errors.js';

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    const result = await registerUser(email, password);
    res.status(201).json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    const result = await loginUser(email, password);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function walletChallenge(req: Request, res: Response): Promise<void> {
  try {
    const { stellar_address } = req.body;
    const result = await generateWalletChallenge(stellar_address);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function walletVerify(req: Request, res: Response): Promise<void> {
  try {
    const { stellar_address, challenge, signature } = req.body;
    const result = await verifyWalletChallenge(stellar_address, challenge, signature);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }
  const result = await refreshTokens(refreshToken);
  res.json(result.data);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const accessToken = req.headers.authorization?.split(' ')[1] ?? '';
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken is required' });
    return;
  }
  await logoutUser(accessToken, refreshToken);
  res.status(204).send();
}
