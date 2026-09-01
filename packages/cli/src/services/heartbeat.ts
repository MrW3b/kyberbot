/**
 * KyberBot — Heartbeat Service
 *
 * Internal interval timer that reads HEARTBEAT.md and executes
 * the most overdue task. Inspired by OpenClaw's Gateway heartbeat.
 *
 * - Default interval: 30 minutes (configurable via identity.yaml)
 * - Lane-based queuing: skips if user is actively chatting
 * - HEARTBEAT_OK suppression: silent when nothing actionable
 * - Logs to logs/heartbeat.log
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../logger.js';
import { getIdentityForRoot, getHeartbeatModelForRoot } from '../config.js';
import { getClaudeClient } from '../claude.js';
import { ServiceHandle } from '../types.js';
import { storeConversation } from '../brain/store-conversation.js';
import { getSkill } from '../skills/loader.js';

const logger = createLogger('heartbeat');

let intervalId: NodeJS.Timeout | null = null;
let running = false;
let busy = false;

// Orchestration runs on its own interval, separate from the standard heartbeat.
// This tracks when the last orchestration tick ran per agent.
const lastOrchTick = new Map<string, number>();

// Tracks the wall-clock time of the most recent `tick(root)` invocation,
// regardless of whether it short-circuited (busy lane, outside active hours,
// no due tasks). Answers "is the heartbeat loop alive" — surfaced via
// `getLastBeat(root)` and rendered by `kyberbot fleet status`.
const lastBeatByRoot = new Map<string, number>();

/**
 * Wall-clock time (ms) of the most recent heartbeat tick for the given
 * agent root, or `null` if the loop has not fired yet.
 */
export function getLastBeat(root: string): number | null {
  return lastBeatByRoot.get(root) ?? null;
}

function parseIntervalMs(intervalStr: string): number {
  const match = intervalStr.match(/^(\d+)(m|h)$/);
  return match
    ? (match[2] === 'h' ? Number(match[1]) * 60 * 60 * 1000 : Number(match[1]) * 60 * 1000)
    : 60 * 60 * 1000;
}

/**
 * Pull the `### Task Name` + `**Schedule**: ...` pairs out of HEARTBEAT.md.
 * Only tasks in the `## Tasks` section are returned. Schedule is kept as
 * a raw string; `isTaskDue` does the interpretation.
 */
interface ParsedTask { name: string; schedule: string }
function parseHeartbeatTasks(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const afterTasks = content.split(/^##\s+Tasks\b/im)[1];
  if (!afterTasks) return tasks;
  const blocks = afterTasks.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = block.match(/^([^\n]+)/);
    const scheduleMatch = block.match(/\*\*Schedule\*\*:\s*([^\n]+)/i);
    if (nameMatch && scheduleMatch) {
      tasks.push({ name: nameMatch[1].trim(), schedule: scheduleMatch[1].trim() });
    }
  }
  return tasks;
}

/**
 * Resolve a schedule's timezone token. Accepts IANA names (`Asia/Singapore`),
 * common abbreviations (`SGT`, `UTC`, `PT`, `ET`), or falls back to the agent's
 * default timezone when no token is given.
 */
function resolveTz(token: string | undefined, fallback: string): string {
  if (!token) return fallback;
  const t = token.toLowerCase();
  const map: Record<string, string> = {
    sgt: 'Asia/Singapore',
    utc: 'UTC',
    gmt: 'UTC',
    pt: 'America/Los_Angeles',
    pst: 'America/Los_Angeles',
    pdt: 'America/Los_Angeles',
    et: 'America/New_York',
    est: 'America/New_York',
    edt: 'America/New_York',
    ct: 'America/Chicago',
    mt: 'America/Denver',
  };
  return map[t] ?? token;
}

function parseDayOfWeek(d: string): number | null {
  const map: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  return map[d.toLowerCase()] ?? null;
}

/**
 * Get the UTC offset (minutes) for the given IANA timezone at the given instant.
 */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * Build the UTC Date for "(today + dayOffset) at HH:MM in tz".
 * `today` is the calendar date in `tz` derived from `now`.
 */
