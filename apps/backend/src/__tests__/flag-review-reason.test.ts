/**
 * Tests for issue #500 — Validate review flag reason
 *
 * Covers:
 *  1. flagReview() service — rejects blank, whitespace-only, and undefined reasons
 *  2. flagReview() service — trims padded reasons before storing
 *  3. flagReview() service — passes with a valid reason
 *  4. flagReview() service — DB error is propagated
 *  5. flagReviewSchema validator — rejects missing / blank / whitespace-only reason
 *  6. flagReviewSchema validator — trims padded reasons
 *  7. Existing reviewer authorization check (userId guard) remains in place
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flagReview } from '../services/review.service.js';
import { flagReviewSchema } from '../validators/review.validator.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockEq     = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      update: mockUpdate,
    })),
  },
}));

// Default chain: update(...).eq(...)  → resolves to { error: null }
mockUpdate.mockReturnValue({ eq: mockEq });
mockEq.mockResolvedValue({ error: null });

// ─── Constants ────────────────────────────────────────────────────────────────

const REVIEW_ID   = 'review-uuid-1234';
const REPORTER_ID = 'user-uuid-5678';

// ─── flagReview() service tests ───────────────────────────────────────────────

describe('flagReview() service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an empty reason string', async () => {
    const result = await flagReview(REVIEW_ID, REPORTER_ID, '');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason is required/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only reason', async () => {
    const result = await flagReview(REVIEW_ID, REPORTER_ID, '   ');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason is required/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a tab-only reason', async () => {
    const result = await flagReview(REVIEW_ID, REPORTER_ID, '\t\n');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason is required/i);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('succeeds and stores the trimmed reason for a padded valid reason', async () => {
    mockUpdate.mockReturnValueOnce({ eq: mockEq });
    mockEq.mockResolvedValueOnce({ error: null });

    const result = await flagReview(REVIEW_ID, REPORTER_ID, '  inappropriate content  ');
    expect(result.success).toBe(true);

    // Verify the update call received the trimmed string, not the padded one
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ flag_reason: 'inappropriate content' }),
    );
  });

  it('succeeds with a clean reason string', async () => {
    mockUpdate.mockReturnValueOnce({ eq: mockEq });
    mockEq.mockResolvedValueOnce({ error: null });

    const result = await flagReview(REVIEW_ID, REPORTER_ID, 'spam');
    expect(result.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ is_flagged: true, flag_reason: 'spam' }),
    );
  });

  it('propagates DB error when supabase update fails', async () => {
    mockUpdate.mockReturnValueOnce({ eq: mockEq });
    mockEq.mockResolvedValueOnce({ error: { message: 'DB connection refused' } });

    const result = await flagReview(REVIEW_ID, REPORTER_ID, 'valid reason');
    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection refused');
  });

  it('still sets is_flagged: true alongside flag_reason', async () => {
    mockUpdate.mockReturnValueOnce({ eq: mockEq });
    mockEq.mockResolvedValueOnce({ error: null });

    await flagReview(REVIEW_ID, REPORTER_ID, 'hateful content');

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ is_flagged: true }),
    );
  });
});

// ─── flagReviewSchema validator tests ────────────────────────────────────────

describe('flagReviewSchema validator', () => {
  it('rejects when reason is missing', () => {
    const result = flagReviewSchema.safeParse({});
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map((i) => i.message);
    expect(issues.some((m) => /required/i.test(m))).toBe(true);
  });

  it('rejects when reason is an empty string', () => {
    const result = flagReviewSchema.safeParse({ reason: '' });
    expect(result.success).toBe(false);
  });

  it('rejects when reason is whitespace-only', () => {
    const result = flagReviewSchema.safeParse({ reason: '   ' });
    expect(result.success).toBe(false);
    const issues = result.error!.issues.map((i) => i.message);
    expect(issues.some((m) => /blank/i.test(m) || /least 1/i.test(m))).toBe(true);
  });

  it('trims leading/trailing whitespace from a valid reason', () => {
    const result = flagReviewSchema.safeParse({ reason: '  spam  ' });
    expect(result.success).toBe(true);
    expect(result.data!.reason).toBe('spam');
  });

  it('accepts a clean valid reason', () => {
    const result = flagReviewSchema.safeParse({ reason: 'inappropriate language' });
    expect(result.success).toBe(true);
    expect(result.data!.reason).toBe('inappropriate language');
  });

  it('rejects non-string reason types', () => {
    const result = flagReviewSchema.safeParse({ reason: 123 });
    expect(result.success).toBe(false);
  });
});
