import { describe, it, expect } from 'vitest';
import { generateNonce, escapeJsonForEmbed, escapeHtml, buildCsp } from '../../views/webviewToolkit';

describe('webviewToolkit', () => {
  describe('generateNonce', () => {
    it('returns a 32-character string', () => {
      const n = generateNonce();
      expect(n).toHaveLength(32);
    });

    it('returns different values on each call', () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a).not.toBe(b);
    });
  });

  describe('escapeJsonForEmbed', () => {
    it('escapes angle brackets and ampersands', () => {
      const result = escapeJsonForEmbed({ html: '<script>alert("xss")</script>' });
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result).toContain('\\u003c');
      expect(result).toContain('\\u003e');
    });
  });

  describe('escapeHtml', () => {
    it('escapes special HTML characters', () => {
      expect(escapeHtml('<b>"hello" & \'world\'</b>')).toBe('&lt;b&gt;&quot;hello&quot; &amp; \'world\'&lt;/b&gt;');
    });
  });

  describe('buildCsp', () => {
    it('builds CSP with nonce', () => {
      const csp = buildCsp('abc123');
      expect(csp).toContain("'nonce-abc123'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("style-src 'unsafe-inline'");
    });

    it('includes extra sources', () => {
      const csp = buildCsp('abc', ['https://cdn.example.com']);
      expect(csp).toContain('https://cdn.example.com');
    });
  });
});
