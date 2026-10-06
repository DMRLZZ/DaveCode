import { providerError } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;

async function setup(config?: Parameters<typeof makeTestEngine>[0]) {
  t = makeTestEngine(config);
  app = await buildGateway(t.engine);
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
});

const body = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});

/** Parse an SSE body into its `data:` payloads. */
function sseData(payload: string): string[] {
  return payload
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
}

describe('GET /v1/models', () => {
  beforeEach(() => setup());

  it('lists account models and davecode routes', async () => {
    t.engine.accounts.create({ provider: 'openai', label: 'a', config: { models: ['gpt-x'] } });
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: 'list',
      data: [
        expect.objectContaining({ id: 'gpt-x', object: 'model', owned_by: 'openai' }),
        { id: 'davecode/auto', object: 'model', created: 0, owned_by: 'davecode' },
      ],
    });
  });
});

describe('POST /v1/chat/completions', () => {
  beforeEach(() => setup());

  it('returns a completion with routing headers', async () => {
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x', { presence_penalty: 0.5 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: `ok from ${account.id}` } }],
    });
    expect(res.headers['x-davecode-request-id']).toMatch(/^req_/);
    expect(res.headers['x-davecode-account']).toBe(account.id);
    expect(res.headers['x-davecode-provider']).toBe('openai');
    expect(res.headers['x-davecode-failovers']).toBe('0');
    expect(t.engine.usage.recent()[0]?.requestId).toBe(res.headers['x-davecode-request-id']);
  });

  it('reports failover hops in the headers', async () => {
    const a = t.engine.accounts.create({ provider: 'openai', label: 'a', priority: 1 });
    const b = t.engine.accounts.create({ provider: 'openai', label: 'b', priority: 2 });
    t.fake('openai').script(a.id, { type: 'error', error: providerError('rate_limit') });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-davecode-account']).toBe(b.id);
    expect(res.headers['x-davecode-failovers']).toBe('1');
  });

  it('rejects invalid bodies with the OpenAI error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'x', messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        message: expect.stringContaining('messages'),
        type: 'invalid_request_error',
        code: 'invalid_body',
      },
    });
  });

  it('rejects malformed JSON with the OpenAI error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: '{ nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'invalid_request_error' });
  });

  it('maps routing failures to HTTP statuses', async () => {
    let res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'model_not_found' });

    const a = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.fake('openai').script(a.id, { type: 'error', error: providerError('rate_limit') });
    res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x'),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limited' });
    expect(res.headers['x-davecode-request-id']).toMatch(/^req_/);
  });

  it('maps upstream auth errors to 502 without failing over', async () => {
    const a = t.engine.accounts.create({ provider: 'anthropic', label: 'a' });
    t.fake('anthropic').script(a.id, {
      type: 'error',
      error: providerError('auth', { status: 401 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('anthropic/claude-x'),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ code: 'upstream_auth_error' });
  });

  it('refuses gemini-web while the experimental flag is off', async () => {
    t.engine.accounts.create({ provider: 'gemini-web', label: 'web' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('gemini-web/gemini-x'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'experimental_disabled' });
  });

  it('streams SSE chunks terminated by [DONE]', async () => {
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.fake('openai').script(account.id, { type: 'stream', chunks: ['Hel', 'lo'] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x', { stream: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-davecode-account']).toBe(account.id);
    expect(res.payload.endsWith('data: [DONE]\n\n')).toBe(true);
    const frames = sseData(res.payload);
    expect(frames.at(-1)).toBe('[DONE]');
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    expect(chunks.map((c) => c.choices[0].delta.content).join('')).toBe('Hello');
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk' });
  });

  it('forwards mid-stream failures as a final error frame', async () => {
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.fake('openai').script(account.id, {
      type: 'stream',
      chunks: ['partial', 'never'],
      failAfter: 1,
      error: providerError('unavailable'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x', { stream: true }),
    });
    expect(res.statusCode).toBe(200);
    const frames = sseData(res.payload);
    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[1]!)).toEqual({
      error: { message: 'fake unavailable', type: 'api_error', code: 'unavailable' },
    });
    expect(frames[2]).toBe('[DONE]');
  });

  it('returns a JSON error when a stream fails before the first byte', async () => {
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.fake('openai').script(account.id, {
      type: 'stream',
      chunks: ['x'],
      failAfter: 0,
      error: providerError('rate_limit'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: body('openai/gpt-x', { stream: true }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns 404 envelopes for unknown /v1 endpoints', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/embeddings', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ type: 'invalid_request_error', code: 'not_found' });
  });
});
