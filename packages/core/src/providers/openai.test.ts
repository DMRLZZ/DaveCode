import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { OpenAIProvider } from './openai';
import { OpenAICompatibleProvider } from './openai-compatible';
import {
  collect,
  jsonResponse,
  makeCtx,
  sse,
  sseResponse,
  stubFetch,
  summarizeChunks,
} from './shared/test-helpers';

afterEach(() => vi.unstubAllGlobals());

const req: ChatRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.2,
};

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 5,
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected rejection');
}

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider();

  it('passes the request through with bearer auth and strips the provider prefix', async () => {
    const calls = stubFetch(() => jsonResponse(completion));
    const res = await provider.complete(req, makeCtx('openai', {}, { secret: 'sk-abc' }));
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-abc');
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      stream: false,
    });
    expect(res.choices[0]?.message.content).toBe('hello');
    expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it('always returns usage, defaulting to zeros', async () => {
    stubFetch(() => jsonResponse({ ...completion, usage: undefined }));
    const res = await provider.complete(req, makeCtx('openai'));
    expect(res.usage.total_tokens).toBe(0);
  });

  it('streams with include_usage and surfaces tool calls and final usage', async () => {
    const calls = stubFetch(() =>
      sseResponse(
        [
          sse({
            id: 'c',
            created: 1,
            model: 'm',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }),
          sse({
            id: 'c',
            created: 1,
            model: 'm',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'f', arguments: '{"a"' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          sse({
            id: 'c',
            created: 1,
            model: 'm',
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
                finish_reason: null,
              },
            ],
          }),
          sse({
            id: 'c',
            created: 1,
            model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }),
          sse({
            id: 'c',
            created: 1,
            model: 'm',
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
          }),
          'data: [DONE]\n\n',
        ],
        37,
      ),
    );
    const chunks = await collect(provider.stream(req, makeCtx('openai')));
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    const summary = summarizeChunks(chunks);
    expect(summary.toolCalls).toEqual([{ id: 'call_1', name: 'f', args: '{"a":1}' }]);
    expect(summary.finish).toBe('tool_calls');
    expect(summary.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
  });

  it('maps 429 + Retry-After to rate_limit with retryAfterMs', async () => {
    stubFetch(() =>
      jsonResponse({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after': '12' }),
    );
    const err = await failure(provider.complete(req, makeCtx('openai')));
    expect(err).toMatchObject({
      kind: 'rate_limit',
      status: 429,
      retryAfterMs: 12000,
      provider: 'openai',
      accountId: 'acc-1',
    });
  });

  it('maps insufficient_quota, context length, 401 and 503', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'insufficient_quota', message: 'quota' } }, 429));
    expect((await failure(provider.complete(req, makeCtx('openai')))).kind).toBe('quota_exhausted');
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'context_length_exceeded',
            message: 'maximum context length is 128000 tokens',
          },
        },
        400,
      ),
    );
    expect((await failure(provider.complete(req, makeCtx('openai')))).kind).toBe('context_length');
    stubFetch(() => jsonResponse({ error: { message: 'Incorrect API key sk-live-xyz' } }, 401));
    const auth = await failure(
      provider.complete(req, makeCtx('openai', {}, { secret: 'sk-live-xyz' })),
    );
    expect(auth.kind).toBe('auth');
    expect(auth.message).not.toContain('sk-live-xyz');
    stubFetch(() => jsonResponse({ error: { message: 'down' } }, 503));
    expect((await failure(provider.complete(req, makeCtx('openai')))).kind).toBe('unavailable');
  });

  it('maps an aborted signal to timeout and fetch failures to network', async () => {
    stubFetch(() => jsonResponse(completion));
    const ac = new AbortController();
    ac.abort();
    expect(
      (await failure(provider.complete(req, makeCtx('openai', {}, { signal: ac.signal })))).kind,
    ).toBe('timeout');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(provider.complete(req, makeCtx('openai')))).kind).toBe('network');
  });

  it('maps in-stream error events', async () => {
    stubFetch(() =>
      sseResponse([
        sse({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } }),
      ]),
    );
    const err = await failure(collect(provider.stream(req, makeCtx('openai'))));
    expect(err.kind).toBe('quota_exhausted');
  });

  it('requires an API key and lists models', async () => {
    const err = await failure(provider.complete(req, { ...makeCtx('openai'), secret: undefined }));
    expect(err.kind).toBe('auth');
    stubFetch(() => jsonResponse({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }));
    const models = await provider.listModels(makeCtx('openai'));
    expect(models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
  });
});

describe('OpenAICompatibleProvider', () => {
  const provider = new OpenAICompatibleProvider();

  it('requires baseUrl and keeps model ids intact', async () => {
    const err = await failure(provider.complete(req, makeCtx('openai-compatible')));
    expect(err.kind).toBe('bad_request');
    const calls = stubFetch(() => jsonResponse(completion));
    await provider.complete(
      { ...req, model: 'openai/gpt-4o' },
      makeCtx(
        'openai-compatible',
        { baseUrl: 'http://localhost:11434/v1/', defaultHeaders: { 'x-title': 'dave' } },
        { secret: '' },
      ),
    );
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]?.headers['x-title']).toBe('dave');
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.body).toMatchObject({ model: 'openai/gpt-4o' });
  });

  it('uses the config.models allow-list instead of calling /models', async () => {
    const calls = stubFetch(() => jsonResponse({}));
    const models = await provider.listModels(
      makeCtx('openai-compatible', { baseUrl: 'http://x/v1', models: ['llama3', 'qwen'] }),
    );
    expect(models.map((m) => m.id)).toEqual(['llama3', 'qwen']);
    expect(calls).toHaveLength(0);
  });
});
