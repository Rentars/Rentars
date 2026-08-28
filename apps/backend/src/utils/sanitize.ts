/**
 * Input sanitization for user-generated content (UGC).
 *
 * Strategy: sanitize-on-write so stored data is always clean, and the
 * React frontend (which escapes by default) is protected even without an
 * extra client-side step.
 *
 * Allowed formatting: plain text with preserved line breaks (CRLF/LF
 * normalised to LF). All HTML tags and attributes are stripped so no
 * injected markup can reach a browser renderer.
 *
 * This module intentionally has no external dependencies so it works in
 * any Node/Bun environment without polyfills.
 */

// ---------------------------------------------------------------------------
// Dangerous protocol list (used to strip javascript: / data: / vbscript: etc.)
// ---------------------------------------------------------------------------
const DANGEROUS_PROTOCOLS = /^(javascript|data|vbscript|blob):/i;

/**
 * Strip ALL HTML tags from a string.
 * Also decodes common HTML entities that could disguise tags.
 */
function stripTags(input: string): string {
  // Decode common entities first so &lt;script&gt; → <script> is caught
  const decoded = input
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const codePoint = Number(code);
      // Reject out-of-range values: valid Unicode is 0x000000–0x10FFFF.
      // Also reject C0/C1 control characters (0x00–0x1F, 0x7F–0x9F) that
      // have no legitimate use in user-visible text and can inject
      // malformed bytes or evade subsequent tag-stripping (issue #481).
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0x20 ||        // below space: control chars
        (codePoint >= 0x7F && codePoint <= 0x9F) || // DEL + C1 controls
        codePoint > 0x10FFFF ||    // beyond Unicode range
        (codePoint >= 0xD800 && codePoint <= 0xDFFF) // surrogate range
      ) {
        return match; // leave the entity as-is
      }
      return String.fromCodePoint(codePoint);
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      const codePoint = parseInt(hex, 16);
      // Apply the same validity checks as the decimal entity handler.
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0x20 ||
        (codePoint >= 0x7F && codePoint <= 0x9F) ||
        codePoint > 0x10FFFF ||
        (codePoint >= 0xD800 && codePoint <= 0xDFFF)
      ) {
        return match; // leave the entity as-is
      }
      return String.fromCodePoint(codePoint);
    });

  // Remove everything that looks like a tag (including multi-line tags)
  // eslint-disable-next-line no-control-regex
  return decoded.replace(/<[^>]*>/gs, '');
}

/**
 * Remove dangerous protocol prefixes from a string value.
 */
function stripDangerousProtocols(input: string): string {
  // Collapse whitespace that might be used to evade prefix detection
  const compact = input.replace(/[\t\r\n ]/g, '');
  if (DANGEROUS_PROTOCOLS.test(compact)) {
    return '';
  }
  return input;
}

/**
 * Normalise line endings to LF and remove null bytes and other control chars
 * that have no legitimate use in user-visible text.
 */
function normaliseWhitespace(input: string): string {
  return (
    input
      // Normalise CRLF → LF
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Remove null bytes and other dangerous control chars (keep \t and \n)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SanitizeOptions {
  /** Maximum allowed length in characters (default: 10 000) */
  maxLength?: number;
}

/**
 * Sanitize a single UGC string field.
 *
 * - Strips all HTML tags (and entity-encoded equivalents)
 * - Removes dangerous protocol prefixes (javascript:, data:, …)
 * - Normalises line endings; removes control characters
 * - Trims leading/trailing whitespace
 * - Truncates to `maxLength` (default 10 000)
 *
 * Returns an empty string for null/undefined input.
 */
export function sanitizeText(
  input: unknown,
  options: SanitizeOptions = {},
): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return '';

  const maxLength = options.maxLength ?? 10_000;

  let clean = input;
  clean = normaliseWhitespace(clean);
  clean = stripTags(clean);
  clean = stripDangerousProtocols(clean);
  clean = clean.trim();
  clean = clean.slice(0, maxLength);

  return clean;
}

/**
 * Sanitize a short UGC field (titles, names) — no multi-line, max 500 chars.
 */
export function sanitizeShortText(input: unknown, maxLength = 500): string {
  const clean = sanitizeText(input, { maxLength });
  // Collapse all newlines/tabs to a single space for single-line fields
  return clean.replace(/[\n\t]+/g, ' ');
}

/**
 * Sanitize a long-form UGC field (descriptions, review comments).
 * Preserves newlines; default max 10 000 chars.
 */
export function sanitizeLongText(input: unknown, maxLength = 10_000): string {
  return sanitizeText(input, { maxLength });
}

/**
 * Sanitize a host response or message (medium length, ~2000 chars).
 */
export function sanitizeResponse(input: unknown, maxLength = 2_000): string {
  return sanitizeText(input, { maxLength });
}
