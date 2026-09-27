/**
 * Unit tests for dispute evidence service — allowlist, visibility, retention.
 */

import { supabase } from '../../src/config/supabase';
import * as storage from '../../src/config/supabase-storage';
import {
  ALLOWED_EVIDENCE_TYPES,
  attachEvidence,
  listEvidenceForModerator,
  listEvidenceForParticipant,
  purgeExpiredEvidence,
  redactEvidenceForParticipant,
  scanEvidenceFile,
} from '../../src/services/disputeEvidence.service';
import { bookingAuthorizationService } from '../../src/services/bookingAuthorization.service';

jest.mock('../../src/config/supabase');
jest.mock('../../src/config/supabase-storage');
jest.mock('../../src/services/bookingAuthorization.service');
jest.mock('../../src/services/auditLogger.service', () => ({
  auditLogger: { log: jest.fn().mockResolvedValue(undefined) },
}));

const mockUpload = storage.uploadDisputeEvidenceObject as jest.Mock;
const mockRemove = storage.removeDisputeEvidenceObject as jest.Mock;

const BOOKING_ID = 'booking-uuid-1';
const USER_ID = 'user-uuid-1';

const sampleRow = {
  id: 'evidence-1',
  booking_id: BOOKING_ID,
  uploader_id: USER_ID,
  evidence_type: 'image',
  storage_path: 'bookings/booking-uuid-1/ev-1/file.webp',
  mime_type: 'image/webp',
  size_bytes: 100,
  visibility: 'participant',
  scan_status: 'clean',
  retention_until: new Date(Date.now() + 86400000).toISOString(),
  anonymized_at: null,
  deleted_at: null,
  metadata: { original_name: 'photo.webp', internal_path: 'secret' },
  created_at: new Date().toISOString(),
};

describe('ALLOWED_EVIDENCE_TYPES', () => {
  it('includes the four permitted evidence types', () => {
    expect(ALLOWED_EVIDENCE_TYPES).toEqual([
      'image',
      'document',
      'message_export',
      'payment_proof',
    ]);
  });
});

describe('scanEvidenceFile', () => {
  it('blocks PE executable magic bytes', async () => {
    const buffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    const result = await scanEvidenceFile(buffer, 'document', 'application/pdf');
    expect(result.scan_status).toBe('blocked');
  });
});

describe('redactEvidenceForParticipant', () => {
  it('removes storage_path and sensitive metadata keys', () => {
    const redacted = redactEvidenceForParticipant(sampleRow as any);
    expect(redacted).not.toHaveProperty('storage_path');
    expect(redacted.metadata).toEqual({ original_name: 'photo.webp' });
  });
});

describe('attachEvidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (bookingAuthorizationService.canDispute as jest.Mock).mockResolvedValue({ allowed: true });
    mockUpload.mockResolvedValue({ path: 'bookings/x/y/z' });
  });

  it('rejects disallowed evidence_type', async () => {
    const file = {
      buffer: Buffer.from('%PDF-1.4'),
      mimetype: 'application/pdf',
      originalname: 'proof.pdf',
    } as Express.Multer.File;

    const result = await attachEvidence(BOOKING_ID, USER_ID, file, 'video' as any, 'participant');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/evidence_type/);
  });
});

describe('listEvidenceForParticipant visibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries only participant-visible clean evidence', async () => {
    (bookingAuthorizationService.canRead as jest.Mock).mockResolvedValue({ allowed: true });

    const eqMock = jest.fn().mockResolvedValue({ data: [sampleRow], error: null });
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnValue({ eq: eqMock }),
    };

    (supabase.from as jest.Mock).mockReturnValue(chain);

    const result = await listEvidenceForParticipant(BOOKING_ID, USER_ID, 'tenant');

    expect(result.success).toBe(true);
    expect(chain.eq).toHaveBeenCalledWith('booking_id', BOOKING_ID);
    expect(chain.eq).toHaveBeenCalledWith('visibility', 'participant');
    expect(result.data?.[0]).not.toHaveProperty('storage_path');
  });
});

describe('listEvidenceForModerator', () => {
  it('returns rows including storage_path for case scope', async () => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: [sampleRow, { ...sampleRow, visibility: 'moderator_only' }], error: null }),
    };

    (supabase.from as jest.Mock).mockReturnValue(chain);

    const result = await listEvidenceForModerator(BOOKING_ID, 'mod-1');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data?.[0].storage_path).toBeDefined();
  });
});

describe('purgeExpiredEvidence retention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRemove.mockResolvedValue(undefined);
  });

  it('anonymizes expired rows when not under legal hold', async () => {
    (supabase.from as jest.Mock)
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lt: jest.fn().mockReturnValue({
            is: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'ev-1',
                      booking_id: BOOKING_ID,
                      storage_path: 'bookings/b/e/file.pdf',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        update: jest.fn().mockReturnValue({
          eq: jest.fn().mockResolvedValue({ error: null }),
        }),
      });

    const result = await purgeExpiredEvidence(10, false);

    expect(result.anonymized).toBe(1);
    expect(mockRemove).toHaveBeenCalledWith('bookings/b/e/file.pdf');
  });

  it('skips rows when booking is under legal hold', async () => {
    (supabase.from as jest.Mock)
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lt: jest.fn().mockReturnValue({
            is: jest.fn().mockReturnValue({
              is: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'ev-2',
                      booking_id: BOOKING_ID,
                      storage_path: 'bookings/b/e/file2.pdf',
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue({ data: [{ id: 'hold-1' }], error: null }),
              }),
            }),
          }),
        }),
      });

    const result = await purgeExpiredEvidence(10, false);

    expect(result.held_skipped).toBe(1);
    expect(result.anonymized).toBe(0);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
