import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest, ProviderKind } from '../types';
import type { GeminiWebDriver } from './gemini-web';
import { createProviders } from './registry';
import { collect, makeCtx, summarizeChunks } from './shared/test-helpers';

const req: ChatRequest = { model: 'gemini-web', messages: [{ role: 'user', content: 'hello' }] };

describe('createProviders', () => {
  it('registers every provider kind under its own kind', () => {
    const providers = createProviders();
    const kinds: ProviderKind[] = [
      'anthropic',
      'openai',
      'gemini',
      'openai-compatible',
      'claude-cli',
      'codex-cli',
      'gemini-web',
    ];
    expect([...providers.keys()].sort()).toEqual([...kinds].sort());
    for (const [kind, p] of providers) expect(p.kind).toBe(kind);
  });

  it('gemini-web without a driver is unavailable and explains why', async () => {
    const p = createProviders().get('gemini-web');
    const err = await p?.complete(req, makeCtx('gemini-web')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('unavailable');
    expect((err as ProviderError).message).toMatch(/experimental/i);
    expect((err as ProviderError).message).toMatch(/driver/i);
  });

  it('gemini-web streams through an injected driver with estimated usage', async () => {
    const prompts: string[] = [];
    const driver: GeminiWebDriver = {
      async *send(prompt) {
        prompts.push(prompt);
        yield 'Hel';
        yield 'lo!';
      },
    };
    const p = createProviders({ geminiWebDriver: driver }).get('gemini-web');
    const chunks = await collect(p!.stream(req, makeCtx('gemini-web')));
    const s = summarizeChunks(chunks);
    expect(prompts).toEqual(['hello']);
    expect(s.text).toBe('Hello!');
    expect(s.usage?.completion_tokens).toBeGreaterThan(0);
    const done = await p!.complete(req, makeCtx('gemini-web'));
    expect(done.choices[0]?.message.content).toBe('Hello!');
  });

  it('gemini-web maps an aborted signal to timeout', async () => {
    const driver: GeminiWebDriver = {
      async *send() {
        yield 'x';
      },
    };
    const ac = new AbortController();
    ac.abort();
    const p = createProviders({ geminiWebDriver: driver }).get('gemini-web');
    const err = await p
      ?.complete(req, makeCtx('gemini-web', {}, { signal: ac.signal }))
      .catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('timeout');
  });
});
