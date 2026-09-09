/**
 * KyberBot — Agent Types
 *
 * Interfaces for sub-agent manifests (YAML frontmatter in .md files).
 */

export interface AgentManifest {
  name: string;
  description: string;
  role: string;
  'allowed-tools'?: string[];
  model?: string;
  effort?: string;
  'max-turns'?: number;
  /**
   * Working directory pin (GATE 3, card 86d48zzhe). When set, the spawned
   * claude process runs with this as its cwd, so file tools without an
   * explicit --add-dir cannot reach outside it. Absolute path.
   */
  cwd?: string;
  /**
   * Deny rules threaded to --disallowed-tools, layered on top of the cwd
   * pin. Same permission-rule syntax as allowed-tools. Path-scoped rules
   * only take effect via Edit(path) — Write(path)/NotebookEdit(path) are
   * accepted but never consulted by Claude Code (see settings-reference).
   */
  deny?: string[];
}

export interface InstalledAgent {
  name: string;
  description: string;
  role: string;
  path: string;
  model: string;
  effort?: string;
  maxTurns: number;
  allowedTools: string[];
  cwd?: string;
  disallowedTools: string[];
  systemPromptBody: string; // Markdown below the frontmatter
}

export interface AgentSpawnResult {
  agent: string;
  prompt: string;
  response: string;
  /** Model that actually produced `response` — may differ from the charter's model, see modelFallback. */
  model: string;
  durationMs: number;
  /**
   * Set only when a runtime quota fallback fired (card 86d4aavjr, Chris's
   * ruling 9 Sep 2026): the charter's own model ran out of quota mid-spawn,
   * so this ONE call was retried on Opus instead of dying. The charter file
   * itself is never edited — this is visible, logged, one-shot, per-call.
   */
  modelFallback?: {
    from: string;
    to: string;
    reason: string;
  };
}
