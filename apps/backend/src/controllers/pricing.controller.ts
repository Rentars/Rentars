import type { Request, Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  calculatePrice,
  getPricingRules,
  createPricingRule,
  deletePricingRule,
  getPropertySettings,
  upsertPropertySettings,
} from '@/services/pricing.service.js';

/** GET /api/v1/properties/:id/pricing?check_in=&check_out= — price breakdown */
export async function getPriceBreakdown(req: Request, res: Response): Promise<void> {
  const { check_in, check_out } = req.query as { check_in?: string; check_out?: string };

  if (!check_in || !check_out) {
    res.status(400).json({ error: 'check_in and check_out query parameters are required' });
    return;
  }

  const result = await calculatePrice(req.params.id, check_in, check_out);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** GET /api/v1/properties/:id/pricing/rules — list pricing rules */
export async function listPricingRules(req: Request, res: Response): Promise<void> {
  const result = await getPricingRules(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** POST /api/v1/properties/:id/pricing/rules — create a pricing rule (owner only) */
export async function addPricingRule(req: AuthRequest, res: Response): Promise<void> {
  const result = await createPricingRule(req.params.id, req.userId!, req.body);
  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

/** DELETE /api/v1/properties/:id/pricing/rules/:ruleId — delete a pricing rule (owner only) */
export async function removePricingRule(req: AuthRequest, res: Response): Promise<void> {
  const result = await deletePricingRule(req.params.id, req.params.ruleId, req.userId!);
  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 404;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

/** GET /api/v1/properties/:id/settings — get property settings */
export async function getSettings(req: Request, res: Response): Promise<void> {
  const result = await getPropertySettings(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** PUT /api/v1/properties/:id/settings — update property settings (owner only) */
export async function updateSettings(req: AuthRequest, res: Response): Promise<void> {
  const result = await upsertPropertySettings(req.params.id, req.userId!, req.body);
  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
