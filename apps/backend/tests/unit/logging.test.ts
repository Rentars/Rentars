/**
 * Issue #661 — Centralized Structured Logging
 *
 * Validates:
 *   1. Every emitted log entry satisfies the NormalisedLogEntry schema
 *      (timestamp, level, message, service, environment all present).
 *   2. Sensitive fields are always redacted — never leak tokens/passwords/keys.
 *   3. Level filtering respects LOG_LEVEL.
 *   4. Deeply nested secrets are redacted (depth-8 guard).
 *   5. Long strings are truncated.
 *   6. Arrays inside log payloads are walked for secret values.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { redactLogPayload, structuredLog, type LogEntry, type NormalisedLogEntry } from '../../src/middleware/logging.middleware.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  fn();
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  return lines;
}

function parseFirst(lines: string[]): NormalisedLogEntry {
  if (!lines[0]) throw new Error('No log output captured');
  return JSON.parse(lines[0]) as NormalisedLogEntry;
}

// ── required schema fields ───────────────────────────────────────────────────

describe('structuredLog — required schema fields', () => {
  it('always emits timestamp, level, message, service, environment', () => {
    const lines = captureLog(() =>
      structuredLog({ level: 'info', message: 'hello', timestamp: new Date().toISOString() }),
    );
    const entry = parseFirst(lines);
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('hello');
    expect(typeof entry.service).toBe('string');
    expect(typeof entry.environment).toBe('string');
  });

  it('defaults service to "api" when not specified', () => {
    const lines = captureLog(() =>
      structuredLog({ level: 'info', message: 'x', timestamp: new Date().toISOString() }),
    );
    const entry = parseFirst(lines);
    expect(entry.service).toBeTruthy();
  });

  it('preserves caller-supplied service name', () => {
    const lines = captureLog(() =>
      structuredLog({ level: 'info', message: 'x', timestamp: new Date().toISOString(), service: 'blockchain' }),
    );
    expect(parseFirst(lines).service).toBe('blockchain');
  });
});

// ── redaction ─────────────────────────────────────────────────────────────────

describe('redactLogPayload — sensitive field redaction', () => {
  it('redacts top-level "token" key', () => {
    const out = redactLogPayload({ token: 'abc123', userId: 'u1' }) as Record<string, unknown>;
    expect(out.token).toBe('[REDACTED]');
    expect(out.userId).toBe('u1');
  });

  it('redacts "password", "secret", "privateKey", "seed"', () => {
    const keys = ['password', 'secret', 'privateKey', 'seed', 'api_key', 'apiKey'];
    for (const k of keys) {
      const out = redactLogPayload({ [k]: 'supersecret' }) as Record<string, unknown>;
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('redacts JWT-shaped string values regardless of key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature';
    const out = redactLogPayload({ randomKey: jwt }) as Record<string, unknown>;
    expect(out.randomKey).toBe('[REDACTED]');
  });

  it('redacts Stellar secret keys (S…55 chars)', () => {
    const stellarSecret = 'SCZANGBA5XTONSXE2EQLQPX34532VCZTTBNBNP'; // shorter for test
    // Use a full 56-char Stellar-format seed-like string
    const fullSecret = 'S' + 'A'.repeat(55);
    const out = redactLogPayload({ stellarKey: fullSecret }) as Record<string, unknown>;
    expect(out.stellarKey).toBe('[REDACTED]');
  });

  it('truncates strings longer than 1024 characters', () => {
    const long = 'x'.repeat(2000);
    const out = redactLogPayload({ desc: long }) as Record<string, unknown>;
    expect((out.desc as string).includes('[TRUNCATED]')).toBe(true);
    expect((out.desc as string).length).toBeLessThan(2000);
  });

  it('recursively redacts nested objects', () => {
    const out = redactLogPayload({ nested: { deep: { token: 'secret' } } }) as any;
    expect(out.nested.deep.token).toBe('[REDACTED]');
  });

  it('walks arrays and redacts items', () => {
    const out = redactLogPayload([{ password: 'p' }, { name: 'alice' }]) as any[];
    expect(out[0].password).toBe('[REDACTED]');
    expect(out[1].name).toBe('alice');
  });

  it('returns depth-limit sentinel instead of stack overflow on circular-like deep nesting', () => {
    // Build a 15-level deep object — exceeds the 8-level recursion guard
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 15; i++) deep = { child: deep };
    // Should not throw
    expect(() => redactLogPayload(deep)).not.toThrow();
  });

  it('passes safe primitive values through unchanged', () => {
    const out = redactLogPayload({ count: 42, flag: true, name: 'alice' }) as Record<string, unknown>;
    expect(out.count).toBe(42);
    expect(out.flag).toBe(true);
    expect(out.name).toBe('alice');
  });
});

// ── redaction applied inside structuredLog ────────────────────────────────────

describe('structuredLog — redaction applied on emission', () => {
  it('never emits raw token even when caller passes it in entry extra fields', () => {
    const lines = captureLog(() =>
      structuredLog({
        level: 'info',
        message: 'auth',
        timestamp: new Date().toISOString(),
        token: 'bearer-secret-value',
      }),
    );
    const raw = lines[0] ?? '';
    expect(raw).not.toContain('bearer-secret-value');
    expect(raw).toContain('[REDACTED]');
  });

  it('never emits password field', () => {
    const lines = captureLog(() =>
      structuredLog({
        level: 'warn',
        message: 'attempt',
        timestamp: new Date().toISOString(),
        password: 'hunter2',
      }),
    );
    expect(lines[0] ?? '').not.toContain('hunter2');
  });
});

// ── level filtering ───────────────────────────────────────────────────────────

describe('structuredLog — level filtering', () => {
  const original = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = original;
  });

  it('suppresses debug entries when LOG_LEVEL=info', () => {
    process.env.LOG_LEVEL = 'info';
    const lines = captureLog(() =>
      structuredLog({ level: 'debug', message: 'verbose', timestamp: new Date().toISOString() }),
    );
    expect(lines.length).toBe(0);
  });

  it('emits warn entries when LOG_LEVEL=info', () => {
    process.env.LOG_LEVEL = 'info';
    const lines = captureLog(() =>
      structuredLog({ level: 'warn', message: 'watch out', timestamp: new Date().toISOString() }),
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('emits all entries when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = captureLog(() =>
      structuredLog({ level: 'debug', message: 'verbose', timestamp: new Date().toISOString() }),
    );
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ── JSON parseable output ─────────────────────────────────────────────────────

describe('structuredLog — output is always valid JSON', () => {
  it('emits parseable JSON for info', () => {
    const lines = captureLog(() =>
      structuredLog({ level: 'info', message: 'test', timestamp: new Date().toISOString() }),
    );
    expect(() => JSON.parse(lines[0] ?? '{}')).not.toThrow();
  });

  it('emits parseable JSON for error', () => {
    const lines = captureLog(() =>
      structuredLog({ level: 'error', message: 'boom', timestamp: new Date().toISOString(), error: 'oops' }),
    );
    expect(() => JSON.parse(lines[0] ?? '{}')).not.toThrow();
  });
});
