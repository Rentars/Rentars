import { encodeCursor, decodeCursor, buildCursorPage } from '../../src/utils/cursor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// decodeCursor – strict structural validation (issue #482)
// ---------------------------------------------------------------------------

describe('decodeCursor', () => {
  // --- valid cases ---

  it('returns the payload for a valid cursor', () => {
    const payload = { created_at: '2024-01-15T10:00:00.000Z', id: 'abc-123' };
    const cursor = encodeCursor(payload);
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it('returns null for undefined input', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });

  // --- malformed base64 / JSON ---

  it('returns null for non-base64url garbage', () => {
    expect(decodeCursor('!!!not-valid!!!')).toBeNull();
  });

  it('returns null when the decoded value is not valid JSON', () => {
    const bad = Buffer.from('{broken json', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null when the decoded JSON is an array', () => {
    expect(decodeCursor(encode(['created_at', 'id']))).toBeNull();
  });

  it('returns null when the decoded JSON is a primitive', () => {
    expect(decodeCursor(encode(42))).toBeNull();
    expect(decodeCursor(encode('string'))).toBeNull();
    expect(decodeCursor(encode(null))).toBeNull();
  });

  // --- missing required fields ---

  it('returns null when "id" is missing', () => {
    expect(decodeCursor(encode({ created_at: '2024-01-15T10:00:00.000Z' }))).toBeNull();
  });

  it('returns null when "created_at" is missing', () => {
    expect(decodeCursor(encode({ id: 'abc-123' }))).toBeNull();
  });

  it('returns null when both required fields are missing', () => {
    expect(decodeCursor(encode({}))).toBeNull();
  });

  // --- wrong field types ---

  it('returns null when "id" is a number instead of a string', () => {
    expect(decodeCursor(encode({ created_at: '2024-01-15T10:00:00.000Z', id: 99 }))).toBeNull();
  });

  it('returns null when "id" is null', () => {
    expect(decodeCursor(encode({ created_at: '2024-01-15T10:00:00.000Z', id: null }))).toBeNull();
  });

  it('returns null when "created_at" is a number instead of a string', () => {
    expect(decodeCursor(encode({ created_at: 1705312800000, id: 'abc-123' }))).toBeNull();
  });

  it('returns null when "created_at" is a boolean', () => {
    expect(decodeCursor(encode({ created_at: true, id: 'abc-123' }))).toBeNull();
  });

  it('returns null when "created_at" is an object', () => {
    expect(decodeCursor(encode({ created_at: { iso: '2024-01-15' }, id: 'abc-123' }))).toBeNull();
  });

  // --- extra / unexpected fields (issue #482 core requirement) ---

  it('returns null when there is one extra field alongside valid ones', () => {
    expect(
      decodeCursor(
        encode({ created_at: '2024-01-15T10:00:00.000Z', id: 'abc-123', extra: 'sneaky' }),
      ),
    ).toBeNull();
  });

  it('returns null when there are multiple extra fields', () => {
    expect(
      decodeCursor(
        encode({
          created_at: '2024-01-15T10:00:00.000Z',
          id: 'abc-123',
          foo: 1,
          bar: 'baz',
        }),
      ),
    ).toBeNull();
  });

  it('returns null when an extra boolean field is present', () => {
    expect(
      decodeCursor(encode({ created_at: '2024-01-15T10:00:00.000Z', id: 'abc-123', admin: true })),
    ).toBeNull();
  });

  it('returns null when an extra null field is present', () => {
    expect(
      decodeCursor(
        encode({ created_at: '2024-01-15T10:00:00.000Z', id: 'abc-123', role: null }),
      ),
    ).toBeNull();
  });

  // --- round-trip integrity ---

  it('round-trips: encodeCursor → decodeCursor returns the original payload', () => {
    const payload = { created_at: '2025-06-01T00:00:00.000Z', id: 'uuid-xyz-789' };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it('returns only the two expected keys (no prototype pollution)', () => {
    const payload = { created_at: '2025-06-01T00:00:00.000Z', id: 'uuid-xyz-789' };
    const result = decodeCursor(encodeCursor(payload))!;
    expect(Object.keys(result).sort()).toEqual(['created_at', 'id']);
  });
});

// ---------------------------------------------------------------------------
// encodeCursor
// ---------------------------------------------------------------------------

describe('encodeCursor', () => {
  it('produces a base64url string (no padding chars)', () => {
    const encoded = encodeCursor({ created_at: '2024-01-15T10:00:00.000Z', id: 'abc' });
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('encoded value decodes back to original payload', () => {
    const payload = { created_at: '2024-01-15T10:00:00.000Z', id: 'abc' };
    const decoded = JSON.parse(Buffer.from(encodeCursor(payload), 'base64url').toString('utf8'));
    expect(decoded).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// buildCursorPage
// ---------------------------------------------------------------------------

describe('buildCursorPage', () => {
  const makeRow = (id: string, created_at = '2024-01-15T10:00:00.000Z') => ({ id, created_at });

  it('returns all rows and null nextCursor when rows <= limit', () => {
    const rows = [makeRow('1'), makeRow('2')];
    const { data, nextCursor } = buildCursorPage(rows, 5);
    expect(data).toHaveLength(2);
    expect(nextCursor).toBeNull();
  });

  it('slices to limit and encodes nextCursor when rows > limit', () => {
    const rows = [makeRow('1'), makeRow('2'), makeRow('3')];
    const { data, nextCursor } = buildCursorPage(rows, 2);
    expect(data).toHaveLength(2);
    expect(nextCursor).not.toBeNull();
    const decoded = decodeCursor(nextCursor!);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe('2');
  });

  it('returns null nextCursor for an empty result set', () => {
    const { data, nextCursor } = buildCursorPage([], 10);
    expect(data).toHaveLength(0);
    expect(nextCursor).toBeNull();
  });

  it('nextCursor encodes the last item in the sliced page', () => {
    const rows = [makeRow('a', '2024-01-01T00:00:00Z'), makeRow('b', '2024-01-02T00:00:00Z'), makeRow('c', '2024-01-03T00:00:00Z')];
    const { nextCursor } = buildCursorPage(rows, 2);
    const decoded = decodeCursor(nextCursor!)!;
    expect(decoded.id).toBe('b');
    expect(decoded.created_at).toBe('2024-01-02T00:00:00Z');
  });
});
