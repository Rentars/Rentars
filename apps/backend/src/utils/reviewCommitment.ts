import { createHash, randomBytes } from 'crypto';

/**
 * Privacy-safe, deterministic commitment for on-chain review references.
 *
 * The commitment is computed as:
 *   sha256(reviewId + bookingId + propertyId + rating + nonce)
 *
 * The nonce is a server-generated random value that is stored off-chain only.
 * Publishing the commitment on-chain therefore does not reveal the review
 * content, the reviewer identity, or any other personal data. Because the
 * commitment is deterministic for a given (review, booking, property, rating,
 * nonce) tuple, the same review always maps to the same commitment, which lets
 * the review service and the sync service detect duplicate submissions.
 */

export interface CommitmentInput {
  /** Off-chain review identifier. */
  reviewId: string;
  /** Identifier of the completed booking the review is bound to. */
  bookingId: string;
  /** Identifier of the property the booking (and review) belongs to. */
  propertyId: string;
  /** Rating submitted with the review. */
  rating: number;
  /** Server-generated random nonce stored off-chain. */
  nonce: string;
}

const NONCE_BYTES = 32;

/**
 * Generates a cryptographically secure random nonce.
 *
 * The nonce must be persisted off-chain alongside the review record and must
 * never be published on-chain. It is what makes the commitment unpredictable
 * to third parties while keeping it deterministic for the server.
 */
export function generateNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`reviewCommitment: "${field}" must be a non-empty string`);
  }
}

function assertValidRating(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('reviewCommitment: "rating" must be a finite number');
  }
}

function normalizeInput(input: CommitmentInput): CommitmentInput {
  if (!input || typeof input !== 'object') {
    throw new Error('reviewCommitment: input must be an object');
  }

  assertNonEmptyString(input.reviewId, 'reviewId');
  assertNonEmptyString(input.bookingId, 'bookingId');
  assertNonEmptyString(input.propertyId, 'propertyId');
  assertValidRating(input.rating);
  assertNonEmptyString(input.nonce, 'nonce');

  return {
    reviewId: input.reviewId,
    bookingId: input.bookingId,
    propertyId: input.propertyId,
    rating: input.rating,
    nonce: input.nonce,
  };
}

/**
 * Builds the deterministic, privacy-safe commitment for a review.
 *
 * The same inputs always produce the same commitment, so duplicate on-chain
 * submissions for the same review can be detected by comparing commitments.
 */
export function buildCommitment(input: CommitmentInput): string {
  const { reviewId, bookingId, propertyId, rating, nonce } = normalizeInput(input);

  const payload = `${reviewId}${bookingId}${propertyId}${rating}${nonce}`;

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Verifies that a previously stored commitment matches the commitment derived
 * from the given review data.
 *
 * Returns `false` (rather than throwing) when the provided commitment is not a
 * well-formed value, so callers can treat mismatches as a normal outcome.
 */
export function verifyCommitment(input: CommitmentInput, commitment: string): boolean {
  if (typeof commitment !== 'string' || commitment.length === 0) {
    return false;
  }

  let expected: string;
  try {
    expected = buildCommitment(input);
  } catch {
    return false;
  }

  return timingSafeEqualHex(expected, commitment);
}

/**
 * Constant-time comparison for hex-encoded digests of equal length.
 * Falls back to a length check for inputs that are not valid hex.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}