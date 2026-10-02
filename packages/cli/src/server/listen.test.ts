/**
 * Bind address of the single-agent server (startServer).
 *
 * The server must listen on loopback unless KYBERBOT_HOST says otherwise:
 * the agent/execute/management endpoints spawn Claude Code, so binding every
 * interface puts them one bearer token away from anyone on the same network.
 * A tunnel (ngrok) forwards to localhost, so loopback costs it nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const logged = vi.hoisted(() => ({
  info: [] as string[],
  warn: [] as string[],
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: (msg: string) => { logged.info.push(msg); },
    warn: (msg: string) => { logged.warn.push(msg); },
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    getServerPort: () => 0, // ephemeral port
    getIdentity: () => ({ agent_name: 'TestBot', timezone: 'UTC', server: { port: 0 }, channels: {} }),
    getRoot: () => '/tmp/kyberbot-listen-test',
  };
});

// Keep the import graph to the server shell itself: routes and channels are
// not what this file tests.
vi.mock('./agent-router.js', () => ({
  createAgentRouter: () => express.Router(),
  mountWebUi: () => {},
}));
vi.mock('./channels/telegram.js', () => ({ TelegramChannel: class {} }));
vi.mock('./channels/whatsapp.js', () => ({ WhatsAppChannel: class {} }));
vi.mock('../orchestrator.js', () => ({ getServiceStatuses: () => [] }));

const { startServer } = await import('./index.js');

describe('startServer bind address', () => {
  const savedHost = process.env.KYBERBOT_HOST;
  const savedToken = process.env.KYBERBOT_API_TOKEN;
  let listenSpy: ReturnType<typeof vi.spyOn>;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    logged.info.length = 0;
    logged.warn.length = 0;
    delete process.env.KYBERBOT_HOST;
    process.env.KYBERBOT_API_TOKEN = 'listen-test-token';
    listenSpy = vi.spyOn(http.Server.prototype, 'listen');
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
    listenSpy.mockRestore();
    if (savedHost === undefined) delete process.env.KYBERBOT_HOST;
    else process.env.KYBERBOT_HOST = savedHost;
    if (savedToken === undefined) delete process.env.KYBERBOT_API_TOKEN;
    else process.env.KYBERBOT_API_TOKEN = savedToken;
  });

  function lastServer(): http.Server {
    return listenSpy.mock.contexts.at(-1) as http.Server;
  }

  it('binds 127.0.0.1 by default, not every interface', async () => {
    const handle = await startServer({ enableChannels: false });
    stop = handle.stop;

    const addr = lastServer().address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(logged.info.some((m) => m.includes(`http://127.0.0.1:${addr.port}`))).toBe(true);
  });

  it('stays reachable at http://localhost for local callers (CLI commands, web UI, tunnel)', async () => {
    const handle = await startServer({ enableChannels: false });
    stop = handle.stop;

    const { port } = lastServer().address() as AddressInfo;
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('honours KYBERBOT_HOST as a deliberate override', async () => {
    process.env.KYBERBOT_HOST = 'localhost';
    const handle = await startServer({ enableChannels: false });
    stop = handle.stop;

    expect(listenSpy.mock.calls.at(-1)?.[1]).toBe('localhost');
  });

  it('warns accurately when the API token is unset: endpoints reject, they are not open', async () => {
    delete process.env.KYBERBOT_API_TOKEN;
    const handle = await startServer({ enableChannels: false });
    stop = handle.stop;

    expect(logged.warn.some((m) => m.includes('KYBERBOT_API_TOKEN') && m.includes('401'))).toBe(true);
    expect(logged.warn.some((m) => /publicly accessible|NO authentication|DISABLED/i.test(m))).toBe(false);
  });
});
