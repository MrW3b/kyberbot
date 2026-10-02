/**
 * Fleet Command
 *
 * Manage multiple KyberBot agents from a single CLI.
 *
 * Usage:
 *   kyberbot fleet list                      # Show all registered agents
 *   kyberbot fleet register [path]           # Register an agent
 *   kyberbot fleet unregister <name>         # Remove from registry
 *   kyberbot fleet start [--only a,b]        # Start agents as background processes
 *   kyberbot fleet stop [name]               # Stop running agents
 *   kyberbot fleet status                    # Health dashboard
 *   kyberbot fleet defaults --auto-start a,b # Set default auto-start agents
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { maskSecret } from '../utils/mask.js';
import {
  loadRegistry,
  saveRegistry,
  registerAgent,
  unregisterAgent,
  getRegisteredAgents,
  getAgentNameFromRoot,
  getRegistryDir,
  resolveAgentRoot,
} from '../registry.js';

const PRIMARY = chalk.hex('#10b981');
const ACCENT = chalk.hex('#22d3ee');
const DIM = chalk.dim;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getPortForRoot(root: string): number {
  try {
    const identityPath = join(root, 'identity.yaml');
    if (!existsSync(identityPath)) return 3456;
    const raw = readFileSync(identityPath, 'utf-8');
    const identity = yaml.load(raw) as Record<string, unknown>;
    const server = identity?.server as Record<string, unknown> | undefined;
    return (server?.port as number) || 3456;
  } catch {
    return 3456;
  }
}

function getPidPath(name: string): string {
  return join(getRegistryDir(), `${name}.pid`);
}

function getRunningPid(name: string): number | null {
  const pidPath = getPidPath(name);
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is actually running
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running — stale PID file
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Parse a turn-count CLI argument. Accepts whole positive integers (≥ 1) only.
 * Rejects fractions, zero, negatives, and non-numeric input.
 *
 * Aligns with the resolver guardrail in `getHeartbeatMaxInnerTurnsForRoot`
 * (`Number.isFinite(raw) && raw >= 1`) but tightens it at the CLI boundary
 * to forbid silent floor of fractional inputs.
 */
export function parseTurnCount(input: string): number {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`Invalid turn count "${input}". Must be a positive integer (≥ 1).`);
  }
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid turn count "${input}". Must be a positive integer (≥ 1).`);
  }
  return parsed;
}

/**
 * Resolve the target agent root + display name for `fleet set-turns` /
 * `fleet get-turns`. Errors out for remote agents (identity.yaml is not
 * locally accessible) or missing identity.yaml.
 */
async function resolveTargetRoot(agentFlag?: string): Promise<{ root: string; name: string }> {
  let root: string;
  if (agentFlag) {
    // If the input is a registry name (not path-like), check the registry
    // entry up-front for a remote-type guard before hitting the filesystem.
    const isPathLike =
      agentFlag.includes('/') || agentFlag.startsWith('~') || agentFlag.startsWith('.');
    if (!isPathLike) {
      const registry = loadRegistry();
      const entry = registry.agents[agentFlag.toLowerCase()];
      if (entry && entry.type === 'remote') {
        throw new Error(
          `Cannot mutate identity.yaml on remote agent "${agentFlag}". Set the turn limit on the agent host instead.`
        );
      }
    }
    root = resolveAgentRoot(agentFlag);
  } else {
    const { getRoot } = await import('../config.js');
    root = getRoot();
  }

  if (!root || !existsSync(join(root, 'identity.yaml'))) {
    throw new Error(`No identity.yaml found at ${root || '<unresolved root>'}.`);
  }

  const name = getAgentNameFromRoot(root);
  return { root, name };
}

async function probeHealth(port: number, remoteUrl?: string): Promise<boolean> {
  try {
    const url = remoteUrl ? `${remoteUrl}/health` : `http://localhost:${port}/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

