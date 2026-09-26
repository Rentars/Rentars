import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  createSavedSearch,
  listSavedSearches,
  deleteSavedSearch,
  pauseSavedSearch,
  resumeSavedSearch,
  updateDigestFrequency,
  updateSavedSearch,
} from '../services/savedSearch.service.js';

export async function create(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { name, filters } = req.body;
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!filters || typeof filters !== 'object') {
    res.status(400).json({ error: 'filters (object) is required' });
    return;
  }

  const result = await createSavedSearch(userId, name, filters);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.status(201).json(result.data);
}

export async function list(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(400).json({ error: 'Unauthorized' }); return; }

  const result = await listSavedSearches(userId);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json(result.data);
}

export async function remove(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await deleteSavedSearch(userId, req.params.id);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.status(204).send();
}

export async function pause(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await pauseSavedSearch(userId, req.params.id);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json(result.data);
}

export async function resume(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await resumeSavedSearch(userId, req.params.id);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json(result.data);
}

export async function updateFrequency(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { frequency } = req.body;
  if (!frequency || !['immediate', 'daily', 'weekly'].includes(frequency)) {
    res.status(400).json({ error: 'Valid frequency required: immediate, daily, or weekly' });
    return;
  }

  const result = await updateDigestFrequency(userId, req.params.id, frequency);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json(result.data);
}

export async function update(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { name, filters } = req.body;
  const updates: Record<string, unknown> = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    updates.name = name.trim();
  }

  if (filters !== undefined) {
    if (typeof filters !== 'object') {
      res.status(400).json({ error: 'filters must be an object' });
      return;
    }
    updates.filters = filters;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'At least one field to update is required' });
    return;
  }

  const result = await updateSavedSearch(userId, req.params.id, updates);
  if (!result.success) { res.status(400).json({ error: result.error }); return; }
  res.json(result.data);
}
