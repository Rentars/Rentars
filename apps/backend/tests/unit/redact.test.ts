/**
 * Unit tests for the log redaction utility (src/utils/redact.ts).
 *
 * Acceptance criteria verified here:
 *   ✓ Sensitive fields are removed before logging (field-name redaction)
 *   ✓ JWT and Bearer tokens are scrubbed from string values
 *   ✓ Email addresses in body/meta fields are scrubbed
 *   ✓ Stellar secret keys are scrubbed
 *   ✓ Allowlisted (safe) fields are preserved unchanged
 *   ✓ Nested objects and arrays are walked recursively
 *   ✓ Depth limit prevents stack overflows
 *   ✓ String length cap truncates large payloads
 *   ✓ Primitives and null/undefined pass through safely
 *   ✓ Request header redaction keeps safe diagnostic headers
 *   ✓ Synthetic credentials and PII are removed in integration-style scenarios
 */

import { describe, it, expect } from 'bun:test';
import {
  redactLogFields,
  redactRequestHeaders,
  redactRequestBody,
  SENSITIVE_FIELD_PATTERN,
} from '../../src/utils/redact.js';

// ── SENSITIVE_FIELD_PATTERN ───────────────────────────────────────────────────

describe('SENSITIVE_FIELD_PATTERN', () => {
  const shouldRedact = [
    'password', 'Password', 'PASSWORD',
    'passwd', 'pass',
    'secret', 'secretKey', 'api_secret',
    'token', 'accessToken', 'refreshToken', 'access_token', 'refresh_token',
    'key', 'apiKey', 'api_key', 'signingKey', 'authKey',
    'seed', 'mnemonic',
    'pin', 'cvv', 'cvc', 'otp',
    'private', 'privateKey',
    'cardNumber', 'card_num', 'pan',
    'ssn', 'taxId', 'tax_id',
    'nationalId', 'passport',
    'phone', 'dob', 'dateOfBirth', 'date_of_birth',
    'body', 'payload', 'raw', 'content', 'message', 'text',
    'authorization', 'cookie',
    'x-api-key', 'x-auth-token',
    'smtp_pass', 'smtp',
    'jwt_secret', 'metrics_token', 'hcaptcha_secret',
    'supabase_service_role_key', 'trustless_work_api_key',
  ];

  const shouldAllow = [
    'userId', 'actorId', 'requestId', 'correlationId',
    'bookingId', 'propertyId', 'tenantId',
    'method', 'path', 'route', 'status',
    'durationMs', 'timestamp', 'level',
    'ip', 'userAgent',
    'action', 'resourceType', 'resourceId',
    'success', 'error',
    'fromStatus', 'toStatus', 'txHash',
    'name', 'role', 'amount',
  ];

  for (const field of shouldRedact) {
    it(`matches sensitive field: "${field}"`, () => {
      expect(SENSITIVE_FIELD_PATTERN.test(field)).toBe(true);
    });
  }

  for (const field of shouldAllow) {
    it(`does not match safe field: "${field}"`, () => {
      expect(SENSITIVE_FIELD_PATTERN.test(field)).toBe(false);
    });
  }
});

// ── Field-name redaction ──────────────────────────────────────────────────────

