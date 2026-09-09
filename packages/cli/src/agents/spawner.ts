/**
 * KyberBot — Agent Spawner
 *
 * Bridges agent definitions to Claude execution.
 * Loads an agent's .md file, builds a system prompt with identity context,
 * and runs the prompt through ClaudeClient.complete().
 */

import { readFileSync, existsSync } from 'fs';
import { getAgentName, getRoot } from '../config.js';
import { getClaudeClient, CompleteOptions, resolveModelAlias } from '../claude.js';
import { getAgent } from './loader.js';
import { InstalledAgent, AgentSpawnResult } from './types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-spawner');

/**
 * card 86d4aavjr (Chris's ruling, 9 Sep 2026), tightened card 86d4adqh7
 * (Hinata B-R1, 9 Sep 2026): a charter model's usage quota can run out
 * mid-session (observed so far on Fable — see
 * incident_fable_quota_exhausted_blocks_headless_spawns_sep9.md). That exit
 * looks identical to a broken agent from the caller's side: exit 1, EMPTY
 * stderr.
 *
 * The original version of this function pattern-matched against 500 chars
 * of the AGENT's own stdout, including /\b429\b|rate.?limit(ed)?\b/i —
 * Hinata showed 5 of 8 realistic non-quota failures fire that (a quoted
 * upstream 429, a bare line number, a row count an agent happened to
 * print). Detection has moved into claude.ts's completeSubprocess, which
 * has the actual raw stdout/stderr and computes `quotaExhausted` against
 * the CLI's OWN anchored refusal wording only (stderr empty, stdout short,
 * matches from the start) — never against arbitrary agent-generated text.
 * This function now trusts only that structured flag. If it isn't set,
 * this is NOT treated as a quota wall and the caller sees the real error —
 * a loud failure beats a silent misclassified retry.
 */
function isModelQuotaExhausted(err: Error): boolean {
  return (err as { quotaExhausted?: boolean }).quotaExhausted === true;
}

/**
 * Spawn a sub-agent by name with a user prompt.
 * Builds the system prompt from the agent definition + identity context,
 * then executes via ClaudeClient.
 */
