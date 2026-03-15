import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(201).json({ user: data.user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    res.status(401).json({ error: error.message });
    return;
  }
  const token = jwt.sign(
    { userId: data.user.id },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '7d' }
  );
  res.json({ token, user: data.user });
}
