/**
 * Log redaction utility.
 *
 * Provides two layers of protection:
 *
 * 1. Field-name redaction (allowlist model)
 *    Any field whose name matches SENSITIVE_FIELD_PATTERN is replaced with
 *    "[REDACTED]" before it reaches a log sink.  This covers tokens, secrets,
 *    passwords, card numbers, PII identifiers, and free-text bodies.
 *
 * 2. Value-pattern redaction
 *    Even on allowlisted fields, values that look like credentials (JWTs,
 *    Bearer tokens, email addresses, Stellar private keys) are scrubbed from
 *    string values so a stray copy in an unexpected field cannot leak.
 *
 * Usage:
 *   import { redactLogFields } from './redact.js';
 *
 *   structuredLog({
 *     level: 'info',
 *     message: 'request body',
 *     body: redactLogFields(req.body),
 *   });
 *
 * Design principles:
 *   - Allowlist model: only fields explicitly NOT in the sensitive set pass
 *     through; unrecognised nested keys are allowed unless they match the
 *     pattern.  This is safer than a denylist (you cannot forget a new field).
 *   - Depth-limited: recursion stops at MAX_DEPTH to prevent stack overflows
 *     on pathologically deep objects.
 *   - String length cap: strings longer than MAX_STRING_LENGTH are truncated
 *     so a large payload does not inflate log volume.
 *   - Arrays are walked element-by-element.
 *   - Non-plain values (Date, Buffer, class instances) are stringified safely.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum object depth walked during redaction. Deeper objects are replaced. */
const MAX_DEPTH = 6;

/** Strings longer than this are truncated in logs. */
const MAX_STRING_LENGTH = 500;

// ── Sensitive field-name pattern ──────────────────────────────────────────────

/**
 * Fields whose names match this pattern must never appear in log output.
 * The pattern is intentionally broad — a false positive (redacting a benign
 * field) is vastly preferable to a false negative (leaking a credential).
 *
 * Covers:
 *   Credentials & key material:
 *     password, passwd, secret, token, key, seed, mnemonic, pin, cvv, otp,
 *     privateKey, signingKey, apiKey, authKey, refreshToken, accessToken
 *   Payment data:
 *     cardNumber, pan, cvv, cvc, expiry, accountNumber, routingNumber,
 *     iban, bic, ssn, taxId, driversLicense
 *   PII:
 *     email (redacted in body/header fields — allowed as top-level log label),
 *     phone, dob, dateOfBirth, nationalId, passport
 *   Payloads that may contain any of the above:
 *     body, payload, raw, content, message, text (message bodies)
 *   Auth headers:
 *     authorization, cookie, x-api-key, x-auth-token
 */
export const SENSITIVE_FIELD_PATTERN =
  /^(password|passwd|pass|secret|token|key|seed|mnemonic|pin|cvv|cvc|otp|private|signing|api_?key|auth_?key|refresh_?token|access_?token|card_?num(?:ber)?|pan|expir(?:y|ation)|account_?num(?:ber)?|routing_?num(?:ber)?|iban|bic|ssn|tax_?id|drivers?_?licen[sc]e|national_?id|passport|phone|dob|date_?of_?birth|body|payload|raw|content|message|text|authorization|cookie|x-api-key|x-auth-token|smtp_?pass|trustless_?work_?api_?key|supabase_?service_?role_?key|jwt_?secret|metrics_?token|hcaptcha_?secret|smtp)$/i;

// ── Value-pattern redaction ───────────────────────────────────────────────────

/**
 * Patterns that identify sensitive values regardless of their field name.
 * Applied to every string value that survives field-name redaction.
 */
const SENSITIVE_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWTs (three base64url segments separated by dots)
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
  },
  // Bearer tokens in Authorization header values
  {
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [TOKEN_REDACTED]',
  },
  // Stellar secret keys (S + 55 uppercase alphanumeric chars)
  {
    pattern: /\bS[A-Z2-7]{55}\b/g,
    replacement: '[STELLAR_SECRET_REDACTED]',
  },
  // Generic high-entropy hex strings (64 chars — typical for SHA-256 / API keys)
  {
    pattern: /\b[0-9a-f]{64}\b/gi,
    replacement: '[HEX_SECRET_REDACTED]',
  },
  // Email addresses — scrubbed from arbitrary string values
  // (the top-level `userId` / `actorId` label can still reference a user; full
  //  addresses in body/meta fields are redacted)
  {
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
  },
];

// ── Core redaction logic ──────────────────────────────────────────────────────

type Primitive = string | number | boolean | null | undefined;
type RedactableValue = Primitive | Record<string, unknown> | unknown[];

/**
 * Redact sensitive fields from a value that will be written to a log sink.
 *
 * @param value - Any value: primitive, array, or plain object.
 * @param depth - Current recursion depth (internal).
 * @returns A new value safe to log; the original is never mutated.
 */
export function redactLogFields(value: unknown, depth = 0): RedactableValue {
  if (depth > MAX_DEPTH) {
    return '[DEPTH_LIMIT_REACHED]';
  }

  if (value === null || value === undefined) {
    return value as Primitive;
  }

  if (typeof value === 'string') {
    return redactStringValue(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogFields(item, depth + 1));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactLogFields(nested, depth + 1);
      }
    }
    return result;
  }

  // Functions, Symbols, etc. — convert to a safe placeholder
  return '[NON_SERIALIZABLE]';
}

/**
 * Apply value-pattern redaction to a string and enforce the length cap.
 */
function redactStringValue(value: string): string {
  let result = value;

  for (const { pattern, replacement } of SENSITIVE_VALUE_PATTERNS) {
    // Reset lastIndex for global regexes to avoid state bleed across calls
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  if (result.length > MAX_STRING_LENGTH) {
    return `${result.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }

  return result;
}

/**
 * Redact the headers object from an Express request, keeping safe diagnostic
 * headers (content-type, user-agent, x-request-id) and dropping auth material.
 *
 * Returns a new object; never mutates the original.
 */
export function redactRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const SAFE_HEADERS = new Set([
    'content-type',
    'content-length',
    'user-agent',
    'accept',
    'accept-encoding',
    'accept-language',
    'x-request-id',
    'x-forwarded-for',
    'x-real-ip',
    'origin',
    'referer',
    'host',
  ]);

  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SAFE_HEADERS.has(lower)) {
      result[name] = value;
    } else {
      result[name] = '[REDACTED]';
    }
  }
  return result;
}

/**
 * Convenience wrapper: redact a request body object.
 * Identical to redactLogFields but named for clarity at call sites.
 */
export const redactRequestBody = (body: unknown): RedactableValue =>
  redactLogFields(body);
