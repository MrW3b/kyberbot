/**
 * KyberBot ClaudeClient adapter for Arcana's `LLMProvider` contract.
 *
 * Lets Arcana's kernel (sleep-pipeline fact extraction, summarisation,
 * reasoning) reach Claude through KyberBot's existing three-mode runtime
 * (Agent SDK / SDK / subprocess) without depending on the underlying
 * client directly.
 */

import type { LLMProvider, LLMCompleteOpts } from '@kybernesisai/arcana-contracts';
import { ClaudeClient, getClaudeClient } from '../../claude.js';

export interface ClaudeLLMProviderOptions {
  /** Claude model shorthand. Defaults to 'haiku' — cheapest for sleep-pipeline use. */
  model?: 'haiku' | 'sonnet' | 'opus';
  /** Injectable client for tests. */
  client?: ClaudeClient;
}

export function createClaudeLLMProvider(
  opts: ClaudeLLMProviderOptions = {},
): LLMProvider {
  const model = opts.model ?? 'haiku';
  const client = opts.client ?? getClaudeClient();

  return {
    model,

    async complete(prompt: string, completeOpts: LLMCompleteOpts = {}): Promise<string> {
      return client.complete(prompt, {
        model,
        system: completeOpts.system,
        maxTokens: completeOpts.maxTokens,
        subprocess: true,
      });
    },
  };
}
