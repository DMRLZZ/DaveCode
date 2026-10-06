import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { GeminiProvider, toGeminiRequest } from './gemini';
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

const provider = new GeminiProvider();

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected rejection');
}

const req: ChatRequest = {
  model: 'gemini/gemini-2.5-flash',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('toGeminiRequest', () => {
  it('maps roles, system, tools, tool results, images and generation config', () => {
    const body = toGeminiRequest({
      model: 'm',
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 64,
      stop: ['X'],
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'd',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: { q: { type: 'string' } },
            },
          },
        },
        {
          type: 'function',
          function: { name: 'noargs', parameters: { type: 'object', properties: {} } },
        },
      ],
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } },
          ],
        },
        {
          role: 'assistant',
          content: 'ok',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"hits":2}' },
      ],
    });
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[0]?.parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'QQ==' },
    });
    expect(body.contents[1]?.parts[1]).toEqual({
      functionCall: { name: 'lookup', args: { q: 'x' } },
    });
    expect(body.contents[2]?.parts[0]).toEqual({
      functionResponse: { name: 'lookup', response: { hits: 2 } },
    });
    expect(body.generationConfig).toEqual({
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 64,
      stopSequences: ['X'],
    });
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    const decls = body.tools?.[0]?.functionDeclarations;
    expect(decls?.[0]?.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    expect(decls?.[1]).toEqual({ name: 'noargs' });
  });
});

describe('GeminiProvider', () => {
  it('calls generateContent with x-goog-api-key and translates the response', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'thinking', thought: true },
                { text: 'Hello' },
                { functionCall: { name: 'lookup', args: { q: 'z' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 2,
          totalTokenCount: 14,
        },
      }),
    );
    const res = await provider.complete(req, makeCtx('gemini', {}, { secret: 'AIza-key' }));
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(calls[0]?.headers['x-goog-api-key']).toBe('AIza-key');
    expect(calls[0]?.url).not.toContain('AIza-key');
    const choice = res.choices[0];
    expect(choice?.message.content).toBe('Hello');
    expect(choice?.message.tool_calls?.[0]?.function).toEqual({
      name: 'lookup',
      arguments: '{"q":"z"}',
    });
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(res.usage).toEqual({ prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 });
  });

  it('maps finish reasons', async () => {
    const respond = (finishReason: string) =>
      stubFetch(() =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }] }),
      );
    respond('MAX_TOKENS');
    expect((await provider.complete(req, makeCtx('gemini'))).choices[0]?.finish_reason).toBe(
      'length',
    );
    respond('SAFETY');
    expect((await provider.complete(req, makeCtx('gemini'))).choices[0]?.finish_reason).toBe(
      'content_filter',
    );
  });

  it('streams text, function calls and final usage via alt=sse', async () => {
    const calls = stubFetch(() =>
      sseResponse(
        [
          sse({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
          sse({ candidates: [{ content: { parts: [{ text: 'lo' }] } }] }),
          sse({
            candidates: [
              {
                content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          }),
        ],
        50,
      ),
    );
    const chunks = await collect(provider.stream(req, makeCtx('gemini')));
    expect(calls[0]?.url).toContain(':streamGenerateContent?alt=sse');
    const s = summarizeChunks(chunks);
    expect(s.text).toBe('Hello');
    expect(s.toolCalls[0]).toMatchObject({ name: 'f', args: '{"a":1}' });
    expect(s.finish).toBe('tool_calls');
    expect(s.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('maps errors', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 429,
            message: 'Quota exceeded',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
          },
        },
        429,
      ),
    );
    const quota = await failure(provider.complete(req, makeCtx('gemini')));
    expect(quota).toMatchObject({ kind: 'quota_exhausted', retryAfterMs: 30_000, status: 429 });

    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        },
        400,
      ),
    );
    expect((await failure(provider.complete(req, makeCtx('gemini')))).kind).toBe('auth');

    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 400,
            message:
              'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).',
            status: 'INVALID_ARGUMENT',
          },
        },
        400,
      ),
    );
    expect((await failure(provider.complete(req, makeCtx('gemini')))).kind).toBe('context_length');

    stubFetch(() =>
      jsonResponse(
        { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } },
        503,
        { 'retry-after': '2' },
      ),
    );
    expect(await failure(provider.complete(req, makeCtx('gemini')))).toMatchObject({
      kind: 'unavailable',
      retryAfterMs: 2000,
    });

    const ac = new AbortController();
    ac.abort();
    stubFetch(() => jsonResponse({}));
    expect(
      (await failure(provider.complete(req, makeCtx('gemini', {}, { signal: ac.signal })))).kind,
    ).toBe('timeout');
  });

  it('lists generateContent models and honours the allow-list', async () => {
    stubFetch(() =>
      jsonResponse({
        models: [
          { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed-b', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    expect((await provider.listModels(makeCtx('gemini'))).map((m) => m.id)).toEqual(['gemini-a']);
    expect(
      (await provider.listModels(makeCtx('gemini', { models: ['x'] }))).map((m) => m.id),
    ).toEqual(['x']);
  });
});
