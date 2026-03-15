import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';

export async function getProperties(_req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('properties').select('*');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
}

export async function getProperty(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('properties').select('*').eq('id', req.params.id).single();
  if (error) { res.status(404).json({ error: 'Property not found' }); return; }
  res.json(data);
}

export async function createProperty(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('properties').insert(req.body).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(201).json(data);
}

export async function updateProperty(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase.from('properties').update(req.body).eq('id', req.params.id).select().single();
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.json(data);
}

export async function deleteProperty(req: Request, res: Response): Promise<void> {
  const { error } = await supabase.from('properties').delete().eq('id', req.params.id);
  if (error) { res.status(400).json({ error: error.message }); return; }
  res.status(204).send();
}
