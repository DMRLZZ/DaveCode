import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;

async function setup(config?: Parameters<typeof makeTestEngine>[0]): Promise<void> {
  t = makeTestEngine(config);
  app = await buildGateway(t.engine, {});
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
});

const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/routes', payload });
const stored = () =>
  JSON.parse(readFileSync(join(t.home, 'config.json'), 'utf8')) as Record<string, unknown>;

const fast: Route = {
  name: 'fast',
  description: 'cheap',
  targets: [
    { provider: 'openai', model: 'gpt-mini' },
    { provider: 'anthropic', model: 'claude-haiku' },
  ],
};
const deep: Route = {
  name: 'deep',
  targets: [{ provider: 'anthropic', model: 'claude-opus' }],
};

describe('PUT /api/routes', () => {
  it('replaces the routes, persists to the global config and serves them immediately', async () => {
    await setup();
    const res = await put({ routes: [fast, deep], defaultRoute: 'deep' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      defaultRoute: 'deep',
      routes: [fast, deep],
      shadowedByProject: false,
    });
    expect((await app.inject({ method: 'GET', url: '/api/routes' })).json()).toEqual({
      defaultRoute: 'deep',
      routes: [fast, deep],
    });
    // Persisted in the (temp) global config, not anywhere else.
    expect(stored()).toEqual({ routing: { routes: [fast, deep], defaultRoute: 'deep' } });
    // Live engine config and /v1/models reflect it without a restart.
    expect(t.engine.config.routing.routes).toEqual([fast, deep]);
    const models = (await app.inject({ method: 'GET', url: '/v1/models' })).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining(['davecode/fast', 'davecode/deep']),
    );
  });

  it('preserves other config keys and the default route when omitted', async () => {
    await setup();
    writeFileSync(
      join(t.home, 'config.json'),
      JSON.stringify({
        logLevel: 'debug',
        server: { port: 5555 },
        routing: { defaultRoute: 'old' },
      }),
    );
    expect((await put({ routes: [fast] })).statusCode).toBe(200);
    expect(stored()).toEqual({
      logLevel: 'debug',
      server: { port: 5555 },
      routing: { defaultRoute: 'old', routes: [fast] },
    });
    expect(t.engine.config.routing.defaultRoute).toBe('auto');
  });

  it('routes chat completions through the new route right away', async () => {
    await setup();
    t.engine.accounts.create({ provider: 'openai', label: 'o' });
    const chat = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'davecode/mine', messages: [{ role: 'user', content: 'hi' }] },
      });
    expect((await chat()).statusCode).toBe(404);
    await put({
      routes: [{ name: 'mine', targets: [{ provider: 'openai', model: 'openai-model' }] }],
    });
    const ok = await chat();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-davecode-provider']).toBe('openai');
  });

  it('can remove every route', async () => {
    await setup({
      routing: { defaultRoute: 'auto', routes: [fast] },
    });
    expect((await put({ routes: [] })).json().routes).toEqual([]);
    expect(stored()).toEqual({ routing: { routes: [] } });
  });

  it('validates the body with the config schema route shape', async () => {
    await setup();
    for (const payload of [
      {},
      { routes: 'x' },
      { routes: [{ name: 'Bad Name', targets: [{ provider: 'openai', model: 'm' }] }] },
      { routes: [{ name: 'empty', targets: [] }] },
      { routes: [{ name: 'x', targets: [{ provider: 'nope', model: 'm' }] }] },
      { routes: [{ name: 'x', targets: [{ provider: 'openai', model: '' }] }] },
      { routes: [fast], extra: true },
      { routes: [fast, fast] },
      { routes: [fast], defaultRoute: 'missing' },
      { routes: [], defaultRoute: 'auto' },
    ]) {
      const res = await put(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
    }
    expect(t.engine.config.routing.routes).toEqual([]);
  });

  it('rejects a duplicate name with a pointer to it', async () => {
    await setup();
    const res = await put({ routes: [fast, { ...deep, name: 'fast' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('duplicate route name "fast"');
  });

  it('accepts accounts that exist as pinned targets and rejects unknown ones', async () => {
    await setup();
    const account = t.engine.accounts.create({ provider: 'openai', label: 'pinned' });
    const pinned = (accountId: string): Route => ({
      name: 'pin',
      targets: [{ provider: 'openai', model: 'gpt-mini', accountId }],
    });
    expect((await put({ routes: [pinned(account.id)] })).statusCode).toBe(200);
    const bad = await put({ routes: [pinned('acc_nope')] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('unknown_account');
    expect(t.engine.config.routing.routes[0]?.targets[0]?.accountId).toBe(account.id);
  });

  it('409 config_invalid instead of overwriting a broken global config', async () => {
    await setup();
    writeFileSync(join(t.home, 'config.json'), '{ broken');
    const res = await put({ routes: [fast] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('config_invalid');
    expect(readFileSync(join(t.home, 'config.json'), 'utf8')).toBe('{ broken');
    expect(t.engine.config.routing.routes).toEqual([]);
  });

  it('requires the bearer token when one is configured', async () => {
    await setup({ server: { authToken: 'tok' } });
    expect((await put({ routes: [fast] })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/routes',
      headers: { authorization: 'Bearer tok' },
      payload: { routes: [fast] },
    });
    expect(ok.statusCode).toBe(200);
  });
});
