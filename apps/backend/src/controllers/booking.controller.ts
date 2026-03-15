import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export async function getBooking(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('bookings').select('*').eq('id', req.params.id).single();
  if (error) { res.status(404).json({ error: 'Booking not found' }); return; }
  res.json(data);
}

export async function createBooking(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('bookings').insert(req.body).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
}

export async function updateBooking(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('bookings').update(req.body).eq('id', req.params.id).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
}

export async function deleteBooking(req: Request, res: Response): Promise<void> {
  const { error } = await supabase.from('bookings').delete().eq('id', req.params.id);
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(204).send();
}
