/**
 * KyberBot — Worker Orchestration Heartbeat
 *
 * Runs a worker agent's assigned tasks. The worker:
 * 1. Checks out the issue (in_progress)
 * 2. Does the actual work
 * 3. Comments on the issue with results
 * 4. Transitions the issue (done/in_review/blocked)
 *
 * Steps 1, 3, and 4 are done programmatically AROUND the Claude call,
 * not as optional tool calls that Claude might skip.
 */

import { createLogger } from '../logger.js';
import {
  listIssues, getComments, checkoutIssue, transitionIssue, addComment,
  createInboxItem, listArtifacts,
} from './index.js';
import { createRun, completeRun, failRun, appendRunLog, countRecentFailures } from './runs.js';
import { transitionPhase, RunPhase } from './run-phases.js';
import { canDispatch, type ConcurrencyConfig } from './reconcile.js';
import { runConfiguredHook, type HooksConfig } from '../runtime/hooks.js';
import { getClaudeClient, AGENT_FACING_ALLOWED_TOOLS } from '../claude.js';
import { getIdentityForRoot } from '../config.js';
import { setCurrentIssueId } from './tools.js';
import type { Issue } from './types.js';

const logger = createLogger('worker-heartbeat');

// ═══════════════════════════════════════════════════════════════════════════════
// SERIAL QUEUE — only one heartbeat runs at a time
// ═══════════════════════════════════════════════════════════════════════════════

const heartbeatQueue: Array<() => Promise<void>> = [];
let isProcessing = false;
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per heartbeat

// Symphony §8.4: a clean worker exit with the issue still in_progress
// schedules a fresh worker session this many ms later. The spec hardcodes
// 1000ms; we match.
const CONTINUATION_RETRY_MS = 1000;

/**
 * Outcome of one runWorkerHeartbeat call. `status` is `'noop'` when no
 * dispatch happened (no work, concurrency gate, etc.) and otherwise
 * reflects the parsed STATUS line of the agent's final turn.
 */
export interface WorkerRunResult {
  summary: string;
  status: 'noop' | 'done' | 'in_review' | 'blocked' | 'in_progress';
}

/**
 * In-memory carry-over for cross-run continuation. When a worker run
 * exits cleanly with status='in_progress' (i.e. it hit worker_max_turns
 * without reaching DONE/REVIEW/BLOCKED), we stash the tail of its final
 * output here. The post-exit retry (1s later) consumes the entry and
 * builds a continuation prompt instead of resending the original task
 * prompt — so the agent picks up with context, not from scratch.
 *
 * Keyed by issue id. Entries are consumed on the next dispatch for that
 * issue, so a single in_progress exit only affects the immediately
 * following dispatch. Process restart drops all entries (we recover
 * from filesystem + comments instead).
 */
const pendingContinuations = new Map<number, { tail: string; turnIndex: number }>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`Heartbeat timeout after ${ms / 1000}s: ${label}`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timerId!));
}

/**
 * Process queued heartbeats sequentially. The isProcessing flag prevents
 * concurrent execution. This is safe because:
 * 1. Node.js is single-threaded — no true parallel access to isProcessing
 * 2. Each task is awaited before the next starts
 * 3. New items added during processing are picked up by the while loop
 * 4. If processQueue() is called while already processing, it returns immediately
 *    but the running loop will pick up any newly added items
 */
async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  while (heartbeatQueue.length > 0) {
    const task = heartbeatQueue.shift()!;
    try {
      await withTimeout(task(), HEARTBEAT_TIMEOUT_MS, 'queued heartbeat');
    } catch (err) {
      logger.error('Queue task failed', { error: String(err) });
    }
  }
  isProcessing = false;
}

