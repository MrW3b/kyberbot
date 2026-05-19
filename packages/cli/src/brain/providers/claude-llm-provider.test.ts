import { describe, it, expect, vi } from 'vitest';
import { createClaudeLLMProvider } from './claude-llm-provider.js';
import type { ClaudeClient } from '../../claude.js';

function makeFakeClient(): { client: ClaudeClient; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_prompt: string, _opts?: unknown) => 'hello from claude');
  return { client: { complete } as unknown as ClaudeClient, complete };
}

describe('createClaudeLLMProvider', () => {
  it('defaults to haiku', () => {
    const { client } = makeFakeClient();
    const p = createClaudeLLMProvider({ client });
    expect(p.model).toBe('haiku');
  });

  it('respects an explicit model', () => {
    const { client } = makeFakeClient();
    const p = createClaudeLLMProvider({ client, model: 'sonnet' });
    expect(p.model).toBe('sonnet');
  });

  it('complete() forwards prompt and maps opts onto ClaudeClient', async () => {
    const { client, complete } = makeFakeClient();
    const p = createClaudeLLMProvider({ client, model: 'haiku' });
    const out = await p.complete('extract facts from: foo', {
      system: 'you are a fact extractor',
      maxTokens: 512,
      temperature: 0.2,
    });
    expect(out).toBe('hello from claude');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('extract facts from: foo', {
      model: 'haiku',
      system: 'you are a fact extractor',
      maxTokens: 512,
      subprocess: true,
    });
  });

  it('complete() works without opts', async () => {
    const { client, complete } = makeFakeClient();
    const p = createClaudeLLMProvider({ client });
    const out = await p.complete('hi');
    expect(out).toBe('hello from claude');
    expect(complete).toHaveBeenCalledWith('hi', {
      model: 'haiku',
      system: undefined,
      maxTokens: undefined,
      subprocess: true,
    });
  });
});
