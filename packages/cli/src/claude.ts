/**
 * KyberBot — Claude Abstraction Layer
 *
 * Three modes:
 *   1. Agent SDK — Uses @anthropic-ai/claude-code (subscription users, recommended)
 *   2. SDK — Direct Anthropic API calls (requires ANTHROPIC_API_KEY)
 *   3. Subprocess — Spawns `claude -p` (fallback if Agent SDK fails to load)
 *
 * All brain AI operations go through this layer.
 */

import { spawn } from 'child_process';
import { getClaudeMode, getClaudeModel, getRoot } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('claude');

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  /** Alias or full model ID (e.g. claude-opus-5) — passed to --model as-is. */
  model?: 'haiku' | 'sonnet' | 'opus' | 'fable' | (string & {});
  system?: string;
  maxTokens?: number;
  maxTurns?: number;
  /** Reasoning effort passed to --effort. Omit to inherit the session default. */
  effort?: string;
  /** Tool allowlist passed to --allowed-tools (permission-rule syntax supported). */
  allowedTools?: string[];
  /** Callback for stdout chunks as they arrive (streaming). */
  onChunk?: (chunk: string) => void;
  /**
   * Force subprocess mode for this call. Each invocation runs in an
   * isolated child process whose memory is reclaimed on exit.
   * Use for background/brain operations to avoid heap accumulation
   * in the long-lived server process.
   */
  subprocess?: boolean;
  /**
   * Working directory for the spawned `claude` process. Claude Code
   * attributes session files to the project corresponding to this
   * directory. In fleet mode the parent process has one CWD shared
   * across many agents, so without this option every agent's Haiku
   * calls land in the same project dir. Callers that know which
   * agent's work is being done (sleep steps, heartbeat, channel
   * handlers, bus handler, store-conversation) should pass the
   * agent's root here. Only used by subprocess mode.
   */
  cwd?: string;
  /**
   * Optional loop / fruitless-turn detection. When set, the runtime
   * watches stream-json events for repeated identical tool calls or
   * runs of consecutive tool errors, and kills the subprocess early
   * if a threshold trips. Only effective in stream-json mode (i.e.
   * when onChunk is also provided).
   */
  loopDetection?: {
    enabled: boolean;
    maxIdenticalToolCalls: number;
    maxConsecutiveToolErrors: number;
  };
}

// Model ID mapping. Update when Anthropic publishes new minor versions —
// the shorthand ('opus') resolves to the current latest model ID here.
const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
};