function localDateTime(now: Date, tz: string, dayOffset: number, h: number, m: number): Date {
  const base = new Date(now.getTime() + dayOffset * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);
  const y = parts.find((p) => p.type === 'year')!.value;
  const mo = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  const off = tzOffsetMinutes(tz, base);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const offH = String(Math.floor(abs / 60)).padStart(2, '0');
  const offM = String(abs % 60).padStart(2, '0');
  return new Date(
    `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${sign}${offH}:${offM}`,
  );
}

/**
 * Compute the most recent target instant at-or-before `now` for a time-of-day
 * schedule (e.g. `daily 21:00 SGT`, `weekly Sunday 20:00 SGT`). Returns null
 * when the schedule has no time-of-day component we recognise.
 */
function mostRecentTargetInstant(schedule: string, fallbackTz: string, now: Date): Date | null {
  const s = schedule.toLowerCase();

  const dailyTimed = s.match(/^daily\s+(\d{1,2}):(\d{2})(?:\s+([a-z/_+\-0-9]+))?/);
  if (dailyTimed) {
    const tz = resolveTz(dailyTimed[3], fallbackTz);
    const todayTarget = localDateTime(now, tz, 0, Number(dailyTimed[1]), Number(dailyTimed[2]));
    if (todayTarget.getTime() <= now.getTime()) return todayTarget;
    return localDateTime(now, tz, -1, Number(dailyTimed[1]), Number(dailyTimed[2]));
  }

  const weeklyTimed = s.match(
    /^weekly\s+([a-z\-]+)\s+(\d{1,2}):(\d{2})(?:\s+([a-z/_+\-0-9]+))?/,
  );
  if (weeklyTimed) {
    const targetDow = parseDayOfWeek(weeklyTimed[1]);
    if (targetDow === null) return null;
    const tz = resolveTz(weeklyTimed[4], fallbackTz);
    const dowStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
      .format(now)
      .toLowerCase()
      .slice(0, 3);
    const todayDow = parseDayOfWeek(dowStr) ?? 0;
    const daysBack = (todayDow - targetDow + 7) % 7;
    let candidate = localDateTime(now, tz, -daysBack, Number(weeklyTimed[2]), Number(weeklyTimed[3]));
    if (candidate.getTime() > now.getTime()) {
      candidate = new Date(candidate.getTime() - 7 * 86_400_000);
    }
    return candidate;
  }

  // monthly last-DOW HH:MM [TZ] — e.g. `monthly last-sunday 20:00 SGT`
  const monthlyLastDow = s.match(
    /^monthly\s+last-([a-z]+)\s+(\d{1,2}):(\d{2})(?:\s+([a-z/_+\-0-9]+))?/,
  );
  if (monthlyLastDow) {
    const targetDow = parseDayOfWeek(monthlyLastDow[1]);
    if (targetDow === null) return null;
    const tz = resolveTz(monthlyLastDow[4], fallbackTz);
    const h = Number(monthlyLastDow[2]);
    const m = Number(monthlyLastDow[3]);
    const ymdParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = Number(ymdParts.find((p) => p.type === 'year')!.value);
    const month = Number(ymdParts.find((p) => p.type === 'month')!.value); // 1-12

    const computeLastDowOfMonth = (y: number, mo: number): Date | null => {
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // last day of (y,mo)
      for (let day = lastDay; day >= lastDay - 6; day--) {
        const probe = new Date(Date.UTC(y, mo - 1, day, 12, 0));
        const dowStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
          .format(probe)
          .toLowerCase()
          .slice(0, 3);
        if (parseDayOfWeek(dowStr) === targetDow) {
          const off = tzOffsetMinutes(tz, probe);
          const sign = off >= 0 ? '+' : '-';
          const abs = Math.abs(off);
          const offH = String(Math.floor(abs / 60)).padStart(2, '0');
          const offM = String(abs % 60).padStart(2, '0');
          return new Date(
            `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00${sign}${offH}:${offM}`,
          );
        }
      }
      return null;
    };

    const thisMonthTarget = computeLastDowOfMonth(year, month);
    if (thisMonthTarget && thisMonthTarget.getTime() <= now.getTime()) return thisMonthTarget;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    return computeLastDowOfMonth(prevYear, prevMonth);
  }

  return null;
}

