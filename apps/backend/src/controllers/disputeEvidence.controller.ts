import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  attachEvidence,
  getEvidenceDownloadUrl,
  listEvidenceForModerator,
  listEvidenceForParticipant,
  type EvidenceType,
  type EvidenceVisibility,
  ALLOWED_EVIDENCE_TYPES,
} from '@/services/disputeEvidence.service.js';

export async function uploadDisputeEvidence(req: AuthRequest, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const evidenceType = req.body?.evidence_type as EvidenceType;
  const visibility = (req.body?.visibility as EvidenceVisibility) ?? 'participant';

  if (!evidenceType || !ALLOWED_EVIDENCE_TYPES.includes(evidenceType)) {
    res.status(400).json({
      error: `evidence_type is required and must be one of: ${ALLOWED_EVIDENCE_TYPES.join(', ')}`,
    });
    return;
  }

  const result = await attachEvidence(
    req.params.id,
    req.userId!,
    req.file,
    evidenceType,
    visibility,
  );

  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 400;
    res.status(status).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function listDisputeEvidence(req: AuthRequest, res: Response): Promise<void> {
  const role = req.user?.role;
  const isModerator = role === 'admin' || role === 'moderator';

  const result = isModerator
    ? await listEvidenceForModerator(req.params.id, req.userId!)
    : await listEvidenceForParticipant(req.params.id, req.userId!, role);

  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function downloadDisputeEvidence(req: AuthRequest, res: Response): Promise<void> {
  const result = await getEvidenceDownloadUrl(
    req.params.id,
    req.params.evidenceId,
    req.userId!,
    req.user?.role,
    { ip: req.ip },
  );

  if (!result.success) {
    const status =
      result.error === 'Evidence not found'
        ? 404
        : result.error?.startsWith('Forbidden')
          ? 403
          : 400;
    res.status(status).json({ error: result.error });
    return;
  }

  res.json(result.data);
}
