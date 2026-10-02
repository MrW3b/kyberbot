/**
 * ChromaDB container publishing. The container has no auth of its own, so its
 * port must be published on loopback only, never on every host interface.
 * Docker and the network are stubbed: no real container is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSync = vi.fn();
const execSync = vi.fn();
vi.mock('child_process', () => ({ execFileSync, execSync }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { chromaRunArgs, startChromaDB } = await import('./chromadb.js');

function publishedPort(args: string[]): string {
  return args[args.indexOf('-p') + 1];
}

describe('ChromaDB container publishing', () => {
  const savedUrl = process.env.CHROMA_URL;

  beforeEach(() => {
    delete process.env.CHROMA_URL;
    execFileSync.mockReset();
    execSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedUrl === undefined) delete process.env.CHROMA_URL;
    else process.env.CHROMA_URL = savedUrl;
  });

  it('publishes on 127.0.0.1 only, default port', () => {
    expect(publishedPort(chromaRunArgs('/tmp/data'))).toBe('127.0.0.1:8001:8000');
  });

  it('publishes on 127.0.0.1 with the port from CHROMA_URL', () => {
    process.env.CHROMA_URL = 'http://localhost:9123';
    expect(publishedPort(chromaRunArgs('/tmp/data'))).toBe('127.0.0.1:9123:8000');
  });

  it('keeps the data on the host bind mount', () => {
    const args = chromaRunArgs('/tmp/agent/data/chromadb');
    expect(args[args.indexOf('-v') + 1]).toBe('/tmp/agent/data/chromadb:/data');
  });

  it('creates a fresh container with the loopback publish', async () => {
    // docker info ok; no container running or existing
    execSync.mockImplementation((cmd: string) => (cmd.startsWith('docker ps') ? '' : ''));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const handle = await startChromaDB('/tmp/agent');

    const run = execFileSync.mock.calls.find((c) => c[0] === 'docker' && c[1][0] === 'run');
    expect(run).toBeDefined();
    expect(publishedPort(run![1])).toBe('127.0.0.1:8001:8000');
    expect(handle.status()).toBe('running');
  });
});