export async function spawnAgent(name: string, prompt: string): Promise<AgentSpawnResult> {
  const agent = getAgent(name);

  if (!agent) {
    throw new Error(`Agent not found: ${name}. Run \`kyberbot agent list\` to see available agents.`);
  }

  const systemPrompt = buildSystemPrompt(agent);
  const client = getClaudeClient();

  const start = Date.now();

  const opts: CompleteOptions = {
    model: agent.model,
    system: systemPrompt,
    maxTurns: agent.maxTurns,
    effort: agent.effort,
    allowedTools: agent.allowedTools,
    disallowedTools: agent.disallowedTools,
    // GATE 3 (card 86d48zzhe): pin the spawned process's cwd when the
    // agent's frontmatter declares one, so file tools without an explicit
    // --add-dir cannot reach outside it. Falls back to the parent
    // process's cwd (prior behavior) when unset.
    cwd: agent.cwd,
    subprocess: true,
  };

  logger.info(`Spawning agent: ${name}`, {
    model: agent.model,
    maxTurns: agent.maxTurns,
    effort: agent.effort,
    allowedTools: agent.allowedTools.length,
    disallowedTools: agent.disallowedTools.length,
    cwd: agent.cwd,
  });

  // SF-013 mode (2) — bounded retry for early transient failures.
  // The claude subprocess can exit within seconds with tiny stdout and no work done
  // (API rate-limit hit or startup/init race). Retrying after a short delay succeeds
  // because the issue is transient. Post-completion failures (mode 1) are handled
  // upstream by the stdout-fallback in completeSubprocess and never reach here.
  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = attempt * 10_000; // 10s on attempt 1, 20s on attempt 2
      logger.warn(`Agent ${name} spawn failed (attempt ${attempt - 1}) — retrying in ${delayMs / 1000}s`, {
        error: (lastError?.message ?? '').slice(0, 200),
      });
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
    try {
      const response = await client.complete(prompt, opts);
      const durationMs = Date.now() - start;
      logger.info(`Agent ${name} completed`, { durationMs, attempt });
      return {
        agent: name,
        prompt,
        response,
        model: agent.model,
        durationMs,
      };
    } catch (e) {
      lastError = e as Error;

      // card 86d4aavjr: the charter model's quota is exhausted. This is not
      // transient (SF-013's retry-with-delay above is for startup races and
      // rate blips on the SAME model) — retrying claude-fable-5-1 again will
      // fail identically every time until the quota resets. Runtime fallback:
      // retry ONCE on Opus, never touching the charter file, and make the
      // downgrade impossible to miss — logged here at error level, AND
      // prefixed into the response text itself, because a model swap changes
      // the quality of the work and whoever reads the output (Chris, a
      // heartbeat log, `kyberbot agent spawn`'s own stdout) must be told
      // which model actually produced it.
      // card 86d4adqh7 (Hinata B-R3): compare RESOLVED model ids, not raw
      // literals. An agent chartered directly on 'claude-opus-5' (neo,
      // pepper, sherlock) is not the string 'opus', so the old check would
      // "fall back" onto the exact same exhausted model and guarantee a
      // second failure. Resolving both sides through the same alias map
      // catches that regardless of which form the charter uses.
      const resolvedCharterModel = resolveModelAlias(agent.model);
      const resolvedFallbackModel = resolveModelAlias('opus');
      if (resolvedCharterModel !== resolvedFallbackModel && isModelQuotaExhausted(lastError)) {
        logger.error(
          `Agent ${name}: charter model '${agent.model}' quota exhausted — falling back to Opus ONCE (runtime-only, charter unchanged)`,
          { detectedFrom: lastError.message.slice(0, 300) }
        );
        try {
          // card 86d4adqh7 (Hinata B-R2): read the model that actually
          // answered back from the run instead of hard-coding it, so the
          // banner can't go stale the next time an alias is repointed.
          let actualModelId = resolvedFallbackModel;
          const fallbackOpts: CompleteOptions = {
            ...opts,
            model: 'opus',
            onModelResolved: (m) => { actualModelId = m; },
          };
          const response = await client.complete(prompt, fallbackOpts);
          const durationMs = Date.now() - start;
          const banner =
            `[ALFRED RUNTIME FALLBACK — card 86d4aavjr] ${name}'s charter model ` +
            `(${agent.model}) had exhausted its quota. This response was produced by ` +
            `${actualModelId} instead — NOT ${agent.model}. The charter is unchanged; ` +
            `this is a one-time runtime substitution for this call only.\n\n`;
          logger.warn(`Agent ${name} completed on FALLBACK model ${actualModelId} after ${agent.model} quota exhaustion`, {
            durationMs,
          });
          return {
            agent: name,
            prompt,
            response: banner + response,
            model: actualModelId,
            durationMs,
            modelFallback: {
              from: agent.model,
              to: actualModelId,
              reason: lastError.message.slice(0, 300),
            },
          };
        } catch (fallbackError) {
          const fe = fallbackError as Error;
          logger.error(
            `Agent ${name}: Opus fallback ALSO failed after ${agent.model} quota exhaustion — giving up (one retry only)`,
            { error: fe.message.slice(0, 300) }
          );
          throw new Error(
            `Agent ${name} failed: charter model '${agent.model}' quota exhausted ` +
            `(${lastError.message.slice(0, 200)}), and the one-shot Opus fallback also ` +
            `failed: ${fe.message.slice(0, 200)}`
          );
        }
      }
    }
  }

  throw lastError ?? new Error(`Agent ${name} failed after ${MAX_RETRIES + 1} attempts`);
}

/**
 * Build the full system prompt for a sub-agent.
 * Structure: preamble + agent body + abbreviated identity context.
 */
export function buildSystemPrompt(agent: InstalledAgent): string {
  const parts: string[] = [];
  const root = getRoot();

  // Preamble: who you are and delegation context
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  parts.push(`You are a sub-agent of ${agentName}, delegated a specific task.`);
  parts.push(`Your role: ${agent.role}`);
  parts.push(`Your name: ${agent.name}`);
  parts.push('');
  parts.push('You have been spawned to handle a specific task. Complete it thoroughly and return your findings.');
  parts.push('');

  // Agent body (instructions from the .md file)
  if (agent.systemPromptBody) {
    parts.push(agent.systemPromptBody);
    parts.push('');
  }

  // Abbreviated SOUL.md for identity awareness
  try {
    const soulPath = `${root}/SOUL.md`;
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, 'utf-8');
      // Include first ~500 chars for context, not the full file
      const abbreviated = soul.length > 500 ? soul.slice(0, 500) + '\n...' : soul;
      parts.push('## Parent Agent Identity (abbreviated)');
      parts.push(abbreviated);
      parts.push('');
    }
  } catch {
    // Non-fatal
  }

  // Abbreviated USER.md for user awareness
  try {
    const userPath = `${root}/USER.md`;
    if (existsSync(userPath)) {
      const user = readFileSync(userPath, 'utf-8');
      const abbreviated = user.length > 500 ? user.slice(0, 500) + '\n...' : user;
      parts.push('## User Context (abbreviated)');
      parts.push(abbreviated);
      parts.push('');
    }
  } catch {
    // Non-fatal
  }

  return parts.join('\n');
}