/**
 * Decide whether a parsed task is due given its last-check timestamp.
 * Handles `every Nm|Nh|Nd`, `daily [HH:MM TZ]`, `weekly [DAY HH:MM TZ]`, and
 * `monthly`. Time-of-day variants compare against the most recent target
 * instant, so `daily 21:00 SGT` does not fire at 02:00 SGT just because >24h
 * elapsed. Unknown syntax is conservatively treated as due.
 */
function isTaskDue(
  task: ParsedTask,
  lastCheckIso: string | undefined,
  now: Date,
  fallbackTz: string,
): boolean {
  if (!lastCheckIso) return true;
  const lastCheck = new Date(lastCheckIso);
  if (isNaN(lastCheck.getTime())) return true;
  const elapsedMs = now.getTime() - lastCheck.getTime();
  const schedule = task.schedule.toLowerCase();

  const everyMatch = schedule.match(/every\s+(\d+)\s*(m|h|d)\b/);
  if (everyMatch) {
    const n = Number(everyMatch[1]);
    const unit = everyMatch[2];
    const required = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    return elapsedMs >= required;
  }

  const target = mostRecentTargetInstant(schedule, fallbackTz, now);
  if (target) return lastCheck.getTime() < target.getTime();

  if (schedule.startsWith('daily')) return elapsedMs >= 24 * 3_600_000;
  if (schedule.startsWith('weekly')) return elapsedMs >= 7 * 24 * 3_600_000;
  if (schedule.startsWith('monthly')) return elapsedMs >= 28 * 24 * 3_600_000;

  return true;
}

/**
 * Among due tasks, pick the one with the largest "overdue" gap — measured
 * as `now - target` for time-of-day schedules, or `elapsed - required` for
 * interval schedules. Returns null when nothing is due or no task has a
 * parseable schedule.
 */
function pickMostOverdueTask(
  tasks: ParsedTask[],
  lastChecks: Record<string, string | undefined>,
  now: Date,
  fallbackTz: string,
  failures: Record<string, TaskFailure> = {},
): ParsedTask | null {
  let winner: ParsedTask | null = null;
  let winnerGap = -Infinity;
  for (const t of tasks) {
    if (!isTaskDue(t, lastChecks[t.name], now, fallbackTz)) continue;
    // Skip a recently-failed task until its backoff window elapses, so one
    // failing task cannot monopolise every tick. The task stays "due" and keeps
    // its real (stale) lastChecks — it is deferred, not marked run.
    const fail = failures[t.name];
    if (fail && fail.count > 0) {
      const since = now.getTime() - new Date(fail.lastFailure).getTime();
      if (Number.isFinite(since) && since < failureBackoffMs(fail.count)) continue;
    }
    const lastIso = lastChecks[t.name];
    const last = lastIso ? new Date(lastIso) : null;
    let gap: number;
    const target = mostRecentTargetInstant(t.schedule.toLowerCase(), fallbackTz, now);
    if (target && last && !isNaN(last.getTime())) {
      gap = now.getTime() - target.getTime() + Math.max(0, target.getTime() - last.getTime());
    } else if (last && !isNaN(last.getTime())) {
      gap = now.getTime() - last.getTime();
    } else {
      gap = Number.MAX_SAFE_INTEGER; // Never run — highest priority
    }
    if (gap > winnerGap) {
      winnerGap = gap;
      winner = t;
    }
  }
  return winner;
}

interface TaskFailure {
  count: number;        // consecutive failures since last success
  lastFailure: string;  // ISO timestamp of most recent failure
  lastError: string;    // truncated error text, for `heartbeat status`
}

interface HeartbeatState {
  lastChecks: Record<string, string>;
  /**
   * Consecutive-failure record per task (added 2026-09-01).
   *
   * Deliberately SEPARATE from lastChecks: a failed task must never receive a
   * success timestamp, or a permanently-broken task reads as "Last run: 5m ago"
   * in `heartbeat status` while never once succeeding — the cosmetic-green
   * failure mode (SF-010). Backoff keeps the queue moving; visibility keeps the
   * failure loud.
   */
  failures?: Record<string, TaskFailure>;
}

