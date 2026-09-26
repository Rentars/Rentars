/**
 * Admin audit log endpoints.
 * Restricted to admin users with 'admin:read' scope.
 */

import type { Request, Response } from 'express';
import { auditLogger } from '@/services/auditLogger.service.js';
import type { AuditAction, ResourceType } from '@/services/auditLogger.service.js';

export async function searchAuditLogs(req: Request, res: Response): Promise<void> {
  try {
    const {
      actorId,
      resourceType,
      resourceId,
      action,
      since,
      until,
      limit = 50,
      offset = 0,
    } = req.query as {
      actorId?: string;
      resourceType?: ResourceType;
      resourceId?: string;
      action?: AuditAction;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };

    const filters: Parameters<typeof auditLogger.query>[0] = {};

    if (actorId) filters.actorId = actorId;
    if (resourceType) filters.resourceType = resourceType;
    if (resourceId) filters.resourceId = resourceId;
    if (action) filters.action = action;
    if (since) filters.since = new Date(since);
    if (until) filters.until = new Date(until);

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const result = await auditLogger.query(filters, parsedLimit, parsedOffset);

    res.json({
      data: result.entries,
      pagination: {
        limit: parsedLimit,
        offset: parsedOffset,
        total: result.total,
        hasMore: parsedOffset + parsedLimit < result.total,
      },
    });
  } catch (err) {
    console.error('[auditLog.admin] Search failed:', err);
    res.status(500).json({
      error: {
        code: 'AUDIT_QUERY_FAILED',
        message: 'Failed to query audit logs',
      },
    });
  }
}

export async function getResourceHistory(req: Request, res: Response): Promise<void> {
  try {
    const { resourceType, resourceId, limit = '50' } = req.query as {
      resourceType?: string;
      resourceId?: string;
      limit?: string;
    };

    if (!resourceType || !resourceId) {
      res.status(400).json({
        error: {
          code: 'MISSING_PARAMS',
          message: 'resourceType and resourceId are required',
        },
      });
      return;
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);

    const history = await auditLogger.getResourceHistory(
      resourceType as any,
      resourceId,
      parsedLimit,
    );

    res.json({ data: history });
  } catch (err) {
    console.error('[auditLog.admin] Get resource history failed:', err);
    res.status(500).json({
      error: {
        code: 'AUDIT_QUERY_FAILED',
        message: 'Failed to query audit logs',
      },
    });
  }
}

export async function getActorHistory(req: Request, res: Response): Promise<void> {
  try {
    const { actorId, limit = '50' } = req.query as {
      actorId?: string;
      limit?: string;
    };

    if (!actorId) {
      res.status(400).json({
        error: {
          code: 'MISSING_PARAMS',
          message: 'actorId is required',
        },
      });
      return;
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);

    const history = await auditLogger.getActorHistory(actorId, parsedLimit);

    res.json({ data: history });
  } catch (err) {
    console.error('[auditLog.admin] Get actor history failed:', err);
    res.status(500).json({
      error: {
        code: 'AUDIT_QUERY_FAILED',
        message: 'Failed to query audit logs',
      },
    });
  }
}