describe('redactLogFields — field-name redaction', () => {
  it('redacts a password field', () => {
    const result = redactLogFields({ username: 'alice', password: 'hunter2' }) as Record<string, unknown>;
    expect(result.username).toBe('alice');
    expect(result.password).toBe('[REDACTED]');
  });

  it('redacts token, secret, key fields', () => {
    const result = redactLogFields({
      token: 'abc',
      secret: 'xyz',
      apiKey: '123',
    }) as Record<string, unknown>;
    expect(result.token).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
  });

  it('redacts case-insensitively', () => {
    const result = redactLogFields({ PASSWORD: 'secret', Token: 'tok' }) as Record<string, unknown>;
    expect(result.PASSWORD).toBe('[REDACTED]');
    expect(result.Token).toBe('[REDACTED]');
  });

  it('preserves safe fields unchanged', () => {
    const result = redactLogFields({
      userId: 'user-1',
      requestId: 'req-abc',
      method: 'POST',
      path: '/auth/login',
      status: 200,
      durationMs: 42,
    }) as Record<string, unknown>;

    expect(result.userId).toBe('user-1');
    expect(result.requestId).toBe('req-abc');
    expect(result.method).toBe('POST');
    expect(result.path).toBe('/auth/login');
    expect(result.status).toBe(200);
    expect(result.durationMs).toBe(42);
  });

  it('redacts nested sensitive fields', () => {
    const result = redactLogFields({
      user: {
        id: 'user-1',
        password: 'should-be-gone',
        profile: {
          name: 'Alice',
          ssn: '123-45-6789',
        },
      },
    }) as Record<string, unknown>;

    const user = result.user as Record<string, unknown>;
    expect(user.id).toBe('user-1');
    expect(user.password).toBe('[REDACTED]');

    const profile = user.profile as Record<string, unknown>;
    expect(profile.name).toBe('Alice');
    expect(profile.ssn).toBe('[REDACTED]');
  });

  it('redacts sensitive fields inside arrays', () => {
    const result = redactLogFields([
      { userId: 'u1', token: 'tok1' },
      { userId: 'u2', token: 'tok2' },
    ]) as Array<Record<string, unknown>>;

    expect(result[0].userId).toBe('u1');
    expect(result[0].token).toBe('[REDACTED]');
    expect(result[1].userId).toBe('u2');
    expect(result[1].token).toBe('[REDACTED]');
  });

  it('handles null and undefined gracefully', () => {
    expect(redactLogFields(null)).toBeNull();
    expect(redactLogFields(undefined)).toBeUndefined();
  });

  it('passes through number and boolean primitives', () => {
    expect(redactLogFields(42)).toBe(42);
    expect(redactLogFields(true)).toBe(true);
    expect(redactLogFields(false)).toBe(false);
  });

  it('replaces excessively deep objects with a placeholder', () => {
    // Build an object 8 levels deep (exceeds MAX_DEPTH of 6)
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 8; i++) deep = { nested: deep };
    const result = redactLogFields(deep) as Record<string, unknown>;
    // Should eventually hit the depth limit
    expect(JSON.stringify(result)).toContain('DEPTH_LIMIT_REACHED');
  });

  it('truncates strings over 500 characters', () => {
    const longString = 'a'.repeat(600);
    const result = redactLogFields({ notes: longString }) as Record<string, unknown>;
    const notes = result.notes as string;
    expect(notes.length).toBeLessThan(600);
    expect(notes).toContain('TRUNCATED');
  });
});

// ── Value-pattern redaction ───────────────────────────────────────────────────

describe('redactLogFields — value-pattern redaction', () => {
  it('scrubs a JWT from an allowlisted field', () => {
    // A real-looking JWT in a field that is NOT on the sensitive list
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1LTEifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    const result = redactLogFields({ debugInfo: fakeJwt }) as Record<string, unknown>;
    expect(result.debugInfo).not.toContain('eyJ');
    expect(result.debugInfo).toContain('JWT_REDACTED');
  });

  it('scrubs a Bearer token value', () => {
    const result = redactLogFields({
      incomingHeader: 'Bearer sk_live_abc123xyz',
    }) as Record<string, unknown>;
    expect(result.incomingHeader).not.toContain('sk_live_abc123xyz');
    expect(result.incomingHeader).toContain('TOKEN_REDACTED');
  });

  it('scrubs a Stellar secret key (starts with S)', () => {
    const stellarSecret = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5';
    const result = redactLogFields({ debugStellar: stellarSecret }) as Record<string, unknown>;
    expect(result.debugStellar).not.toContain(stellarSecret);
    expect(result.debugStellar).toContain('STELLAR_SECRET_REDACTED');
  });

  it('scrubs a 64-char hex string (high-entropy secret)', () => {
    const hexSecret = 'a'.repeat(64);
    const result = redactLogFields({ checksum: hexSecret }) as Record<string, unknown>;
    expect(result.checksum).not.toBe(hexSecret);
    expect(result.checksum).toContain('HEX_SECRET_REDACTED');
  });

  it('scrubs email addresses from string values', () => {
    const result = redactLogFields({
      notes: 'Contact user@example.com for details',
    }) as Record<string, unknown>;
    expect(result.notes).not.toContain('user@example.com');
    expect(result.notes).toContain('EMAIL_REDACTED');
  });

  it('leaves a Stellar public key (starts with G) untouched', () => {
    const publicKey = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3';
    const result = redactLogFields({ stellarAddress: publicKey }) as Record<string, unknown>;
    // Public keys do not match the secret-key pattern
    expect(result.stellarAddress).toBe(publicKey);
  });
});

// ── Synthetic credential scenario (acceptance criterion) ─────────────────────

