import type { Response } from 'express';
import { AnalyticsService } from '@/services/analytics.service.js';
import type { AuthRequest } from '@/middleware/auth.middleware.js';

const analyticsService = new AnalyticsService();

export async function getHostAnalytics(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = await analyticsService.getHostAnalytics(hostId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getTenantAnalytics(req: AuthRequest, res: Response): Promise<void> {
  const tenantId = req.userId;
  if (!tenantId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = await analyticsService.getTenantAnalytics(tenantId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function exportHostEarnings(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = await analyticsService.getHostEarningsExport(hostId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  const format = (req.query.format as string) || 'json';

  if (format === 'csv') {
    const rows = result.data as Record<string, unknown>[];
    if (rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="host-earnings.csv"');
      res.send('');
      return;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => {
          const val = String(row[h] ?? '');
          return val.includes(',') ? `"${val}"` : val;
        }).join(',')
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="host-earnings.csv"');
    res.send(csv);
    return;
  }

  res.json(result.data);
}

export async function exportTenantBookings(req: AuthRequest, res: Response): Promise<void> {
  const tenantId = req.userId;
  if (!tenantId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = await analyticsService.getTenantBookingsExport(tenantId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  const format = (req.query.format as string) || 'json';

  if (format === 'csv') {
    const rows = result.data as Record<string, unknown>[];
    if (rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="tenant-bookings.csv"');
      res.send('');
      return;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => {
          const val = String(row[h] ?? '');
          return val.includes(',') ? `"${val}"` : val;
        }).join(',')
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="tenant-bookings.csv"');
    res.send(csv);
    return;
  }

  res.json(result.data);
}