/**
 * How long a task stays skipped after N consecutive failures.
 * 30m, 1h, 2h, 4h, then capped at 6h. Without this a task that fails fast
 * (e.g. exhausting --max-turns) is re-selected as most-overdue on the very
 * next tick forever, starving every other task behind it — the head-of-line
 * blocking observed 2026-09-01.
 */
function failureBackoffMs(count: number): number {
  const THIRTY_MIN = 30 * 60 * 1000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  return Math.min(THIRTY_MIN * Math.pow(2, Math.max(0, count - 1)), SIX_HOURS);
}

function readState(root: string): HeartbeatState {
  const stateFile = join(root, 'heartbeat-state.json');
  if (!existsSync(stateFile)) return { lastChecks: {}, failures: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return { lastChecks: parsed.lastChecks ?? {}, failures: parsed.failures ?? {} };
  } catch {
    return { lastChecks: {}, failures: {} };
  }
}

function writeState(root: string, state: HeartbeatState): void {
  const stateFile = join(root, 'heartbeat-state.json');
  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

export function markBusy(isBusy: boolean): void {
  busy = isBusy;
}

export async function startHeartbeat(root: string): Promise<ServiceHandle> {
  const identity = getIdentityForRoot(root);
  const intervalStr = identity.heartbeat_interval || '1h';
  const intervalMs = parseIntervalMs(intervalStr);
  logger.info(`Heartbeat interval: ${intervalMs / 1000 / 60} minutes`);

  running = true;

  // Initial delay before first tick
  const initialDelay = 5 * 60 * 1000; // 5 minutes
  setTimeout(() => {
    tick(root);
    intervalId = setInterval(() => tick(root), intervalMs);
  }, initialDelay);

  return {
    stop: async () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      running = false;
    },
    status: () => (running ? 'running' : 'stopped'),
  };
}