describe('redactLogFields — synthetic credential and PII scenarios', () => {
  it('removes a full registration payload with password, email body, and token', () => {
    const registrationBody = {
      email: 'alice@example.com',
      password: 'Super$ecret1!',
      confirmPassword: 'Super$ecret1!',
      inviteToken: 'inv_abc123def456',
    };

    const result = redactLogFields(registrationBody) as Record<string, unknown>;

    // Sensitive fields must be [REDACTED]
    expect(result.password).toBe('[REDACTED]');
    expect(result.confirmPassword).toBe('[REDACTED]');
    expect(result.inviteToken).toBe('[REDACTED]');

    // Email is a sensitive field name in body context
    expect(result.email).toBe('[REDACTED]');
  });

  it('removes payment card data from a payment body', () => {
    const paymentBody = {
      cardNumber: '4111111111111111',
      cvv: '123',
      expiry: '12/26',
      bookingId: 'booking-uuid-here',
      amountStroops: 1000000,
    };

    const result = redactLogFields(paymentBody) as Record<string, unknown>;

    expect(result.cardNumber).toBe('[REDACTED]');
    expect(result.cvv).toBe('[REDACTED]');
    expect(result.expiry).toBe('[REDACTED]');
    // Safe fields preserved
    expect(result.bookingId).toBe('booking-uuid-here');
    expect(result.amountStroops).toBe(1000000);
  });

  it('removes an SSN and passport number from a KYC-style object', () => {
    const kycData = {
      userId: 'u-123',
      ssn: '123-45-6789',
      passport: 'AB1234567',
      countryCode: 'US',
    };

    const result = redactLogFields(kycData) as Record<string, unknown>;
    expect(result.ssn).toBe('[REDACTED]');
    expect(result.passport).toBe('[REDACTED]');
    expect(result.userId).toBe('u-123');
    expect(result.countryCode).toBe('US');
  });

  it('scrubs JWT embedded in a provider response body field', () => {
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

    const providerResponse = {
      status: 'success',
      // "data" is not a sensitive field name — but its value contains a JWT
      data: {
        sessionToken: fakeJwt, // sessionToken IS sensitive → field-name redaction
      },
    };

    const result = redactLogFields(providerResponse) as Record<string, unknown>;
    const data = result.data as Record<string, unknown>;
    expect(data.sessionToken).toBe('[REDACTED]');
  });

  it('does not redact safe audit-log fields used by auditLogger.service', () => {
    const auditEntry = {
      timestamp: '2026-11-21T00:00:00.000Z',
      correlation_id: 'corr-uuid',
      actor_id: 'user-uuid',
      action: 'booking.create',
      resource_type: 'booking',
      resource_id: 'booking-uuid',
      success: true,
      ip: '192.168.1.1',
    };

    const result = redactLogFields(auditEntry) as Record<string, unknown>;

    expect(result.timestamp).toBe(auditEntry.timestamp);
    expect(result.correlation_id).toBe(auditEntry.correlation_id);
    expect(result.actor_id).toBe(auditEntry.actor_id);
    expect(result.action).toBe(auditEntry.action);
    expect(result.resource_type).toBe(auditEntry.resource_type);
    expect(result.resource_id).toBe(auditEntry.resource_id);
    expect(result.success).toBe(true);
    expect(result.ip).toBe(auditEntry.ip);
  });
});

// ── redactRequestHeaders ──────────────────────────────────────────────────────

describe('redactRequestHeaders', () => {
  it('keeps safe diagnostic headers', () => {
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
      'x-request-id': 'req-123',
      'accept': 'application/json',
      'host': 'api.rentars.app',
    };

    const result = redactRequestHeaders(headers);
    expect(result['content-type']).toBe('application/json');
    expect(result['user-agent']).toBe('Mozilla/5.0');
    expect(result['x-request-id']).toBe('req-123');
    expect(result['accept']).toBe('application/json');
    expect(result['host']).toBe('api.rentars.app');
  });

  it('redacts Authorization header', () => {
    const headers = {
      'authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.test.sig',
      'content-type': 'application/json',
    };

    const result = redactRequestHeaders(headers);
    expect(result['authorization']).toBe('[REDACTED]');
    expect(result['content-type']).toBe('application/json');
  });

  it('redacts cookie header', () => {
    const headers = { cookie: 'session=abc123; csrf=def456' };
    const result = redactRequestHeaders(headers);
    expect(result['cookie']).toBe('[REDACTED]');
  });

  it('redacts custom x-api-key header', () => {
    const headers = {
      'x-api-key': 'secretkey123',
      'x-request-id': 'req-abc',
    };
    const result = redactRequestHeaders(headers);
    expect(result['x-api-key']).toBe('[REDACTED]');
    expect(result['x-request-id']).toBe('req-abc');
  });

  it('handles undefined header values without throwing', () => {
    const headers = {
      'content-type': undefined,
      'authorization': undefined,
    };
    expect(() => redactRequestHeaders(headers)).not.toThrow();
  });
});

// ── redactRequestBody ─────────────────────────────────────────────────────────

describe('redactRequestBody', () => {
  it('is an alias for redactLogFields and produces the same output', () => {
    const body = { username: 'bob', password: 'pass123' };
    const a = redactLogFields(body) as Record<string, unknown>;
    const b = redactRequestBody(body) as Record<string, unknown>;
    expect(b.username).toBe(a.username);
    expect(b.password).toBe(a.password);
  });
});
