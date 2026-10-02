import { describe, it, expect } from 'vitest';
import { maskSecret } from './mask.js';

describe('maskSecret', () => {
  it('shows at most the first four characters', () => {
    const token = 'kb_0123456789abcdef0123456789abcdef0123456789abcdef';
    const masked = maskSecret(token);
    expect(masked.startsWith('kb_0')).toBe(true);
    expect(masked).not.toContain('kb_01');
    expect(masked).toContain('[redacted]');
  });

  it('shows nothing of a short value', () => {
    expect(maskSecret('abc123')).toBe('[redacted]');
  });
});