async function tick(root: string): Promise<void> {
  // Record every tick — even ones that short-circuit below — so `lastBeat`
  // answers "is the timer alive," not "did Claude run."
  lastBeatByRoot.set(root, Date.now());

  // Skip if user is actively chatting
  if (busy) {
    logger.debug('Skipping heartbeat — user session is active');
    return;
  }

  // Check active hours
  if (!isWithinActiveHours(root)) {
    logger.debug('Outside active hours — skipping');
    return;
  }

  // ── Orchestration heartbeat ─────────────────────────────────────
  // CEO and workers run on the orchestration interval (from settings),
  // which may differ from the standard heartbeat interval (from identity.yaml).
  try {
    const { getCeoAgent, getOrgNode, getOrchestrationSettings, listIssues } = await import('../orchestration/index.js');
    const { runCeoHeartbeat } = await import('../orchestration/ceo-heartbeat.js');
    const { runWorkerHeartbeat } = await import('../orchestration/worker-heartbeat.js');
    const settings = getOrchestrationSettings();

    if (settings.orchestration_enabled) {
      const identity = getIdentityForRoot(root);
      const agentName = identity.agent_name;

      // Check if enough time has passed since last orchestration tick for this agent
      const orchIntervalMs = parseIntervalMs(settings.heartbeat_interval || '1h');
      const lastTick = lastOrchTick.get(agentName) || 0;
      const elapsed = Date.now() - lastTick;

      if (elapsed >= orchIntervalMs) {
        lastOrchTick.set(agentName, Date.now());

        const ceo = getCeoAgent();
        if (ceo && ceo.agent_name === agentName) {
          logger.info(`Running CEO orchestration heartbeat (interval: ${settings.heartbeat_interval})`);
          await runCeoHeartbeat(root, agentName);
        } else {
          const orgNode = getOrgNode(agentName);
          if (orgNode) {
            const todoIssues = listIssues({ assigned_to: agentName, status: ['todo', 'in_progress'] });
            if (todoIssues.length > 0) {
              logger.info(`Worker ${agentName} has ${todoIssues.length} assigned issue(s), running heartbeat`);
              await runWorkerHeartbeat(root, agentName, orgNode.role, orgNode.title || agentName);
            }
          }
        }
      } else {
        logger.debug(`Orchestration tick skipped for ${agentName} — ${Math.round((orchIntervalMs - elapsed) / 1000)}s remaining`);
      }
    }
  } catch {
    // Orchestration not initialized — that's fine, skip
  }

  // ── Standard heartbeat ──────────────────────────────────────────

  // Skip if HEARTBEAT.md doesn't exist or is empty
  const heartbeatPath = join(root, 'HEARTBEAT.md');
  if (!existsSync(heartbeatPath)) {
    logger.debug('No HEARTBEAT.md found — skipping');
    return;
  }

  const content = readFileSync(heartbeatPath, 'utf-8').trim();
  if (!content || !content.includes('## Tasks')) {
    logger.debug('HEARTBEAT.md has no tasks — skipping');
    return;
  }

  // Deterministic task selection: parse schedules, pick the single most
  // overdue task, and tell Claude exactly which one to run. Before this,
  // task selection was delegated to Claude — which led to brain-health
  // monopolising every tick because it was always seen as "due" while
  // time-of-day tasks (e.g. `daily 21:00 SGT`) were misinterpreted.
  const fallbackTz =
    getIdentityForRoot(root).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tasks = parseHeartbeatTasks(content);
  let state = readState(root);
  const dispatched = pickMostOverdueTask(tasks, state.lastChecks, new Date(), fallbackTz, state.failures ?? {});
  if (!dispatched) {
    logger.debug(`Heartbeat skipped — no task due yet (${tasks.length} scheduled)`);
    return;
  }
  logger.info(`Heartbeat dispatching task: ${dispatched.name}`);

  try {
    // Extract referenced skills from tasks and inline their content
    const skillSections: string[] = [];
    const skillRefs = content.match(/\*\*Skill\*\*:\s*(\S+)/g);
    if (skillRefs) {
      for (const ref of skillRefs) {
        const skillName = ref.replace(/\*\*Skill\*\*:\s*/, '').trim();
        const skill = getSkill(skillName, root);
        if (skill) {
          try {
            const skillContent = readFileSync(join(skill.path, 'SKILL.md'), 'utf-8');
            skillSections.push(`--- Skill: ${skillName} (skills/${skillName}/SKILL.md) ---`);
            skillSections.push(skillContent);
            skillSections.push('');
          } catch {
            logger.warn(`Failed to read skill: ${skillName}`);
          }
        }
      }
    }

    const promptParts = [
      'You are executing a heartbeat task. The scheduler has already picked the task —',
      `you MUST execute exactly this one and no other: "${dispatched.name}".`,
      '',
      '1. Locate the task block in HEARTBEAT.md below.',
      '2. If it has a **Skill** reference, the full skill instructions are included — follow them step by step.',
      '3. If it has no **Skill** reference, execute the **Action** verbatim.',
      '4. Do NOT update heartbeat-state.json — the scheduler records the run time automatically.',
      '5. If the task itself decides to skip (e.g. "skip Sunday" condition), reply: HEARTBEAT_OK',
      '',
      '--- HEARTBEAT.md ---',
      content,
      '',
      '--- heartbeat-state.json (read-only reference) ---',
      JSON.stringify(state, null, 2),
      '',
      ...(skillSections.length > 0 ? skillSections : []),
      `Current time: ${new Date().toISOString()}`,
      `Timezone: ${fallbackTz}`,
    ];

    // Fleet awareness — let heartbeat know about other agents
    try {
      const { getActiveBus } = await import('../runtime/agent-bus.js');
      const { buildFleetAwarenessSection } = await import('../runtime/agent-runtime.js');
      const bus = getActiveBus();
      if (bus) {
        const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
        const fleetSection = buildFleetAwarenessSection(bus, agentName);
        if (fleetSection) promptParts.push('', fleetSection);

        // Pending notifications from other agents
        const notifications = bus.getPendingNotifications(agentName);
        if (notifications.length > 0) {
          promptParts.push('', '## Pending Notifications from Other Agents', '');
          for (const n of notifications) {
            promptParts.push(`- **[${n.from}]** (${(n as any).topic || 'general'}): ${n.payload.slice(0, 200)}`);
          }
          promptParts.push('', 'Review these and take action if relevant.');
        }
      }
    } catch { /* not in fleet mode */ }

    // Worker orchestration context — inject assigned issues and tools
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { getWorkerOrchestrationContext } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        const orchContext = getWorkerOrchestrationContext(agentName);
        if (orchContext) promptParts.push(orchContext);
      }
    } catch { /* orchestration not initialized */ }

    const prompt = promptParts.join('\n');

    const client = getClaudeClient();
    const result = await client.complete(prompt, {
      maxTurns: 40, // was 15 — too low for large sweeps (Brain Health Check diffs 1,093 files and exhausted it every tick, 2026-09-01)
      subprocess: true,
      cwd: root,
      model: getHeartbeatModelForRoot(root),
      system: [
        'You are a heartbeat task executor for a KyberBot agent.',
        'You have full tool access — you can run Bash commands, read/write files, and make HTTP requests.',
        'When a task references a **Skill**, follow the skill instructions exactly as written.',
        'Execute only the single most overdue task, then stop.',
        'If nothing needs attention, reply HEARTBEAT_OK.',
      ].join(' '),
    });

    // Process orchestration tool calls from worker agents
    try {
      const { getOrgNode } = await import('../orchestration/index.js');
      const { processWorkerToolCalls } = await import('../orchestration/worker-heartbeat.js');
      const agentName = getIdentityForRoot(root).agent_name || 'KyberBot';
      const orgNode = getOrgNode(agentName);
      if (orgNode && !orgNode.is_ceo) {
        processWorkerToolCalls(result, agentName);
      }
    } catch { /* orchestration not initialized */ }

    // Suppress HEARTBEAT_OK
    if (result.trim() === 'HEARTBEAT_OK') {
      logger.debug(`Heartbeat: task ${dispatched.name} returned OK (skipped by task logic)`);
    } else {
      logger.info('Heartbeat result:', { task: dispatched.name, result: result.substring(0, 200), heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });

      // Log to heartbeat log
      const heartbeatLog = join(root, 'logs', 'heartbeat.log');
      const logDir = dirname(heartbeatLog);
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        heartbeatLog,
        `\n--- ${new Date().toISOString()} [${dispatched.name}] ---\n${result}\n`,
        'utf-8'
      );

      // Fire-and-forget: store heartbeat result in memory
      storeConversation(root, {
        prompt: 'Heartbeat task execution',
        response: result,
        channel: 'heartbeat',
      }).catch((err) => logger.warn('Memory storage failed', { error: String(err) }));
    }

    // Canonical state update: scheduler owns the timestamp, regardless of
    // whether Claude also wrote anywhere. Re-read first to merge any
    // concurrent edits from the task itself.
    try {
      state = readState(root);
      state.lastChecks[dispatched.name] = new Date().toISOString();
      if (state.failures?.[dispatched.name]) delete state.failures[dispatched.name];
      writeState(root, state);
    } catch (err) {
      logger.warn('Failed to record heartbeat run time', { task: dispatched.name, error: String(err) });
    }
  } catch (error) {
    // Record the failure WITHOUT touching lastChecks. The task keeps its real
    // staleness (so it is not silently "done"), but backs off so it cannot
    // re-win every tick and starve the queue.
    let count = 1;
    try {
      state = readState(root);
      state.failures = state.failures ?? {};
      count = (state.failures[dispatched.name]?.count ?? 0) + 1;
      state.failures[dispatched.name] = {
        count,
        lastFailure: new Date().toISOString(),
        lastError: String(error).slice(0, 300),
      };
      writeState(root, state);
    } catch (err) {
      logger.warn('Failed to record heartbeat failure', { task: dispatched.name, error: String(err) });
    }
    logger.error('Heartbeat tick failed', {
      task: dispatched.name,
      error: String(error),
      consecutiveFailures: count,
      backoffMinutes: Math.round(failureBackoffMs(count) / 60000),
    });
  }
}

function isWithinActiveHours(root: string): boolean {
  try {
    const identity = getIdentityForRoot(root);
    const activeHours = identity.heartbeat_active_hours;

    if (!activeHours) return true; // No restriction

    const tz = activeHours.timezone || identity.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const timeStr = formatter.format(now);
    const [h, m] = timeStr.split(':').map(Number);
    const currentMinutes = h * 60 + m;

    const [startH, startM] = activeHours.start.split(':').map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = activeHours.end.split(':').map(Number);
    const endMinutes = endH * 60 + endM;

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  } catch {
    return true; // Default to allowing
  }
}
