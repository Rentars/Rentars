/**
 * Tests for the PDF utility — focussed on issue #485:
 * Reject invalid hex colour strings in hexToRgb.
 *
 * Also verifies that PdfBuilder still produces valid PDF output when
 * valid colours are used (regression / smoke tests).
 */

import { describe, it, expect } from 'vitest';
import { PdfBuilder, hexToRgb } from '../utils/pdf.js';

// ─── Issue #485: hexToRgb colour validation ───────────────────────────────────

describe('hexToRgb — colour validation (issue #485)', () => {
  it('correctly parses a valid 6-digit hex colour with #', () => {
    const [r, g, b] = hexToRgb('#2563EB');
    expect(r).toBeCloseTo(0x25 / 255);
    expect(g).toBeCloseTo(0x63 / 255);
    expect(b).toBeCloseTo(0xEB / 255);
  });

  it('correctly parses a valid 6-digit hex colour without #', () => {
    const [r, g, b] = hexToRgb('FF0000');
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it('correctly parses a lowercase hex colour', () => {
    const [r, g, b] = hexToRgb('#aabbcc');
    expect(r).toBeCloseTo(0xaa / 255);
    expect(g).toBeCloseTo(0xbb / 255);
    expect(b).toBeCloseTo(0xcc / 255);
  });

  it('falls back to [0, 0, 0] for a 3-digit shorthand colour (#FFF)', () => {
    // 3-digit values are short; parseInt would silently read partial bytes
    const result = hexToRgb('#FFF');
    expect(result).toEqual([0, 0, 0]);
  });

  it('falls back to [0, 0, 0] for an empty string', () => {
    const result = hexToRgb('');
    expect(result).toEqual([0, 0, 0]);
  });

  it('falls back to [0, 0, 0] for a non-hex string', () => {
    const result = hexToRgb('GGHHII');
    expect(result).toEqual([0, 0, 0]);
  });

  it('falls back to [0, 0, 0] for a partially valid string (4 digits)', () => {
    const result = hexToRgb('#1234');
    expect(result).toEqual([0, 0, 0]);
  });

  it('falls back to [0, 0, 0] for a string with spaces', () => {
    const result = hexToRgb('FF 00 00');
    expect(result).toEqual([0, 0, 0]);
  });

  it('falls back to [0, 0, 0] for a string with a hash only', () => {
    const result = hexToRgb('#');
    expect(result).toEqual([0, 0, 0]);
  });

  it('produces only finite values in the 0–1 range for valid input', () => {
    const colours = ['#000000', '#FFFFFF', '#E5E7EB', '#111827', '#2563EB'];
    for (const c of colours) {
      const [r, g, b] = hexToRgb(c);
      for (const ch of [r, g, b]) {
        expect(Number.isFinite(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });

  it('produces only finite values for all 8-bit boundary colours', () => {
    // White and black are the extremes; ensure no channel is NaN or out of range
    for (const hex of ['#000000', '#FFFFFF']) {
      const rgb = hexToRgb(hex);
      for (const ch of rgb) {
        expect(Number.isFinite(ch)).toBe(true);
      }
    }
  });
});

// ─── PdfBuilder smoke tests — existing valid colours remain unchanged ──────────

describe('PdfBuilder — valid colours produce correct PDF output', () => {
  it('builds a valid PDF buffer starting with %PDF', () => {
    const pdf = new PdfBuilder();
    pdf.text('Hello', 60, 100);
    const buf = pdf.build();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('builds a valid PDF buffer ending with %%EOF', () => {
    const pdf = new PdfBuilder();
    pdf.text('Hello', 60, 100);
    const buf = pdf.build();
    expect(buf.slice(-8).toString()).toContain('%%EOF');
  });

  it('embeds text with a valid colour in the content stream', () => {
    const pdf = new PdfBuilder();
    pdf.text('Colour test', 60, 100, { colour: '#2563EB' });
    const content = pdf.build().toString('latin1');
    // hexToRgb('#2563EB') = [0.145, 0.388, 0.922]
    expect(content).toContain('0.145');
  });

  it('draws a rect with a valid fill colour without NaN in output', () => {
    const pdf = new PdfBuilder();
    pdf.rect(60, 700, 100, 20, { fill: '#FF0000' });
    const content = pdf.build().toString('latin1');
    // R channel of #FF0000 should be 1.000
    expect(content).toContain('1.000');
    expect(content).not.toContain('NaN');
  });

  it('draws a hline with a valid colour without NaN in output', () => {
    const pdf = new PdfBuilder();
    pdf.hline(60, 700, 400, '#E5E7EB');
    const content = pdf.build().toString('latin1');
    expect(content).not.toContain('NaN');
  });

  it('falls back to black (0.000) when an invalid colour is used in text', () => {
    const pdf = new PdfBuilder();
    // Pass a malformed colour — should fall back to [0, 0, 0]
    pdf.text('Fallback', 60, 100, { colour: '#ZZZ' });
    const content = pdf.build().toString('latin1');
    expect(content).not.toContain('NaN');
    // The black fallback produces "0.000 0.000 0.000 rg"
    expect(content).toContain('0.000 0.000 0.000 rg');
  });

  it('falls back to black when an invalid fill colour is used in rect', () => {
    const pdf = new PdfBuilder();
    pdf.rect(60, 700, 100, 20, { fill: 'notacolour' });
    const content = pdf.build().toString('latin1');
    expect(content).not.toContain('NaN');
    expect(content).toContain('0.000 0.000 0.000 rg');
  });
});
