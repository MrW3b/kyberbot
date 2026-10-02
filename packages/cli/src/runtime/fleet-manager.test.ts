/**
 * Bind address of the fleet server and its per-agent port listeners.
 * Same rule as the single-agent server: loopback unless KYBERBOT_HOST says
 * otherwise. Everything around the listeners is stubbed; only the sockets
 * are real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./agent-bus.js', () => ({
  AgentBus: class {
    getRemoteAgentNames() { return []; }
    getRemoteAgentConfig() { return undefined; }
    getHistory() { return []; }
  },
  setActiveBus: () => {},
}));
vi.mock('./fleet-sleep-scheduler.js', () => ({
  FleetSleepScheduler: class {
    start() { return Promise.resolve(); }
    stop() {}
    isRunning() { return false; }
    getCurrentAgent() { return null; }
  },
}));
vi.mock('./fleet-auth.js', () => ({
  createFleetAuthMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('./agent-runtime.js', () => ({ AgentRuntime: class {} }));
vi.mock('../registry.js', () => ({ loadRegistry: () => ({ agents: {} }) }));
vi.mock('../services/tunnel.js', () => ({ startTunnel: vi.fn(), getTunnelUrl: () => null }));
vi.mock('../server/agent-router.js', () => ({ mountWebUi: () => {} }));
vi.mock('../server/orchestration-api.js', () => ({ createOrchestrationRouter: () => express.Router() }));
vi.mock('../server/api/v1/router.js', () => ({ createApiV1Router: () => express.Router() }));

const { FleetManager } = await import('./fleet-manager.js');

async function freePort(): Promise<number> {
  const s = http.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function boundAddress(server: http.Server): Promise<string> {
  if (!server.listening) await once(server, 'listening');
  return (server.address() as AddressInfo).address;
}

describe('FleetManager bind address', () => {
  const savedHost = process.env.KYBERBOT_HOST;
  let fm: InstanceType<typeof FleetManager> | null = null;
  type Listener = (...args: unknown[]) => void;
  let signalListeners: { SIGINT: Listener[]; SIGTERM: Listener[] } | null = null;

  afterEach(async () => {
    if (fm) await fm.stop();
    fm = null;
    // start() installs process-level shutdown handlers; drop the ones it added.
    if (signalListeners) {
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        for (const l of process.listeners(sig)) {
          if (!signalListeners[sig].includes(l as Listener)) process.removeListener(sig, l as Listener);
        }
      }
    }
    if (savedHost === undefined) delete process.env.KYBERBOT_HOST;
    else process.env.KYBERBOT_HOST = savedHost;
  });

  it('binds the fleet port and every per-agent port to 127.0.0.1 by default', async () => {
    delete process.env.KYBERBOT_HOST;
    signalListeners = {
      SIGINT: process.listeners('SIGINT') as Listener[],
      SIGTERM: process.listeners('SIGTERM') as Listener[],
    };

    const agentPort = await freePort();
    fm = new FleetManager();
    (fm as any).agents.set('a', {
      root: '/tmp/kyberbot-fleet-listen-test',
      apiToken: 'fleet-listen-test-token',
      identity: { agent_name: 'a', server: { port: agentPort }, tunnel: { enabled: false } },
      start: async () => {},
      stop: async () => {},
      getStatus: () => ({ status: 'running', uptime: 0, services: { channels: [] }, lastBeat: null }),
      createRouter: () => express.Router(),
    });

    await fm.start(0);

    const fleetServer: http.Server = (fm as any).server;
    const agentServers: http.Server[] = (fm as any).agentServers;
    expect(await boundAddress(fleetServer)).toBe('127.0.0.1');
    expect(agentServers).toHaveLength(1);
    expect(await boundAddress(agentServers[0])).toBe('127.0.0.1');
    expect((agentServers[0].address() as AddressInfo).port).toBe(agentPort);
  });
});
