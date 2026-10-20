import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { EarningsService } from '@/services/earnings.service.js';
import { SUPPORTED_CURRENCIES } from '@/config/constants.js';

const earningsService = new EarningsService();

/**
 * GET /api/v1/host/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD&currency=USD
 *
 * Returns ledger-derived gross, platform_fees, net, pending, and released
 * earnings for the authenticated host over the requested date range, plus a
 * reconciliation block summarizing the last provider/chain check.
 */
export async function getHostEarnings(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
  };
  if (!from || !to) {
    res.status(422).json({ error: 'from and to query parameters are required (YYYY-MM-DD)' });
    return;
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    res.status(422).json({ error: 'from and to must be valid dates in YYYY-MM-DD format' });
    return;
  }

  if (currency !== undefined) {
    if (typeof currency !== 'string' || !SUPPORTED_CURRENCIES.includes(currency)) {
      res.status(422).json({
        error: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
      });
      return;
    }
  }

  const result = await earningsService.getHostEarnings(hostId, from, to, currency);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}