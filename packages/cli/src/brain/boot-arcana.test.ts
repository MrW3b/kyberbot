import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { bootArcana } from './boot-arcana.js';
import { getArcanaInstance, resetArcanaForTests } from './arcana-singleton.js';

describe('bootArcana', () => {
  let root: string;
  const prevKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kyberbot-boot-arcana-'));
    resetArcanaForTests();
  });

  afterEach(async () => {
    resetArcanaForTests();
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    await rm(root, { recursive: true, force: true });
  });

  it('returns a disabled handle when OPENAI_API_KEY is unset and does not init Arcana', async () => {
    delete process.env.OPENAI_API_KEY;
    const handle = await bootArcana(root);
    expect(handle.status()).toBe('disabled');
    expect(getArcanaInstance()).toBeNull();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('boots Arcana with structured + vector(undefined when chroma absent) + embed + llm when key is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    // ChromaDB is unlikely to be reachable in this test environment — boot
    // should degrade by passing vector: undefined to initArcana, not throw.
    const handle = await bootArcana(root);
    expect(handle.status()).toBe('running');
    expect(getArcanaInstance()).not.toBeNull();

    await handle.stop();
    expect(getArcanaInstance()).toBeNull();
  });

  it('stop() disposes the singleton even on repeat invocation', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-bootarcana';
    const handle = await bootArcana(root);
    await handle.stop();
    expect(getArcanaInstance()).toBeNull();
    // Second stop is a no-op (providers cleared)
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
