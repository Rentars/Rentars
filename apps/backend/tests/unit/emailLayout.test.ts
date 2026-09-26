/**
 * Unit tests for the shared email layout module.
 *
 * Verifies:
 *  - renderEmail wraps body content in the branded HTML structure
 *  - preference / unsubscribe links appear in optional-email footers
 *  - isEssential emails omit the preference link and show the essential notice
 *  - renderPlaintext produces clean text with no HTML tags
 *  - plaintext includes footer links when provided
 *  - escapeHtml sanitises special characters
 */

import { describe, it, expect, beforeAll } from 'bun:test';

// Set env vars before importing the module under test
beforeAll(() => {
  process.env.FRONTEND_URL = 'https://rentars.app';
});

import {
  renderEmail,
  renderPlaintext,
  escapeHtml,
} from '../../src/services/emailLayout.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('emailLayout', () => {
  // ── renderEmail — HTML structure ─────────────────────────────────────────

  describe('renderEmail — HTML structure', () => {
    it('returns an object with html and text keys', () => {
      const result = renderEmail({ title: 'Test', body: '<p>Hello</p>' });
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('text');
    });

    it('HTML output includes a valid DOCTYPE and <html> root', () => {
      const { html } = renderEmail({ title: 'Hello', body: '<p>World</p>' });
      expect(html).toMatch(/^<!DOCTYPE html>/i);
      expect(html).toContain('<html');
      expect(html).toContain('</html>');
    });

    it('wraps supplied body content inside the layout', () => {
      const { html } = renderEmail({
        title: 'My Email',
        body: '<p data-marker="unique-body-content">Specific content here</p>',
      });
      expect(html).toContain('unique-body-content');
      expect(html).toContain('Specific content here');
    });

    it('includes the Rentars brand name in the header', () => {
      const { html } = renderEmail({ title: 'Brand Test', body: '<p>hi</p>' });
      expect(html).toContain('Rentars');
    });

    it('includes the title in the <title> tag', () => {
      const { html } = renderEmail({ title: 'Reset Password', body: '<p>hi</p>' });
      expect(html).toContain('<title>Reset Password</title>');
    });

    it('includes the preheader text when provided', () => {
      const { html } = renderEmail({
        title: 'T',
        body: '<p>b</p>',
        preheader: 'Hidden preview line',
      });
      expect(html).toContain('Hidden preview line');
    });

    it('falls back to title as preheader when preheader is omitted', () => {
      const { html } = renderEmail({ title: 'Fallback Title', body: '<p>b</p>' });
      expect(html).toContain('Fallback Title');
    });
  });

  // ── renderEmail — optional emails (with preference link) ─────────────────

  describe('renderEmail — optional emails', () => {
    const preferencesUrl = 'https://rentars.app/preferences/manage?token=abc123';

    it('includes the preferences URL when preferencesUrl is provided', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl,
      });
      expect(html).toContain(preferencesUrl);
    });

    it('includes a "Manage preferences" link for optional emails', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl,
      });
      expect(html).toContain('Manage preferences');
    });

    it('includes an "Unsubscribe" link for optional emails', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl,
      });
      expect(html).toContain('Unsubscribe');
    });

    it('does NOT include the essential-email notice for optional emails', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl,
      });
      expect(html).not.toContain('required for account security');
    });

    it('still includes the support link', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl,
      });
      expect(html).toContain('Support');
    });

    it('converts relative preference URLs to absolute', () => {
      const relativeUrl = '/preferences/manage?token=xyz789';
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl: relativeUrl,
      });
      expect(html).toContain('https://rentars.app/preferences/manage?token=xyz789');
    });

    it('leaves absolute preference URLs unchanged', () => {
      const absoluteUrl = 'https://rentars.app/preferences/manage?token=abc123';
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl: absoluteUrl,
      });
      expect(html).toContain(absoluteUrl);
    });

    it('omits preference links when preferencesUrl is undefined', () => {
      const { html } = renderEmail({
        title: 'Booking',
        body: '<p>hi</p>',
        preferencesUrl: undefined,
      });
      expect(html).not.toContain('Manage preferences');
      expect(html).not.toContain('Unsubscribe');
    });
  });

  // ── renderEmail — essential emails ────────────────────────────────────────

  describe('renderEmail — essential emails', () => {
    it('omits manage-preferences and unsubscribe links', () => {
      const { html } = renderEmail({
        title: 'Reset Password',
        body: '<p>click here</p>',
        isEssential: true,
      });
      expect(html).not.toContain('Manage preferences');
      expect(html).not.toContain('Unsubscribe');
    });

    it('includes the essential-email notice', () => {
      const { html } = renderEmail({
        title: 'Verify Email',
        body: '<p>verify</p>',
        isEssential: true,
      });
      expect(html).toContain('essential');
    });

    it('still includes the support link', () => {
      const { html } = renderEmail({
        title: 'Security',
        body: '<p>important</p>',
        isEssential: true,
      });
      expect(html).toContain('Support');
    });
  });

  // ── renderPlaintext ────────────────────────────────────────────────────────

  describe('renderPlaintext', () => {
    it('returns a non-empty string', () => {
      const text = renderPlaintext({ title: 'Hello', body: '<p>World</p>' });
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });

    it('contains no HTML tags', () => {
      const text = renderPlaintext({
        title: 'Test',
        body: '<p><strong>Bold</strong> and <a href="#">link</a></p>',
      });
      expect(text).not.toMatch(/<[^>]+>/);
    });

    it('includes the title', () => {
      const text = renderPlaintext({ title: 'My Title', body: '<p>body</p>' });
      expect(text.toUpperCase()).toContain('MY TITLE');
    });

    it('includes body text content', () => {
      const text = renderPlaintext({ title: 'T', body: '<p>Actual content here</p>' });
      expect(text).toContain('Actual content here');
    });

    it('includes the preferences URL when provided', () => {
      const url = 'https://rentars.app/preferences/manage?token=xyz';
      const text = renderPlaintext({ title: 'T', body: '<p>b</p>', preferencesUrl: url });
      expect(text).toContain(url);
    });

    it('does NOT include preferences URL when isEssential is true', () => {
      const url = 'https://rentars.app/preferences/manage?token=xyz';
      // Essential emails should not receive a preferences URL (caller should not pass one),
      // but even if isEssential is true and no URL is given the text should be clean
      const text = renderPlaintext({ title: 'T', body: '<p>b</p>', isEssential: true });
      expect(text).not.toContain('/preferences/manage');
    });

    it('includes RENTARS branding header', () => {
      const text = renderPlaintext({ title: 'T', body: '<p>b</p>' });
      expect(text).toContain('RENTARS');
    });

    it('includes the support URL', () => {
      const text = renderPlaintext({ title: 'T', body: '<p>b</p>' });
      expect(text).toContain('/support');
    });

    it('converts <br> tags to newlines', () => {
      const text = renderPlaintext({ title: 'T', body: 'Line one<br />Line two' });
      expect(text).toContain('Line one');
      expect(text).toContain('Line two');
    });

    it('converts heading closing tags to newlines', () => {
      const text = renderPlaintext({ title: 'T', body: '<h1>Heading</h1><p>Content</p>' });
      const lines = text.split('\n');
      expect(lines.some(line => line.includes('Heading'))).toBe(true);
      expect(lines.some(line => line.includes('Content'))).toBe(true);
    });

    it('converts paragraph closing tags to newlines', () => {
      const text = renderPlaintext({ title: 'T', body: '<p>Para 1</p><p>Para 2</p>' });
      expect(text).toContain('Para 1');
      expect(text).toContain('Para 2');
      const parts = text.split('\n').filter(line => line.trim().length > 0);
      expect(parts.length).toBeGreaterThanOrEqual(2);
    });

    it('removes script and style tags', () => {
      const text = renderPlaintext({
        title: 'T',
        body: '<p>Content</p><script>alert("xss")</script><p>More</p>',
      });
      expect(text).not.toContain('alert');
      expect(text).not.toContain('script');
      expect(text).toContain('Content');
      expect(text).toContain('More');
    });
  });

  // ── escapeHtml ─────────────────────────────────────────────────────────────

  describe('escapeHtml', () => {
    it('escapes ampersands', () => {
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes less-than signs', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('escapes double quotes', () => {
      expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes single quotes', () => {
      expect(escapeHtml("it's")).toBe("it&#x27;s");
    });

    it('returns plain strings unchanged', () => {
      expect(escapeHtml('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    it('handles a mix of special characters', () => {
      const result = escapeHtml('<div class="x">a & b</div>');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).not.toContain('"');
      expect(result).not.toContain('&a');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });
  });
});
