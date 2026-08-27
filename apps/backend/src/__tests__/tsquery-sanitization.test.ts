/**
 * Tests for tsquery punctuation sanitization in toTsQuery (property.service.ts)
 *
 * Covers #424:
 *  - Tsquery operator characters (&, |, !, (, ), :, *) are stripped
 *  - Ampersand-separated terms like "sea & sun" become two safe tokens
 *  - Parentheses in input cannot alter query grouping
 *  - A normal phrase produces the expected prefix-match tsquery
 *  - An all-punctuation input returns an empty string (no query)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock supabase before any service import so createClient never runs
vi.mock('../config/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// Mock cache so no Redis connection is needed
vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

import { toTsQuery } from '../services/property.service.js';

describe('#424 toTsQuery punctuation escaping', () => {
  it('strips the & operator so "sea & sun" becomes two safe tokens', () => {
    const result = toTsQuery('sea & sun');
    // "&" is a standalone whitespace-delimited token → stripped to "" → filtered out
    // "sea" and "sun" survive as alphanumeric tokens
    expect(result).toBe('sea:* & sun:*');
    // Crucially: the "&" between tokens comes from our own join, not from user input
  });

  it('strips parentheses so they cannot alter query structure', () => {
    const result = toTsQuery('(beach house)');
    // Parens stripped from each token, leaving "beach" and "house"
    expect(result).toBe('beach:* & house:*');
  });

  it('produces correct prefix-match syntax for a plain phrase', () => {
    const result = toTsQuery('cozy apartment');
    expect(result).toBe('cozy:* & apartment:*');
  });

  it('strips the | operator', () => {
    const result = toTsQuery('villa | cottage');
    // "|" token stripped to "" → filtered; "villa" and "cottage" survive
    expect(result).toBe('villa:* & cottage:*');
  });

  it('strips the ! negation operator', () => {
    const result = toTsQuery('!basement villa');
    // "!" stripped from "!basement" → "basement"
    expect(result).toBe('basement:* & villa:*');
  });

  it('strips the * wildcard from user input (we control prefix matching ourselves)', () => {
    const result = toTsQuery('apart*');
    expect(result).toBe('apart:*');
  });

  it('strips the : operator to prevent label injection', () => {
    const result = toTsQuery('cat:A dog');
    // "cat:A" → stripped to "cata" (only a-z0-9 kept)
    expect(result).toBe('cata:* & dog:*');
  });

  it('returns empty string for all-punctuation input', () => {
    const result = toTsQuery('& | ! ( ) : *');
    expect(result).toBe('');
  });

  it('returns empty string for an empty input', () => {
    expect(toTsQuery('')).toBe('');
  });

  it('is case-insensitive (lowercases tokens)', () => {
    const result = toTsQuery('Beach House');
    expect(result).toBe('beach:* & house:*');
  });
});