export function createFleetCommand(): Command {
  const fleet = new Command('fleet')
    .description('Manage multiple KyberBot agents');

  // ─────────────────────────────────────────────────────────────
  // fleet list
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('list')
    .description('Show all registered agents')
    .action(async () => {
      const agents = getRegisteredAgents();
      const names = Object.keys(agents);

      if (names.length === 0) {
        console.log(DIM('No agents registered. Run `kyberbot fleet register` from an agent directory.'));
        return;
      }

      console.log();
      console.log(PRIMARY.bold('  Registered Agents'));
      console.log();

      // Header
      const nameW = 14;
      const typeW = 8;
      const statusW = 10;
      console.log(
        '  ' +
        chalk.bold('Name'.padEnd(nameW)) +
        chalk.bold('Type'.padEnd(typeW)) +
        chalk.bold('Status'.padEnd(statusW)) +
        chalk.bold('Location')
      );
      console.log('  ' + '─'.repeat(70));

      for (const name of names) {
        const entry = agents[name];
        const isRemote = entry.type === 'remote';

        let status: string;
        if (isRemote) {
          // Probe remote health
          const healthy = entry.remoteUrl ? await probeHealth(0, entry.remoteUrl) : false;
          status = healthy ? chalk.green('● online') : chalk.gray('○ offline');
        } else {
          const port = getPortForRoot(entry.root || '');
          const pid = getRunningPid(name);
          const healthy = pid ? await probeHealth(port) : false;
          if (healthy) {
            status = chalk.green('● running');
          } else if (pid) {
            status = chalk.yellow('● starting');
          } else {
            status = chalk.gray('○ stopped');
          }
        }

        const typeLabel = isRemote ? ACCENT('remote') : DIM('local');
        const location = isRemote ? (entry.remoteUrl || '') : (entry.root || '');

        console.log(
          '  ' +
          ACCENT(name.padEnd(nameW)) +
          typeLabel.padEnd(typeW + 10) + // extra for ANSI
          status.padEnd(statusW + 10) +
          DIM(location)
        );
      }
      console.log();
    });

  // ─────────────────────────────────────────────────────────────
  // fleet register [path]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('register [path]')
    .description('Register an agent (default: current directory)')
    .action(async (path?: string) => {
      const root = resolve(path || process.cwd());
      const agentName = getAgentNameFromRoot(root);

      if (agentName === 'unknown') {
        console.error(chalk.red(`No identity.yaml found at ${root}`));
        process.exit(1);
      }

      try {
        registerAgent(agentName, root);
        console.log(PRIMARY(`Registered "${agentName}" → ${root}`));
      } catch (error) {
        console.error(chalk.red(`Failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet register-remote <name>
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('register-remote <name>')
    .description('Register a remote agent via ngrok tunnel URL')
    .requiredOption('--url <url>', 'Remote agent URL (e.g., https://xyz.ngrok.dev)')
    .requiredOption('--token <token>', 'Remote agent API token')
    .action(async (name: string, options: { url: string; token: string }) => {
      console.log(DIM(`Verifying remote agent at ${options.url}...`));
      try {
        const { registerRemoteAgent } = await import('../registry.js');
        await registerRemoteAgent(name, options.url, options.token);
        console.log(PRIMARY(`Registered remote agent "${name}" → ${options.url}`));
      } catch (error) {
        console.error(chalk.red(`Failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet unregister <name>
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('unregister <name>')
    .description('Remove an agent from the registry (files are not deleted)')
    .action(async (name: string) => {
      try {
        unregisterAgent(name);
        console.log(PRIMARY(`Unregistered "${name}". Agent files are untouched.`));
      } catch (error) {
        console.error(chalk.red(`Failed: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet start [--only name1,name2]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('start')
    .description('Start agents in a shared runtime (single process)')
    .option('--only <names>', 'Comma-separated list of agents to start')
    .option('--port <port>', 'Server port (default: 3456)')
    .action(async (options: { only?: string; port?: string }) => {
      const { FleetManager } = await import('../runtime/fleet-manager.js');
      const { initMonitoring } = await import('../monitoring.js');

      await initMonitoring();

      const port = options.port ? parseInt(options.port) : 3456;
      const names = options.only?.split(',').map((n) => n.trim().toLowerCase());

      const { displayBanner } = await import('../splash.js');
      const { getIdentityForRoot } = await import('../config.js');
      const { getTunnelUrl } = await import('../services/tunnel.js');
      let tunnelUrl: string | null = null;

      console.clear();
      console.log();
      displayBanner('fleet');

      // Fleet metadata
      const agentNames = names || Object.keys((await import('../registry.js')).loadRegistry().agents);
      console.log(DIM('  Mode:    ') + ACCENT('Fleet'));
      console.log(DIM('  Agents:  ') + chalk.white(agentNames.join(', ')));
      console.log(DIM('  Port:    ') + chalk.white(String(port)));
      console.log();

      const fleet = new FleetManager();
      await fleet.loadAgents(names);
      await fleet.start(port);

      // Telemetry dashboard — live view of per-agent Claude subprocess
      // usage + fleet-side activity. Auto-spins with the fleet; set
      // KYBERBOT_NO_TELEMETRY=1 to skip.
      let telemetryUrl: string | null = null;
      if (process.env.KYBERBOT_NO_TELEMETRY !== '1') {
        try {
          const { startTelemetryServer } = await import('../services/telemetry.js');
          const preferredPort = process.env.KYBERBOT_TELEMETRY_PORT
            ? parseInt(process.env.KYBERBOT_TELEMETRY_PORT, 10)
            : 4545;
          const t = await startTelemetryServer({ port: preferredPort });
          telemetryUrl = t.url;
        } catch (err) {
          console.log(DIM(`  Telemetry dashboard failed to start: ${String(err)}`));
        }
      }

      // Per-agent status breakdown
      tunnelUrl = getTunnelUrl();
      const statuses = fleet.getAllStatuses();
      console.log();
      for (const status of statuses) {
        const agentIdentity = (() => {
          try { return getIdentityForRoot(status.root); } catch { return null; }
        })();
        const agentPort = agentIdentity?.server?.port || port;
        const agentToken = (() => {
          try {
            const { readFileSync } = require('fs');
            const { join } = require('path');
            const env = readFileSync(join(status.root, '.env'), 'utf-8');
            const match = env.match(/KYBERBOT_API_TOKEN=(.+)/);
            return match ? match[1].trim().replace(/['"]/g, '') : null;
          } catch { return null; }
        })();

        const icon = status.status === 'running' ? chalk.green('✓') : chalk.red('✗');
        const channels = status.services.channels.map(c => c.name).join(', ') || 'none';
        const hasTunnel = agentIdentity?.tunnel?.enabled;

        console.log(`  ${icon} ${ACCENT(status.name.toUpperCase())}`);
        console.log(`    ${DIM('Status:')}    ${status.status === 'running' ? chalk.green('running') : chalk.red(status.status)}`);
        console.log(`    ${DIM('Heartbeat:')} ${status.services.heartbeat}`);
        console.log(`    ${DIM('Channels:')}  ${channels}`);
        console.log(`    ${DIM('Local:')}     http://localhost:${agentPort}`);
        console.log(`    ${DIM('Web UI:')}    http://localhost:${agentPort}/ui`);
        if (hasTunnel && tunnelUrl) {
          console.log(`    ${DIM('Tunnel:')}    ${ACCENT(tunnelUrl)}`);
        }
        if (agentToken) {
          console.log(`    ${DIM('API Key:')}   ${maskSecret(agentToken)}  ${DIM('(kyberbot token show)')}`);
        }
        console.log();
      }

      // Fleet connection info
      console.log(DIM('═'.repeat(76)));
      console.log();
      console.log('  ' + PRIMARY.bold('Fleet is ready.'));
      console.log();
      console.log(DIM('═'.repeat(76)));
      console.log();
      console.log(`  ${DIM('Fleet server:')} http://localhost:${port}`);
      for (const s of statuses) {
        console.log(`  ${DIM('Routes:')}       http://localhost:${port}/agent/${s.name}/*`);
      }
      console.log(`  ${DIM('Bus:')}          http://localhost:${port}/fleet/bus/*`);
      if (telemetryUrl) {
        console.log(`  ${DIM('Telemetry:')}    ${ACCENT(telemetryUrl)}  ${DIM('← open in browser for live token/cost view')}`);
      }
      console.log();

      // Keep process alive
      await new Promise<void>(() => {});
    });

  // ─────────────────────────────────────────────────────────────
  // fleet stop [name]
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('stop [name]')
    .description('Stop running agents (all if no name given)')
    .action(async (name?: string) => {
      const agents = getRegisteredAgents();
      const toStop = name ? [name.toLowerCase()] : Object.keys(agents);

      let stopped = 0;
      for (const agentName of toStop) {
        const pid = getRunningPid(agentName);
        if (!pid) {
          if (name) {
            console.log(DIM(`${agentName} is not running`));
          }
          continue;
        }

        console.log(`Stopping ${ACCENT(agentName)} (PID ${pid})...`);

        try {
          // SIGTERM for graceful shutdown
          process.kill(pid, 'SIGTERM');

          // Wait up to 10 seconds for process to exit
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            try {
              process.kill(pid, 0); // test if still alive
              await new Promise((r) => setTimeout(r, 500));
            } catch {
              break; // process exited
            }
          }

          // Force kill if still running
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
            console.log(`  Force-killed ${agentName}`);
          } catch {
            // Already dead
          }

          // Clean up PID file
          const pidPath = getPidPath(agentName);
          try { unlinkSync(pidPath); } catch { /* ignore */ }

          console.log(`  ${PRIMARY('Stopped')} ${agentName}`);
          stopped++;
        } catch (error) {
          console.error(chalk.red(`Failed to stop ${agentName}: ${error}`));
        }
      }

      if (stopped === 0 && !name) {
        console.log(DIM('No agents were running'));
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet status
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('status')
    .description('Show fleet runtime status — running state, agents, last heartbeat')
    .option('--json', 'Output machine-readable JSON', false)
    .option('--strict', 'Exit non-zero on degraded fleet', false)
    .action(async (options: { json?: boolean; strict?: boolean }) => {
      const FLEET_PORT = 3456;
      const FLEET_HEALTH_URL = `http://localhost:${FLEET_PORT}/health`;
      const PROBE_TIMEOUT_MS = 3000;

      type ServiceRow = { name: string; status: 'running' | 'stopped' | 'disabled' };
      type AgentRow = {
        name: string;
        state: 'running' | 'stopped' | 'unknown';
        lastBeat: string | null;
        services: ServiceRow[];
      };
      type RemoteRow = {
        name: string;
        url: string;
        reachable: boolean;
        state: 'running' | 'degraded' | 'unreachable';
        lastBeat: string | null;
      };
      type FleetReport = {
        fleet: {
          state: 'running' | 'degraded' | 'stopped';
          reason?: string;
          uptime: string | null;
          lastTick: string | null;
          pid: number | null;
        };
        agents: AgentRow[];
        remote: RemoteRow[];
      };

      // Normalize the /health agents[].services shape (which mixes a
      // strings-and-arrays object) into a flat ServiceRow[].
      function flattenAgentServices(services: unknown): ServiceRow[] {
        const flat: ServiceRow[] = [];
        if (!services || typeof services !== 'object') return flat;
        for (const [svcName, svcVal] of Object.entries(services as Record<string, unknown>)) {
          if (svcName === 'channels' && Array.isArray(svcVal)) {
            for (const ch of svcVal as Array<{ name?: string; connected?: boolean }>) {
              flat.push({
                name: ch.name || 'channel',
                status: ch.connected ? 'running' : 'stopped',
              });
            }
          } else if (typeof svcVal === 'string') {
            const s = svcVal as ServiceRow['status'];
            if (s === 'running' || s === 'stopped' || s === 'disabled') {
              flat.push({ name: svcName, status: s });
            } else {
              flat.push({ name: svcName, status: 'stopped' });
            }
          }
        }
        return flat;
      }

      function formatAge(iso: string | null): string {
        if (!iso) return 'never';
        const ms = Date.now() - new Date(iso).getTime();
        if (!Number.isFinite(ms) || ms < 0) return iso;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return `${d}d ago`;
      }

      // ── Partition registry ────────────────────────────────────
      const agents = getRegisteredAgents();
      const allNames = Object.keys(agents);
      const localEntries: Array<{ name: string; entry: typeof agents[string] }> = [];
      const remoteEntries: Array<{ name: string; entry: typeof agents[string] }> = [];
      for (const name of allNames) {
        const entry = agents[name];
        if (entry.type === 'remote') {
          remoteEntries.push({ name, entry });
        } else {
          localEntries.push({ name, entry });
        }
      }

      // ── Empty registry early-out ──────────────────────────────
      if (localEntries.length === 0 && remoteEntries.length === 0) {
        if (options.json) {
          const empty: FleetReport = {
            fleet: { state: 'stopped', reason: 'no agents registered', uptime: null, lastTick: null, pid: null },
            agents: [],
            remote: [],
          };
          console.log(JSON.stringify(empty, null, 2));
        } else {
          console.error(
            DIM('No agents registered. Run `kyberbot fleet register <name> <root>` to add one.'),
          );
        }
        process.exit(0);
      }

      // ── Probe local fleet /health ─────────────────────────────
      type FleetHealthBody = {
        status?: string;
        timestamp?: string;
        uptime?: string;
        mode?: string;
        agents?: Array<{
          name: string;
          status: string;
          services?: Record<string, unknown>;
          lastBeat?: string | null;
        }>;
        pid?: number;
      };
      let fleetBody: FleetHealthBody | null = null;
      let fleetReachable = false;
      try {
        const res = await fetch(FLEET_HEALTH_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.ok) {
          fleetBody = (await res.json()) as FleetHealthBody;
          fleetReachable = true;
        }
      } catch {
        fleetReachable = false;
      }

      // Map fleet agents by lowercased name for hydration
      const fleetAgentByName = new Map<string, NonNullable<FleetHealthBody['agents']>[number]>();
      if (fleetBody?.agents) {
        for (const a of fleetBody.agents) {
          fleetAgentByName.set(a.name.toLowerCase(), a);
        }
      }

      // ── Probe remotes in parallel ─────────────────────────────
      type RemoteHealthBody = { status?: string; lastBeat?: string | null };
      const remote: RemoteRow[] = await Promise.all(
        remoteEntries.map(async ({ name, entry }) => {
          const url = entry.remoteUrl || '';
          if (!url) {
            return { name, url: '', reachable: false, state: 'unreachable', lastBeat: null } as RemoteRow;
          }
          try {
            const headers: Record<string, string> = {};
            if (entry.remoteToken) headers['Authorization'] = `Bearer ${entry.remoteToken}`;
            const res = await fetch(`${url}/health`, {
              headers,
              signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            });
            if (!res.ok) {
              return { name, url, reachable: false, state: 'unreachable', lastBeat: null };
            }
            const body = (await res.json()) as RemoteHealthBody;
            const state: RemoteRow['state'] =
              body.status === 'ok'
                ? 'running'
                : body.status === 'degraded'
                  ? 'degraded'
                  : 'unreachable';
            return {
              name,
              url,
              reachable: true,
              state,
              lastBeat: body.lastBeat ?? null,
            };
          } catch {
            return { name, url, reachable: false, state: 'unreachable', lastBeat: null };
          }
        }),
      );

      // ── Build per-local-agent rows ────────────────────────────
      const localRows: AgentRow[] = localEntries.map(({ name }) => {
        const fleetAgent = fleetAgentByName.get(name.toLowerCase());
        if (fleetAgent) {
          const state: AgentRow['state'] =
            fleetAgent.status === 'running' ? 'running' : 'stopped';
          return {
            name,
            state,
            lastBeat: fleetAgent.lastBeat ?? null,
            services: flattenAgentServices(fleetAgent.services),
          };
        }
        // Registered locally but fleet server doesn't know about it (or
        // server unreachable). Treat as stopped.
        return { name, state: 'stopped', lastBeat: null, services: [] };
      });

      // ── Classify fleet state ──────────────────────────────────
      let state: FleetReport['fleet']['state'];
      let reason: string | undefined;

      if (localEntries.length === 0) {
        // Remote-only registry
        const anyRemoteRunning = remote.some((r) => r.state === 'running');
        if (anyRemoteRunning) {
          state = 'running';
        } else {
          state = 'stopped';
          reason = 'no remote agents reachable';
        }
      } else if (!fleetReachable || !fleetBody) {
        state = 'stopped';
        reason = `fleet server unreachable at localhost:${FLEET_PORT} — run \`kyberbot fleet start\``;
      } else if (fleetBody.status === 'ok') {
        state = 'running';
      } else if (fleetBody.status === 'degraded') {
        state = 'degraded';
        const stoppedNames = localRows.filter((a) => a.state !== 'running').map((a) => a.name);
        if (stoppedNames.length > 0) {
          reason = `${stoppedNames.length} agent(s) not running: ${stoppedNames.join(', ')}`;
        }
      } else {
        state = 'degraded';
        reason = `unexpected fleet status: ${fleetBody.status ?? 'unknown'}`;
      }

      // lastTick: max(agent.lastBeat) across local agents, fallback /health.timestamp
      const beatTimes = localRows
        .map((r) => r.lastBeat)
        .filter((s): s is string => !!s)
        .map((s) => new Date(s).getTime())
        .filter((n) => Number.isFinite(n));
      const lastTick: string | null =
        beatTimes.length > 0
          ? new Date(Math.max(...beatTimes)).toISOString()
          : (fleetBody?.timestamp ?? null);

      const report: FleetReport = {
        fleet: {
          state,
          ...(reason ? { reason } : {}),
          uptime: fleetBody?.uptime ?? null,
          lastTick,
          pid: fleetBody?.pid ?? null,
        },
        agents: localRows,
        remote,
      };

      // ── Render ────────────────────────────────────────────────
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const stateIcon =
          state === 'running' ? chalk.green('●')
            : state === 'degraded' ? chalk.yellow('▲')
              : chalk.gray('○');
        const stateLabel =
          state === 'running' ? chalk.green('running')
            : state === 'degraded' ? chalk.yellow('degraded')
              : chalk.gray('stopped');

        console.log();
        console.log(PRIMARY.bold('  Fleet Status'));
        console.log();
        const headerSuffix = report.fleet.reason ? ` ${DIM(`(${report.fleet.reason})`)}` : '';
        console.log(`  ${stateIcon} Fleet: ${stateLabel}${headerSuffix}`);
        if (report.fleet.uptime) {
          console.log(`    ${DIM('Uptime:')}    ${report.fleet.uptime}`);
        }
        if (report.fleet.lastTick) {
          console.log(`    ${DIM('Last tick:')} ${report.fleet.lastTick} (${formatAge(report.fleet.lastTick)})`);
        }
        if (report.fleet.pid !== null) {
          console.log(`    ${DIM('PID:')}       ${report.fleet.pid}`);
        }
        console.log();

        if (localRows.length > 0) {
          console.log(`  ${chalk.bold('Local agents')}`);
          for (const row of localRows) {
            const icon =
              row.state === 'running' ? chalk.green('●')
                : row.state === 'stopped' ? chalk.gray('○')
                  : chalk.yellow('●');
            const stateText = row.state === 'running' ? 'running' : row.state;
            const beatText = DIM(`· last beat ${formatAge(row.lastBeat)}`);
            console.log(`  ${icon} ${ACCENT(row.name.padEnd(14))} ${stateText} ${beatText}`);
            for (const svc of row.services) {
              const svcIcon = svc.status === 'running' ? chalk.green('✓') : chalk.gray('–');
              console.log(`    ${svcIcon} ${svc.name} ${DIM(`(${svc.status})`)}`);
            }
          }
          console.log();
        }

        if (remote.length > 0) {
          console.log(`  ${chalk.bold('Remote agents')}`);
          for (const r of remote) {
            const icon =
              r.state === 'running' ? chalk.green('●')
                : r.state === 'degraded' ? chalk.yellow('▲')
                  : chalk.gray('○');
            const stateText =
              r.state === 'running' ? 'running'
                : r.state === 'degraded' ? 'degraded'
                  : 'unreachable';
            const beatText = r.lastBeat ? DIM(`· last beat ${formatAge(r.lastBeat)}`) : '';
            console.log(`  ${icon} ${ACCENT(r.name.padEnd(14))} ${stateText} ${DIM(r.url)} ${beatText}`);
          }
          console.log();
        }

        const runningLocal = localRows.filter((r) => r.state === 'running').length;
        const reachableRemote = remote.filter((r) => r.reachable).length;
        let summary = `  ${runningLocal}/${localRows.length} local agent(s) running`;
        if (remote.length > 0) {
          summary += `, ${reachableRemote}/${remote.length} remote reachable`;
        }
        console.log(summary);
        console.log();
      }

      // ── Exit code policy ──────────────────────────────────────
      if (state === 'running') {
        process.exit(0);
      } else if (state === 'degraded') {
        process.exit(options.strict ? 1 : 0);
      } else {
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet defaults
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('defaults')
    .description('Set default fleet configuration')
    .option('--auto-start <names>', 'Comma-separated list of agents to start by default')
    .action(async (options: { autoStart?: string }) => {
      const registry = loadRegistry();

      if (options.autoStart) {
        const names = options.autoStart.split(',').map((n) => n.trim().toLowerCase());
        // Validate
        for (const name of names) {
          if (!registry.agents[name]) {
            console.error(chalk.red(`Agent "${name}" not found in registry.`));
            process.exit(1);
          }
        }
        if (!registry.defaults) registry.defaults = {};
        registry.defaults.auto_start = names;
        saveRegistry(registry);
        console.log(PRIMARY(`Auto-start set to: ${names.join(', ')}`));
      } else {
        const autoStart = registry.defaults?.auto_start;
        if (autoStart && autoStart.length > 0) {
          console.log(`Auto-start: ${autoStart.join(', ')}`);
        } else {
          console.log(DIM('No auto-start defaults set. All agents will start with `fleet start`.'));
        }
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet set-turns <n>
  // ─────────────────────────────────────────────────────────────
  const turnsHelpText = `
Field: heartbeat_max_inner_turns in <agent>/identity.yaml
Default: 50
Consumers:
  - worker heartbeat (packages/cli/src/orchestration/worker-heartbeat.ts)
  - CEO heartbeat    (packages/cli/src/orchestration/ceo-heartbeat.ts)
Does NOT affect:
  - worker_max_turns (outer worker continuation loop, default 5)
  - per-agent sub-agent maxTurns (use \`kyberbot agent create --max-turns\`
    or edit agents/<name>/agent.yaml)
`;

  fleet
    .command('set-turns')
    .description('Set the inner Claude SDK turn cap (heartbeat_max_inner_turns) for the targeted agent. Default 50.')
    .argument('<n>', 'Maximum inner turns per heartbeat (positive integer)')
    .option('--agent <name>', 'Target agent (registry name or path). Defaults to current directory.')
    .addHelpText('after', turnsHelpText)
    .action(async (n: string, options: { agent?: string }) => {
      try {
        const parsed = parseTurnCount(n);
        const { root, name } = await resolveTargetRoot(options.agent);

        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = (yaml.load(raw) as Record<string, unknown>) || {};
        identity.heartbeat_max_inner_turns = parsed;
        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }), 'utf-8');

        const { clearIdentityCache } = await import('../config.js');
        clearIdentityCache(root);

        console.log(PRIMARY(`Set inner turn limit to ${parsed} for agent ${name}`));
        console.log(DIM('Takes effect on next heartbeat.'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────
  // fleet get-turns
  // ─────────────────────────────────────────────────────────────
  fleet
    .command('get-turns')
    .description('Show the effective inner Claude SDK turn cap (heartbeat_max_inner_turns) for the targeted agent.')
    .option('--agent <name>', 'Target agent (registry name or path). Defaults to current directory.')
    .addHelpText('after', turnsHelpText)
    .action(async (options: { agent?: string }) => {
      try {
        const { root, name } = await resolveTargetRoot(options.agent);

        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = (yaml.load(raw) as Record<string, unknown>) || {};
        const explicit = identity.heartbeat_max_inner_turns;
        const isExplicit =
          typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1;

        const { getHeartbeatMaxInnerTurnsForRoot } = await import('../config.js');
        const effective = getHeartbeatMaxInnerTurnsForRoot(root);

        console.log(PRIMARY(`${effective}`) + ` inner turns for agent ${name}`);
        if (isExplicit) {
          console.log(DIM('Source: heartbeat_max_inner_turns in identity.yaml'));
        } else {
          console.log(DIM('Source: default fallback (heartbeat_max_inner_turns not set in identity.yaml)'));
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
        process.exit(1);
      }
    });

  return fleet;
}
