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
  systemPromptBody: string; // Markdown below the frontmatter
}

export interface AgentSpawnResult {
  agent: string;
  prompt: string;
  response: string;
  model: string;
  durationMs: number;
}
