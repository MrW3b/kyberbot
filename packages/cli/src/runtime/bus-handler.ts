/**
 * KyberBot — Bus Message Handler
 *
 * Shared logic for processing incoming bus messages. Used by both
 * AgentRuntime (fleet mode) and bus-api.ts (standalone HTTP endpoint).
 * Searches the agent's brain, reads SOUL.md, calls Claude.
 */

import { createLogger } from '../logger.js';
import type { AgentMessage } from './agent-bus.js';

const logger = createLogger('bus-handler');

/**
 * Process an incoming bus message and generate a Claude-powered response.
 */
export async function handleIncomingBusMessage(
  root: string,
  agentName: string,
  msg: AgentMessage
): Promise<string> {
  const { getClaudeClient, AGENT_FACING_ALLOWED_TOOLS } = await import('../claude.js');
  const { hybridSearch } = await import('../brain/hybrid-search.js');

  // Retrieve relevant context from this agent's brain
  let context = '';
  try {
    const results = await hybridSearch(msg.payload, root, { limit: 5 });
    if (results.length > 0) {
      context = results
        .map((r, i) => `[${i + 1}] ${r.title}: ${r.content.slice(0, 300)}`)
        .join('\n\n');
    }
  } catch {
    // Brain search failed — respond without context
  }

  // Read SOUL.md for personality
  let soul = '';
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const soulPath = join(root, 'SOUL.md');
    soul = readFileSync(soulPath, 'utf-8').slice(0, 500);
  } catch { /* no soul file */ }

  const systemPrompt = [
    `You are ${agentName}.`,
    soul ? `Your identity:\n${soul}` : '',
    `You received a message from another AI agent named ${msg.from}.`,
    msg.topic ? `Topic: ${msg.topic}` : '',
    'Respond helpfully and concisely based on your knowledge and the context below.',
    'Keep your response under 500 words.',
    context ? `\nRelevant context from your memory:\n\n${context}` : '',
  ].filter(Boolean).join('\n');

  try {
    const client = getClaudeClient();
    const response = await client.complete(msg.payload, {
      system: systemPrompt,
      model: 'sonnet' as const,
      maxTokens: 1024,
      subprocess: true,
      cwd: root,
      // GATE 3 fix (Alfred, 9 Sep 2026): inter-agent bus — a peer agent talking
      // to this agent, same allowlist chat-sse.ts's interactive session uses.
      allowedTools: AGENT_FACING_ALLOWED_TOOLS,
    });
    return response;
  } catch (error) {
    logger.error(`Bus handler failed for ${agentName}`, { error: String(error) });
    return `[${agentName}] I received your message but couldn't generate a response right now.`;
  }
}
