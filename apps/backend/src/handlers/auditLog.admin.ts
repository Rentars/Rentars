/**
 * Admin audit log endpoints.
 * Restricted to admin users with 'admin:read' scope.
 */

import type { Request, Response } from 'express';
import { auditLogger } from '@/services/auditLogger.service.js';
import type { AuditAction, ResourceType } from '@/services/auditLogger.service.js';

/**
 * Narrow scope required to read audit logs. No other scope grants access.
 */
export const AUDIT_READ_SCOPE = 'admin:audit:read';

/**
 * Maximum window (in ms) allowed for a single audit query. Requests must
 * supply a bounded time range so operators never scan the whole table.
 */
const MAX_TIME_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function hasAuditReadScope(req: Request): boolean {
  const scopes = (req as any).auth?.scopes ?? (req as any).user?.scopes ?? [];
  return Array.isArray(scopes) && scopes.includes(AUDIT_READ_SCOPE);
}

function denyForbidden(res: Response): void {
  res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'Audit log access requires the admin:audit:read scope',
    },
  });
}

function badRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function searchAuditLogs(req: Request, res: Response): Promise<void> {
  if (!hasAuditReadScope(req)) {
    denyForbidden(res);
    return;
  }

  try {
    const {
      actorId,
      action,
      targetType,
      targetId,
      since,
      until,
      page = '1',
      pageSize = String(DEFAULT_PAGE_SIZE),
    } = req.query as {
      actorId?: string;
      action?: AuditAction;
      targetType?: ResourceType;
      targetId?: string;
      since?: string;
      until?: string;
      page?: string;
      pageSize?: string;
    };

    const sinceDate = parseDate(since);
    const untilDate = parseDate(until);

    // Require a bounded time range.
    if (!sinceDate || !untilDate) {
      badRequest(
        res,
        'MISSING_TIME_RANGE',
        'A bounded time range (since and until) is required',
      );
      return;
    }
    if (sinceDate > untilDate) {
      badRequest(res, 'INVALID_TIME_RANGE', 'since must be before until');
      return;
    }
    if (untilDate.getTime() - sinceDate.getTime() > MAX_TIME_RANGE_MS) {
      badRequest(
        res,
        'TIME_RANGE_TOO_LARGE',
        'Time range must not exceed 90 days',
      );
      return;
    }

    // Require at least one specific filter beyond the time range.
    if (!actorId && !action && !targetType && !targetId) {
      badRequest(
        res,
        'MISSING_FILTER',
        'At least one of actorId, action, targetType, or targetId is required',
      );
      return;
    }

    const parsedPage = parsePositiveInt(page, 1);
    const parsedPageSize = Math.min(
      parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );

    const result = await auditLogger.listAuditLogs({
      actorId,
      action,
      targetType,
      targetId,
      since: sinceDate,
      until: untilDate,
      page: parsedPage,
      pageSize: parsedPageSize,
    });

    res.json({
      data: result.entries,
      pagination: {
        page: parsedPage,
        pageSize: parsedPageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / parsedPageSize),
        hasMore: parsedPage * parsedPageSize < result.total,
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
  if (!hasAuditReadScope(req)) {
    denyForbidden(res);
    return;
  }

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
  if (!hasAuditReadScope(req)) {
    denyForbidden(res);
    return;
  }

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
