/**
 * KyberBot — Shared Types
 *
 * Core type definitions used across the application.
 */

export interface ServiceStatus {
  name: string;
  status: 'running' | 'starting' | 'stopped' | 'error' | 'disabled';
  extra?: string;
}

export interface ServiceHandle {
  stop: () => Promise<void>;
  status: () => ServiceStatus['status'];
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  start: () => Promise<ServiceHandle>;
}

export interface IdentityConfig {
  agent_name: string;
  agent_description?: string;
  kyberbot_version?: string;
  timezone: string;
  locale?: string;
  heartbeat_interval: string;
  heartbeat_active_hours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  /**
   * Model used for heartbeat and orchestration (CEO/worker) Claude calls.
   * Defaults to 'opus' (Claude Opus 4.8) if unset — heartbeats are how
   * agents do their actual long-running advanced work (multi-pass
   * refactors, audits, research), so the better model is the right
   * default. Set explicitly to 'sonnet' or 'haiku' if you want to trade
   * capability for cost on a per-agent basis. The agent's main chat
   * still uses `claude.model` (also Opus by default).
   */
  heartbeat_model?: 'haiku' | 'sonnet' | 'opus';
  /**
   * Inner SDK max-turns for one Claude call within a single heartbeat
   * turn. Defaults to 50 (was 25 prior to v1.9.2 — lifted because real
   * tasks routinely exceed that). When the inner cap IS hit, the runtime
   * gracefully falls through to the outer worker continuation loop
   * (see `worker_max_turns`) instead of failing the run, so this is a
   * cost knob more than a correctness one.
   */
  heartbeat_max_inner_turns?: number;
  server?: {
    port: number;
    host?: string;
  };
  channels?: {
    telegram?: {
      bot_token: string;
      owner_chat_id?: number;
    };
    whatsapp?: { enabled: boolean };
  };
  kybernesis?: {
    agent_id: string;
    workspace_id: string;
  };
  tunnel?: {
    enabled: boolean;
    provider?: string;
  };
  backup?: {
    enabled: boolean;
    remote_url: string;
    schedule: string;
    branch?: string;
  };
  claude?: {
    mode: 'subscription' | 'sdk';
    model?: string;
    /**
     * Per-surface model overrides. Falls back to `model` (and ultimately 'opus')
     * when a surface is not specified. Heartbeat has its own top-level
     * `heartbeat_model` and is NOT read from this map.
     */
    models?: {
      channel?: 'haiku' | 'sonnet' | 'opus';
      agent_default?: 'haiku' | 'sonnet' | 'opus';
      brain?: 'haiku' | 'sonnet' | 'opus';
    };
  };
  memory?: {
    entity_stoplist?: string[];
  };
  subscriptions?: Array<{
    from: string;
    topic: string;
  }>;
  watched_folders?: Array<{
    path: string;
    label?: string;
    enabled?: boolean;
    extensions?: string[];
  }>;
  /**
   * Symphony §8.5 stall timeout — a heartbeat run is killed if it goes
   * this many ms without a phase transition. Default 5 minutes.
   * Set to 0 to disable stall detection.
   */
  heartbeat_stall_timeout_ms?: number;
  /**
   * Shell hooks fired around the worker run lifecycle. Scripts run as
   * `bash -lc <script>` in the agent's root with KYBERBOT_ISSUE_ID,
   * KYBERBOT_AGENT, and KYBERBOT_RUN_STATUS env vars.
   *
   * `before_run` failure is non-fatal by default — the run continues and
   * the failure is recorded in phase_history. Set fatal_on_before_run:
   * true to revert to the strict Symphony §9.4 semantic where a failed
   * before_run aborts the attempt.
   */
  hooks?: {
    after_create?: string;
    before_run?: string;
    after_run?: string;
    before_remove?: string;
    timeout_ms?: number;
    fatal_on_before_run?: boolean;
  };
  /**
   * Per-agent concurrency limits. `max_concurrent_runs` caps the number
   * of simultaneously running heartbeats for this agent. `max_by_state`
   * caps the number of issues this agent will work in each issue state
   * (e.g. `{ todo: 3, in_progress: 1 }`). Both default to 1.
   */
  concurrency?: {
    max_concurrent_runs?: number;
    max_by_state?: Record<string, number>;
  };
  /**
   * Symphony §7.1 worker-loop limit. After each turn that ends with
   * STATUS: IN_PROGRESS, the worker re-prompts the agent with the tail
   * of its previous output as context, up to this many turns within a
   * single run. Defaults to 5. Set to 1 to disable the loop. Inner Claude
   * SDK turns (tool-use rounds within one call) are unaffected.
   */
  worker_max_turns?: number;
  /**
   * Runtime loop / fruitless-turn detection. The runtime watches the
   * stream-json events from the Claude subprocess. If the agent issues
   * the same tool call with identical args N times in a row, or N
   * consecutive tool calls return errors, the subprocess is killed and
   * the run is marked BLOCKED with the loop reason in phase_history.
   * Defaults are conservative — disable by setting enabled: false.
   */
  loop_detection?: {
    enabled?: boolean;
    max_identical_tool_calls?: number;
    max_consecutive_tool_errors?: number;
  };
  /**
   * Transient-error retry policy for the inner Claude subprocess call.
   * If the subprocess errors mid-turn (network blip, SDK glitch), the
   * runtime retries with exponential backoff before failing the run.
   * Defaults: 3 attempts total, base 10s, doubling, capped at 5min.
   */
  worker_subprocess_retry?: {
    max_attempts?: number;
    base_backoff_ms?: number;
    max_backoff_ms?: number;
  };
}
