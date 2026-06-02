import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  addPropertyImage,
  getPropertyImages,
  removePropertyImage,
  setPrimaryImage,
} from '@/services/propertyImage.service.js';

export async function uploadImage(req: AuthRequest, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const result = await addPropertyImage(req.params.id, req.userId!, req.file);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

export async function listImages(req: AuthRequest, res: Response): Promise<void> {
  const result = await getPropertyImages(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function deleteImage(req: AuthRequest, res: Response): Promise<void> {
  const result = await removePropertyImage(req.params.id, req.params.imageId, req.userId!);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 404).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

export async function setAsPrimary(req: AuthRequest, res: Response): Promise<void> {
  const result = await setPrimaryImage(req.params.id, req.params.imageId, req.userId!);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
