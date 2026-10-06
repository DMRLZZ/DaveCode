/**
 * End-to-end: HTTP client → gateway → router → real OpenAI-compatible adapter → local upstream.
 * The first account is rate limited, so the request must fail over to the second one.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type Engine } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';

interface Upstream {
  server: Server;
  url: string;
  hits: Record<string, number>;
  lastAuth: Record<string, string | undefined>;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Two fake upstreams on one server: `/limited/v1` always 429s, `/ok/v1` answers. */
async function startUpstream(): Promise<Upstream> {
  const hits: Record<string, number> = { limited: 0, ok: 0 };
  const lastAuth: Record<string, string | undefined> = {};
  const server = createServer(async (req, res) => {
    const name = req.url?.startsWith('/limited/') ? 'limited' : 'ok';
    hits[name] = (hits[name] ?? 0) + 1;
    lastAuth[name] = req.headers.authorization;
    const body = await readBody(req);

    if (name === 'limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit' } }));
      return;
    }

    const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of ['Hello', ' from', ' upstream']) {
        const chunk = {
          id: 'chatcmpl-e2e',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      const final = {
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      };
      res.end(`data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-e2e',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from upstream' },
            finish_reason: 'stop',
          },
        ],
        usage,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, hits, lastAuth };
}

describe('gateway end-to-end with real adapters', () => {
  let home: string;
  let engine: Engine;
  let app: FastifyInstance;
  let upstream: Upstream;

  beforeAll(async () => {
    upstream = await startUpstream();
    home = mkdtempSync(join(tmpdir(), 'davecode-e2e-'));
    engine = createEngine({
      home,
      databasePath: ':memory:',
      env: { DAVECODE_MASTER_KEY: randomBytes(32).toString('base64') },
    });
    app = await buildGateway(engine, { logger: false });

    const accounts = [
      { label: 'limited', priority: 1, path: 'limited', secret: 'sk-limited' },
      { label: 'healthy', priority: 2, path: 'ok', secret: 'sk-healthy' },
    ];
    for (const account of accounts) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: {
          provider: 'openai-compatible',
          label: account.label,
          priority: account.priority,
          secret: account.secret,
          config: { baseUrl: `${upstream.url}/${account.path}/v1`, models: ['e2e-model'] },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.stringify(res.json())).not.toContain(account.secret);
    }
  });

  afterAll(async () => {
    await app.close();
    engine.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  it('fails over from a 429 to the next account and decrypts the right secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'openai-compatible/e2e-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-davecode-failovers']).toBe('1');
    expect(res.json().choices[0].message.content).toBe('Hello from upstream');
    expect(upstream.hits.limited).toBe(1);
    expect(upstream.lastAuth.limited).toBe('Bearer sk-limited');
    expect(upstream.lastAuth.ok).toBe('Bearer sk-healthy');
  });

  it('keeps the rate-limited account in cooldown for the next request', async () => {
    const before = upstream.hits.limited;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'openai-compatible/e2e-model',
        messages: [{ role: 'user', content: 'again' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-davecode-failovers']).toBe('0');
    expect(upstream.hits.limited).toBe(before);
  });

  it('streams chunks through the gateway as OpenAI SSE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'openai-compatible/e2e-model',
        stream: true,
        messages: [{ role: 'user', content: 'stream please' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const text = res.body
      .split('\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Hello from upstream');
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('records usage for the account that served the request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/requests?limit=10' });
    const records = res.json().requests as Array<{ status: string; promptTokens: number }>;
    expect(records.some((r) => r.status === 'success' && r.promptTokens === 7)).toBe(true);
    expect(records.some((r) => r.status === 'rate_limited')).toBe(true);
  });
});