/**
 * Queue a worker heartbeat for serial execution. If another heartbeat is
 * already running, the new one waits until the current one finishes.
 * Fire-and-forget — does not return a result.
 *
 * Symphony §8.4 post-exit continuation: when a run exits cleanly with
 * status='in_progress' (i.e. the inner worker loop hit `worker_max_turns`
 * without reaching a terminal STATUS), schedule a fresh worker session
 * 1s later instead of waiting for the next heartbeat tick. The chain
 * naturally terminates when the agent emits DONE/IN_REVIEW/BLOCKED, when
 * the issue moves out from under the agent (CEO reassigns, external
 * source cancels via reconcile), or when concurrency/failure gates fire.
 */
export function queueWorkerHeartbeat(
  root: string,
  agentName: string,
  agentRole: string,
  agentTitle: string,
): void {
  heartbeatQueue.push(async () => {
    let result: WorkerRunResult;
    try {
      result = await runWorkerHeartbeat(root, agentName, agentRole, agentTitle);
    } catch {
      // Failure path already handled inside runWorkerHeartbeat (failRun + issue
      // back to todo). Don't continuation-retry on errors — the next heartbeat
      // tick will pick it up after backoff.
      return;
    }
    if (result.status === 'in_progress') {
      logger.info(`Scheduling continuation retry for ${agentName} in ${CONTINUATION_RETRY_MS}ms (run ended in_progress)`);
      setTimeout(
        () => queueWorkerHeartbeat(root, agentName, agentRole, agentTitle),
        CONTINUATION_RETRY_MS,
      ).unref?.();
    }
  });
  processQueue();
}

/**
 * Queue a CEO heartbeat for serial execution (same queue as workers).
 */
export function queueCeoHeartbeat(
  root: string,
  agentName: string,
  runCeoFn: (root: string, agentName: string) => Promise<string>,
): void {
  heartbeatQueue.push(() => runCeoFn(root, agentName).then(() => {}));
  processQueue();
}

/**
 * Run a full worker heartbeat for the given agent.
 * Picks their highest-priority todo/in_progress issue, does the work,
 * comments with results, and transitions the issue.
 */
