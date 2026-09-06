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
  model: string;
  durationMs: number;
}
