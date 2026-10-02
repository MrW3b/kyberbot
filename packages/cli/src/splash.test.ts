import { describe, it, expect, vi, afterEach } from 'vitest';
import { displayConnectionInfo } from './splash.js';

describe('displayConnectionInfo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never prints the full API token', () => {
    const token = 'kb_0123456789abcdef0123456789abcdef0123456789abcdef';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    displayConnectionInfo({ port: 3457, apiToken: token });

    const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain(token);
    expect(out).not.toContain(token.slice(0, 5));
    expect(out).toContain('kyberbot token show');
  });
});