/**
 * Order-stable JSON stringify so `{a:1,b:2}` and `{b:2,a:1}` produce the
 * same key for the loop-detection tool-call signature comparison. Without
 * this, an LLM that re-emits the same call with reordered keys looks new.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export class ClaudeClient {
  private mode: 'agent-sdk' | 'sdk' | 'subprocess';
  private sdk: any | null = null;

  constructor() {
    const configMode = getClaudeMode();

    if (configMode === 'agent-sdk') {
      // All callers use subprocess: true, so don't load the Agent SDK
      // into the long-lived server process — it leaks hundreds of MB.
      // The SDK is only needed for in-process query() calls, which we
      // no longer make. Subprocess mode spawns `claude -p` instead.
      this.mode = 'subprocess';
      logger.debug('Using subprocess mode (agent-sdk disabled for memory safety)');
    } else if (configMode === 'sdk') {
      this.mode = 'sdk';
      this.initSDK();
    } else {
      this.mode = 'subprocess';
    }
  }

  private async initSDK(): Promise<void> {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      this.sdk = new Anthropic();
      logger.debug('Initialized in SDK mode');
    } catch {
      logger.warn('Failed to initialize SDK, falling back to subprocess mode');
      this.mode = 'subprocess';
    }
  }

  /**
   * Single completion — fire and forget prompt
   */
  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    // Always resolve model — never let subprocess/agent-sdk fall back to CLI defaults
    if (!opts.model) {
      opts.model = (getClaudeModel() || 'opus') as 'haiku' | 'sonnet' | 'opus';
    }

    // All server-process calls should use subprocess for memory isolation.
    // SDK mode is only for direct API calls (ANTHROPIC_API_KEY users).
    if (this.mode === 'sdk' && this.sdk && !opts.subprocess) {
      return this.completeSDK(prompt, opts.model, opts);
    }
    return this.completeSubprocess(prompt, opts);
  }

  /**
   * Multi-turn chat
   */
  async chat(messages: Message[], system: string): Promise<string> {
    const model = (getClaudeModel() || 'opus') as 'haiku' | 'sonnet' | 'opus';

    if (this.mode === 'sdk' && this.sdk) {
      return this.chatSDK(messages, system, model);
    }
    // Subprocess mode: flatten into a single prompt with history
    const historyPrompt = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = `${system}\n\n${historyPrompt}`;
    return this.completeSubprocess(fullPrompt, { model });
  }

  private async completeSDK(
    prompt: string,
    model: string,
    opts: CompleteOptions
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.opus;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: opts.maxTokens || 4096,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private async chatSDK(
    messages: Message[],
    system: string,
    model: string
  ): Promise<string> {
    const modelId = MODEL_IDS[model] || MODEL_IDS.opus;
    const response = await this.sdk.messages.create({
      model: modelId,
      max_tokens: 4096,
      system,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return textBlock?.text || '';
  }

  private completeSubprocess(prompt: string, opts: CompleteOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use stream-json format when onChunk is provided for live output
      const useStreamJson = !!opts.onChunk;
      const args = ['--print', '-'];
      args.push('--dangerously-skip-permissions'); // Always skip — subprocesses are headless, no human to prompt
      if (useStreamJson) {
        args.push('--output-format', 'stream-json', '--verbose');
      }
      if (opts.system) {
        args.push('--system-prompt', opts.system);
      }
      if (opts.model) {
        args.push('--model', opts.model);
      }
      if (opts.maxTurns) {
        args.push('--max-turns', String(opts.maxTurns));
      }
      if (opts.effort) {
        args.push('--effort', opts.effort);
      }
      if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowed-tools', ...opts.allowedTools);
      }

      // Pipe prompt via stdin instead of CLI args to avoid ARG_MAX limits
      // (large conversation histories + system prompts easily exceed 256KB)
      const proc = spawn('claude', args, {
        env: {
          ...process.env,
          // Must unset CLAUDECODE to avoid Claude Code detecting nested invocation
          CLAUDECODE: '',
          CLAUDE_CODE_ENTRYPOINT: '',
        },
        // cwd determines which ~/.claude/projects/<slug> dir Claude Code
        // writes this session's .jsonl to. Without this, every agent's
        // brain/sleep/heartbeat calls in fleet mode attribute to the same
        // dir (the fleet process's cwd). Callers pass the agent's root.
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const MAX_STDOUT = 2 * 1024 * 1024; // 2MB cap — subprocess responses should be small

      // Live loop detector. Only active in stream-json mode + when caller
      // opted in via opts.loopDetection. Tracks tool_use signatures and
      // consecutive tool errors. Kills the subprocess early when it sees
      // 3× identical calls or 5× consecutive errors (defaults).
      const loopCfg = opts.loopDetection;
      const loopActive = !!(useStreamJson && loopCfg?.enabled);
      let lineBuffer = '';
      const recentTools: Array<{ key: string; isError: boolean }> = [];
      // Mutable cell for the loop-bail signal. Use an array rather than a
      // `let` so TS doesn't narrow the closure-captured value to its
      // initial type when read from inside callbacks.
      const loopBailRef: Array<{ reason: string }> = [];
      const setLoopBail = (reason: string): void => { loopBailRef[0] = { reason }; };
      const getLoopBail = (): { reason: string } | null => loopBailRef[0] ?? null;

      const checkLoopThresholds = (): void => {
        if (!loopCfg) return;
        // Identical-args streak
        const m = loopCfg.maxIdenticalToolCalls;
        if (recentTools.length >= m) {
          const tail = recentTools.slice(-m);
          const firstKey = tail[0].key;
          if (firstKey && tail.every(t => t.key === firstKey)) {
            setLoopBail(`${m} identical tool calls in a row (${firstKey.slice(0, 80)})`);
            return;
          }
        }
        // Consecutive error streak
        let consecutive = 0;
        for (let i = recentTools.length - 1; i >= 0; i--) {
          if (recentTools[i].isError) consecutive++;
          else break;
        }
        if (consecutive >= loopCfg.maxConsecutiveToolErrors) {
          setLoopBail(`${consecutive} consecutive tool errors`);
        }
      };

      const ingestStreamLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: any;
        try { event = JSON.parse(trimmed); } catch { return; }
        const blocks: any[] = Array.isArray(event?.message?.content) ? event.message.content : [];
        for (const block of blocks) {
          if (block?.type === 'tool_use') {
            const key = `${block.name}:${stableStringify(block.input ?? {})}`;
            recentTools.push({ key, isError: false });
          } else if (block?.type === 'tool_result' && block.is_error) {
            if (recentTools.length > 0) recentTools[recentTools.length - 1].isError = true;
            else recentTools.push({ key: 'unknown', isError: true });
          }
        }
        if (blocks.length > 0) checkLoopThresholds();
      };

      let stdoutDestroyed = false;
      proc.stdout.on('data', (data: Buffer) => {
        stdoutBytes += data.length;
        if (stdoutBytes <= MAX_STDOUT) {
          chunks.push(data);
          // Stream callback for live log capture
          if (opts.onChunk) {
            try { opts.onChunk(data.toString()); } catch { /* ignore */ }
          }
          // Live loop detection — parse line-by-line in stream-json mode
          if (loopActive && !getLoopBail()) {
            lineBuffer += data.toString();
            const newlineIdx = lineBuffer.lastIndexOf('\n');
            if (newlineIdx !== -1) {
              const complete = lineBuffer.slice(0, newlineIdx);
              lineBuffer = lineBuffer.slice(newlineIdx + 1);
              for (const line of complete.split('\n')) ingestStreamLine(line);
              const bailNow = getLoopBail();
              if (bailNow) {
                logger.warn('Loop detected — killing subprocess', { reason: bailNow.reason });
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              }
            }
          }
        } else if (!stdoutDestroyed) {
          // Destroy the read stream to stop reading entirely.
          // Without this, rapid data arrival floods GC with temporary Buffers.
          stdoutDestroyed = true;
          proc.stdout.destroy();
          logger.warn(`Subprocess stdout exceeded ${MAX_STDOUT / 1024 / 1024}MB — stream destroyed`);
        }
      });
      proc.stderr.on('data', (data: Buffer) => { errChunks.push(data); });

      proc.on('close', (code) => {
        const chunksBytes = chunks.reduce((sum, c) => sum + c.length, 0);
        const errBytes = errChunks.reduce((sum, c) => sum + c.length, 0);
        logger.info('subprocess:close', { code, stdoutBytes: chunksBytes, stderrBytes: errBytes, totalStdoutRead: stdoutBytes, destroyed: stdoutDestroyed, heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });
        const stdout = Buffer.concat(chunks).toString().trim();
        const stderr = Buffer.concat(errChunks).toString();
        // Clear references immediately to let GC reclaim buffers
        chunks.length = 0;
        errChunks.length = 0;
        stdoutBytes = 0;

        // Parse stream-json (if used) to find the final result event +
        // detect error_max_turns. We do this regardless of exit code so
        // that hitting the inner turn cap is recoverable — the worker
        // continuation loop catches the IN_PROGRESS marker we append
        // below and starts a fresh subprocess turn.
        let resultText = '';
        let resultSubtype: string | null = null;
        let isError = false;
        if (useStreamJson) {
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed);
              if (event.type === 'result') {
                if (event.result) resultText = event.result;
                if (event.subtype) resultSubtype = event.subtype;
                if (event.is_error) isError = true;
              } else if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text') resultText = block.text;
                }
              }
            } catch { /* not valid JSON — skip */ }
          }
        }

        // Loop detected mid-stream — runtime killed the subprocess. Surface
        // a synthetic STATUS: BLOCKED so the outer worker loop does NOT
        // continuation-fire on it (looping ≠ needs more turns).
        const bailFinal = getLoopBail();
        if (bailFinal) {
          logger.warn('Returning loop-bail result', { reason: bailFinal.reason });
          const augmented = (resultText || stdout).slice(-2000) +
            `\n\n[runtime] Loop detected and aborted: ${bailFinal.reason}\n` +
            `STATUS: BLOCKED — runtime detected ${bailFinal.reason}`;
          resolve(augmented);
          return;
        }

        // Recoverable: SDK hit its --max-turns cap. The worker did real work
        // but couldn't reach a STATUS line in time. Surface the partial
        // output with a synthetic STATUS: IN_PROGRESS so the outer worker
        // loop fires another fresh subprocess turn (Symphony §7.1 model).
        if (resultSubtype === 'error_max_turns') {
          logger.warn('claude subprocess hit max-turns cap — returning partial output for continuation', {
            chars: resultText.length,
          });
          const augmented = (resultText || stdout) +
            '\n\n[runtime] Hit inner SDK max-turns cap; agent has more work to do.\n' +
            'STATUS: IN_PROGRESS';
          resolve(augmented);
          return;
        }

        if (code === 0) {
          if (useStreamJson) {
            resolve(resultText || stdout);
          } else {
            resolve(stdout);
          }
        } else if (resultText && !isError) {
          // Non-zero exit but a complete result was streamed — degrade gracefully.
          logger.warn(`claude subprocess exited ${code} but a result was streamed; using it`, {
            stderrPreview: stderr.slice(0, 200),
          });
          resolve(resultText);
        } else {
          logger.error(`claude subprocess exited with code ${code}`, { stderr: stderr.slice(0, 500), subtype: resultSubtype });
          reject(new Error(`claude subprocess failed: ${stderr.slice(0, 500) || `exit code ${code}${resultSubtype ? ` (${resultSubtype})` : ''}`}`));
        }
      });

      proc.on('error', (err) => {
        chunks.length = 0;
        errChunks.length = 0;
        reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
      });
    });
  }
}

// Singleton
let _client: ClaudeClient | null = null;

export function getClaudeClient(): ClaudeClient {
  if (!_client) {
    _client = new ClaudeClient();
  }
  return _client;
}