export async function runWorkerHeartbeat(
  root: string,
  agentName: string,
  agentRole: string,
  agentTitle: string,
): Promise<WorkerRunResult> {
  // Find assigned issues
  const inProgress = listIssues({ assigned_to: agentName, status: 'in_progress' });
  const todo = listIssues({ assigned_to: agentName, status: 'todo' });

  // Prioritize in_progress first, then highest priority todo
  let targetIssue = inProgress[0] || todo[0];
  if (!targetIssue) {
    return { summary: 'No assigned work.', status: 'noop' };
  }

  // Phase 3: Per-agent concurrency gate. If the agent is at its
  // max_concurrent_runs or max_by_state limit, defer dispatch to the
  // next tick rather than running anyway. Limits live in identity.yaml.
  const concurrency = loadAgentConcurrency(root);
  const gate = canDispatch(agentName, concurrency, targetIssue.status);
  if (!gate.allowed) {
    logger.info(`Skipping worker heartbeat for ${agentName}: ${gate.reason}`);
    return { summary: `Skipped: ${gate.reason}`, status: 'noop' };
  }

  // Check if this issue has failed too many times
  const failures = countRecentFailures(agentName, targetIssue.id);
  if (failures >= 3) {
    logger.warn(`Issue KYB-${targetIssue.id} has failed ${failures} times for ${agentName}, moving to blocked`);
    try {
      addComment(targetIssue.id, agentName, `Automatically blocked: ${failures} consecutive failures in the last 24 hours. Needs human review or task decomposition.`);
      transitionIssue(targetIssue.id, 'blocked', agentName);
    } catch { /* ignore */ }
    // Try the next issue
    const nextIssue = [...inProgress, ...todo].find(i => i.id !== targetIssue.id);
    if (!nextIssue) {
      return {
        summary: `Issue KYB-${targetIssue.id} blocked due to ${failures} failures. Will pick up other work on next heartbeat.`,
        status: 'noop',
      };
    }
    targetIssue = nextIssue;
  }

  const runId = createRun(agentName, 'worker');

  // Resolve loop / retry / turn-cap config up front so prompt building
  // and the dispatch loop both see the same values.
  const {
    getHeartbeatModelForRoot,
    getHeartbeatMaxInnerTurnsForRoot,
    getLoopDetectionConfigForRoot,
    getSubprocessRetryConfigForRoot,
  } = await import('../config.js');
  const maxWorkerTurns = Math.max(1, getIdentityForRoot(root).worker_max_turns ?? 5);
  const maxInnerTurns = getHeartbeatMaxInnerTurnsForRoot(root);
  const loopDetection = getLoopDetectionConfigForRoot(root);
  const subprocessRetry = getSubprocessRetryConfigForRoot(root);

  try {
    // Phase: PreparingWorkspace — checkout the issue, then run before_run hook
    transitionPhase(runId, RunPhase.PreparingWorkspace);
    try {
      checkoutIssue(targetIssue.id, agentName);
      logger.info(`Worker ${agentName} checked out issue KYB-${targetIssue.id}`);
    } catch {
      // Already checked out or in_progress — fine
    }

    const hooks = loadAgentHooks(root);
    const beforeRunResult = await runConfiguredHook('before_run', hooks, {
      cwd: root,
      env: { KYBERBOT_ISSUE_ID: String(targetIssue.id), KYBERBOT_AGENT: agentName },
    });
    if (beforeRunResult && !beforeRunResult.success) {
      const reason = beforeRunResult.timedOut ? 'timeout' : `exit ${beforeRunResult.exitCode}`;
      const stderrPreview = beforeRunResult.stderr.slice(0, 500) || 'no stderr';
      // Non-fatal by default — record the failure in phase_history and
      // continue with the run. The strict Symphony §9.4 semantic (fatal)
      // is opt-in per agent via hooks.fatal_on_before_run: true.
      if (hooks?.fatal_on_before_run === true) {
        throw new Error(`before_run hook failed (${reason}): ${stderrPreview}`);
      }
      logger.warn('before_run hook failed but non-fatal — continuing run', { reason, stderrPreview });
      transitionPhase(runId, RunPhase.PreparingWorkspace, `before_run failed (${reason}); continued`);
      appendRunLog(runId, `\n[hooks] before_run failed (${reason}): ${stderrPreview}\n[hooks] continuing run anyway\n`);
    }

    // Phase: BuildingPrompt
    transitionPhase(runId, RunPhase.BuildingPrompt);

    // Cross-run continuation: if the previous run for this issue exited
    // in_progress, the post-exit retry left context behind. Use the
    // continuation prompt to pick up where we left off — same shape as
    // the inner-loop continuation, just spanning a run boundary.
    const continuation = pendingContinuations.get(targetIssue.id);
    if (continuation) {
      pendingContinuations.delete(targetIssue.id);
      logger.info(`Cross-run continuation for issue KYB-${targetIssue.id} (turn ${continuation.turnIndex})`);
      transitionPhase(runId, RunPhase.BuildingPrompt, `cross-run continuation from turn ${continuation.turnIndex}`);
      appendRunLog(runId, `\n[runtime] resuming issue KYB-${targetIssue.id} via cross-run continuation\n`);
    }

    const recentComments = getComments(targetIssue.id);
    const commentContext = recentComments.length > 0
      ? '\n\nRecent comments on this issue:\n' + recentComments.slice(-5).map(c => `${c.author_agent}: ${c.content}`).join('\n')
      : '';

    const prompt = continuation
      ? buildContinuationPrompt(targetIssue, continuation.tail, continuation.turnIndex + 1, maxWorkerTurns + continuation.turnIndex)
      : [
      `You are ${agentTitle}, ${agentRole}.`,
      `Your working directory is: ${root}`,
      '',
      `## Your Current Task`,
      '',
      `**Issue KYB-${targetIssue.id}: ${targetIssue.title}**`,
      `Priority: ${targetIssue.priority}`,
      `Status: in_progress (checked out to you)`,
      '',
      targetIssue.description || 'No description provided.',
      commentContext,
      '',
      '## Instructions',
      '',
      'Complete this task. You are running in fully autonomous mode with unrestricted permissions.',
      '',
      '**Scope rules:**',
      '- Stay focused on THIS issue only. Do not explore unrelated systems.',
      '- Work within your agent directory and the project scope. Do not explore unrelated directories, systems, or services outside the task.',
      '- If the task is too large to complete in one pass, do the most impactful part and report STATUS: IN_PROGRESS with what remains.',
      '- Do not spend more than 15-20 tool calls on a single task. If you are going in circles, report STATUS: BLOCKED with what is stopping you.',
      '- If you need information from another agent, add a comment on the issue with @agentname asking your question. They will be notified and can respond.',
      '- If you discover new work that needs doing (not part of this issue), use create_backlog_issue to log it. The CEO will review and prioritize.',
      '- If another agent tagged you in a comment with useful context, incorporate it into your current work. Do NOT create a new task for it unless it is genuinely separate work.',
      '- When you create a deliverable file, mention its full path in your summary so it can be tracked.',
      '- Do NOT use the agent bus for orchestration communication — use issue comments so everything is tracked.',
      '',
      'When you are done, write a concise summary of:',
      '1. What you did',
      '2. What the outcome/deliverables are',
      '3. Whether the task is DONE, needs REVIEW, or is BLOCKED (and why)',
      '',
      'Start your final summary with one of these status lines:',
      '- STATUS: DONE — if the task is fully complete',
      '- STATUS: IN_REVIEW — if it needs someone to review your work',
      '- STATUS: BLOCKED — if you hit a blocker you cannot resolve yourself (missing API key, missing permissions, need human input, dependency on another task, etc.)',
      '- STATUS: IN_PROGRESS — if you made progress but need another pass to finish',
    ].join('\n');

    // Phase: LaunchingAgent → InitializingSession → StreamingTurn (looped)
    //
    // Symphony §7.1 worker loop: if a turn ends with STATUS: IN_PROGRESS,
    // immediately re-prompt the agent with the tail of its previous output
    // as context (approach (a) — context-via-prompt rather than warm-thread,
    // since each client.complete() call is a fresh subprocess). Up to
    // `worker_max_turns` turns per run (default 5).
    transitionPhase(runId, RunPhase.LaunchingAgent);
    setCurrentIssueId(targetIssue.id);
    const client = getClaudeClient();
    let result = '';
    let turnCount = 0;
    let parsedStatus: 'done' | 'in_review' | 'blocked' | 'in_progress' = 'in_progress';

    try {
      while (turnCount < maxWorkerTurns) {
        turnCount++;
        const turnPrompt = turnCount === 1
          ? prompt
          : buildContinuationPrompt(targetIssue, result, turnCount, maxWorkerTurns);

        if (turnCount === 1) {
          transitionPhase(runId, RunPhase.InitializingSession);
        }
        transitionPhase(
          runId,
          RunPhase.StreamingTurn,
          turnCount === 1 ? undefined : `continuation turn ${turnCount}/${maxWorkerTurns}`,
        );
        appendRunLog(runId, `\n--- TURN ${turnCount} of up to ${maxWorkerTurns} ---\n`);

        // Transient-error retry-with-backoff. Symphony §8.4 formula:
        // delay = min(base * 2^(attempt-1), max). Default 3 attempts.
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          attempt++;
          try {
            result = await client.complete(turnPrompt, {
              maxTurns: maxInnerTurns,
              subprocess: true,
              cwd: root,
              model: getHeartbeatModelForRoot(root),
              onChunk: (chunk) => appendRunLog(runId, chunk),
              loopDetection: {
                enabled: loopDetection.enabled,
                maxIdenticalToolCalls: loopDetection.maxIdenticalToolCalls,
                maxConsecutiveToolErrors: loopDetection.maxConsecutiveToolErrors,
              },
              // GATE 3 fix (Alfred, 9 Sep 2026): unlike the CEO, the worker
              // actually does the task (creates deliverable files, per its own
              // prompt above) — needs real tools, same allowlist chat-sse.ts's
              // interactive session uses.
              allowedTools: AGENT_FACING_ALLOWED_TOOLS,
            });
            break; // success
          } catch (err) {
            if (attempt >= subprocessRetry.maxAttempts) {
              logger.error(`subprocess attempt ${attempt}/${subprocessRetry.maxAttempts} failed — giving up`, { error: String(err) });
              throw err;
            }
            const backoffMs = Math.min(
              subprocessRetry.baseBackoffMs * Math.pow(2, attempt - 1),
              subprocessRetry.maxBackoffMs,
            );
            logger.warn(`subprocess attempt ${attempt}/${subprocessRetry.maxAttempts} failed — retrying in ${backoffMs}ms`, { error: String(err) });
            appendRunLog(runId, `\n[runtime] subprocess error on attempt ${attempt}/${subprocessRetry.maxAttempts}; retrying in ${Math.round(backoffMs / 1000)}s\n`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }

        // Auto-detect deliverables per turn so partial progress is tracked
        // even if the next turn errors out before the run completes.
        try {
          const { createArtifact } = await import('./artifacts.js');
          const { existsSync } = await import('fs');
          const fileMatches = result.match(/\/Users\/[^\s\)\}\`\"\'\,]+\.(?:md|txt|json|yaml|yml|ts|js|csv|html)/g);
          if (fileMatches) {
            const seen = new Set<string>();
            for (const filePath of fileMatches) {
              const cleaned = filePath.replace(/[.\)\]]+$/, '');
              if (seen.has(cleaned)) continue;
              seen.add(cleaned);
              if (existsSync(cleaned)) {
                createArtifact({
                  file_path: cleaned,
                  description: `Created during KYB-${targetIssue.id}: ${targetIssue.title}`,
                  agent_name: agentName,
                  issue_id: targetIssue.id,
                });
                logger.info(`Auto-detected artifact: ${cleaned}`, { agent: agentName, issue: targetIssue.id });
              }
            }
          }
        } catch (err) {
          logger.debug('Artifact auto-detection failed', { error: String(err) });
        }

        // Parse status from this turn's output to decide whether to continue
        if (result.includes('STATUS: DONE')) { parsedStatus = 'done'; break; }
        if (result.includes('STATUS: IN_REVIEW')) { parsedStatus = 'in_review'; break; }
        if (result.includes('STATUS: BLOCKED')) { parsedStatus = 'blocked'; break; }
        // Default & explicit IN_PROGRESS both fall through to the next turn,
        // unless we've hit max_turns — in which case we exit with in_progress
        // status and the next heartbeat tick picks the issue back up.
      }
      if (turnCount >= maxWorkerTurns && parsedStatus === 'in_progress') {
        appendRunLog(runId, `\n--- HIT worker_max_turns (${maxWorkerTurns}); exiting; next heartbeat will resume ---\n`);
      }
    } finally {
      setCurrentIssueId(null);
    }

    // Phase: Finishing — post comment, transition issue
    transitionPhase(runId, RunPhase.Finishing);
    const newStatus = parsedStatus;

    // Step 5: Add a comment with the results
    const commentBody = result.length > 2000
      ? result.slice(-2000) // Take the tail which has the summary
      : result;

    // Extract just the summary part if possible
    const summaryMatch = result.match(/STATUS:[\s\S]*$/);
    const summaryText = summaryMatch ? summaryMatch[0] : commentBody.slice(-1000);

    addComment(targetIssue.id, agentName, summaryText);
    logger.info(`Worker ${agentName} commented on issue KYB-${targetIssue.id}`);

    // Step 6: Transition the issue
    if (newStatus !== 'in_progress') {
      try {
        transitionIssue(targetIssue.id, newStatus, agentName);
        logger.info(`Worker ${agentName} transitioned issue KYB-${targetIssue.id} to ${newStatus}`);
      } catch (err) {
        logger.warn(`Failed to transition issue KYB-${targetIssue.id} to ${newStatus}`, { error: String(err) });
      }
    }

    // Step 6b: When a task fully completes, drop a "completed" notification
    // into the inbox with the agent's summary. The desktop's Completed tab
    // joins the issue's artifacts (auto-detected upstream during the run)
    // for FYI display. BLOCKED stays out — it uses the existing
    // escalate_to_human flow, IN_REVIEW intentionally stays out (per user).
    if (newStatus === 'done') {
      try {
        const artifactCount = listArtifacts({ issue_id: targetIssue.id }).length;
        const artifactSuffix = artifactCount > 0 ? ` (${artifactCount} artifact${artifactCount === 1 ? '' : 's'})` : '';
        createInboxItem({
          source_agent: agentName,
          title: `Completed: ${targetIssue.title}${artifactSuffix}`,
          body: summaryText.slice(0, 4000),
          urgency: 'low',
          kind: 'completed',
          related_issue_id: targetIssue.id,
        });
        logger.info(`Inbox notification posted for completed KYB-${targetIssue.id}`, { artifactCount });
      } catch (err) {
        logger.warn(`Failed to post completed-inbox item for KYB-${targetIssue.id}`, { error: String(err) });
      }
    }

    const summary = `Issue KYB-${targetIssue.id}: ${newStatus}. ${summaryText.slice(0, 300)}`;

    // after_run hook (best-effort; failures logged but don't change run outcome)
    await runConfiguredHook('after_run', hooks, {
      cwd: root,
      env: {
        KYBERBOT_ISSUE_ID: String(targetIssue.id),
        KYBERBOT_AGENT: agentName,
        KYBERBOT_RUN_STATUS: newStatus,
      },
    });

    completeRun(runId, { result_summary: summary, log_output: result });

    // Stash tail for cross-run continuation when the post-exit retry
    // fires for this same issue. Only when the run ended in_progress.
    if (parsedStatus === 'in_progress') {
      const priorTurnIndex = continuation?.turnIndex ?? 0;
      pendingContinuations.set(targetIssue.id, {
        tail: result.length > 2000 ? result.slice(-2000) : result,
        turnIndex: priorTurnIndex + maxWorkerTurns,
      });
    }

    return { summary, status: parsedStatus };

  } catch (err) {
    // Try to run after_run even on failure so cleanup hooks can fire
    try {
      const hooks = loadAgentHooks(root);
      await runConfiguredHook('after_run', hooks, {
        cwd: root,
        env: {
          KYBERBOT_ISSUE_ID: String(targetIssue.id),
          KYBERBOT_AGENT: agentName,
          KYBERBOT_RUN_STATUS: 'failed',
        },
      });
    } catch { /* ignore */ }

    failRun(runId, (err as Error).message);
    // Comment the failure and move issue back to todo so it can be retried
    try {
      addComment(targetIssue.id, agentName, `Heartbeat failed: ${(err as Error).message}. Moving back to todo for retry.`);
      transitionIssue(targetIssue.id, 'todo', agentName);
      logger.info(`Issue KYB-${targetIssue.id} moved back to todo after failure`);
    } catch { /* ignore transition errors */ }
    throw err;
  }
}

/**
 * Build a continuation prompt for turn N≥2. The agent saw the full task
 * prompt on turn 1; here we just remind it what it's working on, give it
 * the tail of its own previous output for context, and tell it to keep
 * going. Mirrors Symphony §7.1's "continuation turns SHOULD send only
 * continuation guidance".
 */
export function buildContinuationPrompt(issue: Issue, previousOutput: string, turnIndex: number, maxTurns: number): string {
  // Tail of previous output — that's where the summary + STATUS line live
  const tail = previousOutput.length > 2000 ? previousOutput.slice(-2000) : previousOutput;
  return [
    `You are continuing work on **issue KYB-${issue.id}: ${issue.title}**.`,
    '',
    `This is continuation turn ${turnIndex} of up to ${maxTurns}. Your previous turn ended with STATUS: IN_PROGRESS, meaning you made progress but said you needed another pass.`,
    '',
    '## Tail of your previous turn',
    '',
    '```',
    tail,
    '```',
    '',
    '## Continue',
    '',
    'Pick up from where you left off and make further progress. Same scope rules apply:',
    '- Stay focused on this issue only',
    '- Do not spend more than 15-20 tool calls on this turn',
    '- If you hit a real blocker, end with STATUS: BLOCKED',
    '- If you finish, end with STATUS: DONE or STATUS: IN_REVIEW',
    '- If you still need another pass after this turn, end with STATUS: IN_PROGRESS',
    '',
    'Do NOT redo work you already finished in your previous turn — the filesystem reflects that work, and re-doing it wastes the loop budget.',
    '',
    `Current time: ${new Date().toISOString()}`,
  ].join('\n');
}

/**
 * Read concurrency config from an agent's identity.yaml. Returns {} when
 * unset so callers don't have to special-case unconfigured agents.
 */
function loadAgentConcurrency(root: string): ConcurrencyConfig {
  try {
    return getIdentityForRoot(root).concurrency ?? {};
  } catch {
    return {};
  }
}

/**
 * Read hooks config from an agent's identity.yaml.
 */
function loadAgentHooks(root: string): HooksConfig {
  try {
    return (getIdentityForRoot(root).hooks ?? {}) as HooksConfig;
  } catch {
    return {};
  }
}

/**
 * Build orchestration context to inject into the standard heartbeat prompt.
 * Used when the agent runs via the regular heartbeat tick (not a direct trigger).
 * Returns empty string if the agent has no assigned work.
 */
export function getWorkerOrchestrationContext(agentName: string): string {
  const sections: string[] = [];

  const inProgress = listIssues({ assigned_to: agentName, status: 'in_progress' });
  const todo = listIssues({ assigned_to: agentName, status: 'todo' });
  const blocked = listIssues({ assigned_to: agentName, status: 'blocked' });

  const totalAssigned = inProgress.length + todo.length + blocked.length;
  if (totalAssigned === 0) return '';

  sections.push('');
  sections.push('## Your Orchestration Assignments');
  sections.push('');
  sections.push(`You have ${totalAssigned} issue(s) assigned to you.`);

  for (const issue of [...inProgress, ...todo, ...blocked]) {
    const comments = getComments(issue.id);
    sections.push(`- **KYB-${issue.id}** [${issue.status}] [${issue.priority}] ${issue.title}`);
    if (issue.description) sections.push(`  ${issue.description.slice(0, 200)}`);
    if (comments.length > 0) {
      const last = comments[comments.length - 1];
      sections.push(`  Last: ${last.author_agent}: ${last.content.slice(0, 150)}`);
    }
  }

  return sections.join('\n');
}

/**
 * Process tool calls from a worker agent's heartbeat response.
 * This is the legacy path — kept for backward compatibility with
 * standard heartbeat ticks that inject orchestration context.
 */
export function processWorkerToolCalls(responseText: string, agentName: string): void {
  // Import parseToolCalls and executeTool dynamically to avoid circular deps
  import('./tools.js').then(({ parseToolCalls, executeTool }) => {
    const toolCalls = parseToolCalls(responseText);
    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      try {
        executeTool(call.name, call.params, agentName);
      } catch (error) {
        logger.error(`Worker tool call failed: ${call.name}`, { agent: agentName, error: String(error) });
      }
    }
    logger.info(`Worker ${agentName}: ${toolCalls.length} orchestration tool calls processed`);
  }).catch((err) => logger.warn('Failed to load tools module for worker tool calls', { error: String(err) }));
}
