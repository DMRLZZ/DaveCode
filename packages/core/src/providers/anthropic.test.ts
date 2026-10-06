import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { AnthropicProvider, toAnthropicRequest } from './anthropic';
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

const provider = new AnthropicProvider();

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected rejection');
}

describe('toAnthropicRequest', () => {
  it('extracts system, merges turns, converts tools, images and tool results', () => {
    const req: ChatRequest = {
      model: 'claude-sonnet-4-5',
      stop: 'END',
      temperature: 0.5,
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: [{ type: 'text', text: 'Be kind.' }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '20C' },
        { role: 'tool', tool_call_id: 'call_2', content: '25C' },
        { role: 'user', content: 'thanks' },
      ],
    };
    const body = toAnthropicRequest(req, 'claude-sonnet-4-5');
    expect(body.system).toBe('Be brief.\n\nBe kind.');
    expect(body.max_tokens).toBe(8192);
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    expect(body.tools?.[0]).toMatchObject({
      name: 'get_weather',
      input_schema: { type: 'object' },
    });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]?.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(body.messages[0]?.content[2]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.jpg' },
    });
    expect(body.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'Rome' } },
    ]);
    expect(body.messages[2]?.content.map((b) => b.type)).toEqual([
      'tool_result',
      'tool_result',
      'text',
    ]);
  });

  it('honours max_tokens and tool_choice required', () => {
    const body = toAnthropicRequest(
      {
        model: 'm',
        max_tokens: 100,
        tool_choice: 'required',
        tools: [{ type: 'function', function: { name: 'f' } }],
        messages: [{ role: 'user', content: 'x' }],
      },
      'm',
    );
    expect(body.max_tokens).toBe(100);
    expect(body.tool_choice).toEqual({ type: 'any' });
  });
});

describe('AnthropicProvider', () => {
  const req: ChatRequest = {
    model: 'anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('sends headers and translates a non-streaming response with tool_use', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
      }),
    );
    const res = await provider.complete(req, makeCtx('anthropic', {}, { secret: 'sk-ant-1' }));
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-1');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.body).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 8192 });
    const choice = res.choices[0];
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.content).toBe('Checking.');
    expect(choice?.message.tool_calls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
  });

  it('translates streaming text, tool calls, and final usage', async () => {
    stubFetch(() =>
      sseResponse(
        [
          sse(
            {
              type: 'message_start',
              message: {
                id: 'msg_s',
                model: 'claude-x',
                usage: { input_tokens: 12, output_tokens: 1 },
              },
            },
            'message_start',
          ),
          sse({ type: 'ping' }, 'ping'),
          sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          sse({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hel' },
          }),
          sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
          sse({ type: 'content_block_stop', index: 0 }),
          sse({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_9', name: 'f', input: {} },
          }),
          sse({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"a":' },
          }),
          sse({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '1}' },
          }),
          sse({ type: 'content_block_stop', index: 1 }),
          sse({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 20 },
          }),
          sse({ type: 'message_stop' }),
        ],
        200,
      ),
    );
    const chunks = await collect(provider.stream(req, makeCtx('anthropic')));
    const summary = summarizeChunks(chunks);
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
    expect(chunks[0]?.id).toBe('msg_s');
    expect(summary.text).toBe('Hello');
    expect(summary.toolCalls).toEqual([{ id: 'toolu_9', name: 'f', args: '{"a":1}' }]);
    expect(summary.finish).toBe('tool_calls');
    expect(summary.usage).toEqual({ prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 });
  });

  it('maps HTTP errors: 529 overloaded, 429 reset headers, 401, context length', async () => {
    stubFetch(() =>
      jsonResponse(
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        529,
      ),
    );
    expect(await failure(provider.complete(req, makeCtx('anthropic')))).toMatchObject({
      kind: 'unavailable',
      status: 529,
    });

    const reset = new Date(Date.now() + 30_000).toISOString();
    stubFetch(() =>
      jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, 429, {
        'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': reset,
      }),
    );
    const rl = await failure(provider.complete(req, makeCtx('anthropic')));
    expect(rl.kind).toBe('rate_limit');
    expect(rl.retryAfterMs).toBeGreaterThan(20_000);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(30_000);

    stubFetch(() =>
      jsonResponse(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    );
    expect((await failure(provider.complete(req, makeCtx('anthropic')))).kind).toBe('auth');

    stubFetch(() =>
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 250000 tokens > 200000 maximum',
          },
        },
        400,
      ),
    );
    expect((await failure(provider.complete(req, makeCtx('anthropic')))).kind).toBe(
      'context_length',
    );

    stubFetch(() =>
      jsonResponse({ type: 'error', error: { type: 'retry', message: 'x' } }, 429, {
        'retry-after': '3',
      }),
    );
    expect((await failure(provider.complete(req, makeCtx('anthropic')))).retryAfterMs).toBe(3000);
  });

  it('maps stream error events and aborts', async () => {
    stubFetch(() =>
      sseResponse([
        sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
      ]),
    );
    expect((await failure(collect(provider.stream(req, makeCtx('anthropic'))))).kind).toBe(
      'unavailable',
    );

    const ac = new AbortController();
    ac.abort();
    stubFetch(() => jsonResponse({}));
    expect(
      (
        await failure(
          collect(provider.stream(req, makeCtx('anthropic', {}, { signal: ac.signal }))),
        )
      ).kind,
    ).toBe('timeout');
  });

  it('requires an API key and honours config.models', async () => {
    expect(
      (await failure(provider.complete(req, { ...makeCtx('anthropic'), secret: undefined }))).kind,
    ).toBe('auth');
    const models = await provider.listModels(makeCtx('anthropic', { models: ['claude-a'] }));
    expect(models.map((m) => m.id)).toEqual(['claude-a']);
  });
});
