import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import {
  getFeaturedProperties,
  getAvailabilityRanges,
  setAvailabilityRanges,
  searchProperties,
} from '../services/property.service.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import type { propertySearchSchema } from '../validators/property.validator.js';
import type { z } from 'zod';

// Augment Request to carry the parsed query attached by validateQuery middleware
type SearchRequest = Request & { parsedQuery?: z.infer<typeof propertySearchSchema> };

// ─── List / search ────────────────────────────────────────────────────────────

export async function getProperties(req: SearchRequest, res: Response): Promise<void> {
  try {
    const filters = req.parsedQuery ?? {};
    const result = await searchProperties(filters);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ─── Featured ─────────────────────────────────────────────────────────────────

export async function getFeatured(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getFeaturedProperties();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// ─── Single property ──────────────────────────────────────────────────────────

export async function getProperty(req: Request, res: Response): Promise<void> {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }
  res.json(data);
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createProperty(req: AuthRequest, res: Response): Promise<void> {
  // req.body has already been validated and sanitised by propertySchema middleware
  const payload = { ...req.body, owner_id: req.userId };

  const { data, error } = await supabase
    .from('properties')
    .insert(payload)
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(201).json(data);
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateProperty(req: AuthRequest, res: Response): Promise<void> {
  // Verify ownership before updating
  const { data: existing, error: fetchError } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }

  if ((existing as Record<string, unknown>).owner_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden: you do not own this property' });
    return;
  }

  const { data, error } = await supabase
    .from('properties')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.json(data);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteProperty(req: AuthRequest, res: Response): Promise<void> {
  // Verify ownership before deleting
  const { data: existing, error: fetchError } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }

  if ((existing as Record<string, unknown>).owner_id !== req.userId) {
    res.status(403).json({ error: 'Forbidden: you do not own this property' });
    return;
  }

  const { error } = await supabase.from('properties').delete().eq('id', req.params.id);
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  res.status(204).send();
}

// ─── Availability ─────────────────────────────────────────────────────────────

export async function getAvailability(req: Request, res: Response): Promise<void> {
  try {
    const ranges = await getAvailabilityRanges(req.params.id);
    res.json(ranges);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function setAvailability(req: AuthRequest, res: Response): Promise<void> {
  try {
    const ranges = await setAvailabilityRanges(
      req.params.id,
      req.userId!,
      req.body.ranges,
    );
    res.json(ranges);
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('Forbidden') || message === 'Property not found') {
      res.status(message.startsWith('Forbidden') ? 403 : 404).json({ error: message });
      return;
    }
    res.status(400).json({ error: message });
  }
}
