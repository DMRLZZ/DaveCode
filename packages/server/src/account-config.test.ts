import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;

async function setup(): Promise<void> {
  t = makeTestEngine();
  app = await buildGateway(t.engine);
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
});

const KEY = 'sk-test-key-123';

async function post(payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/accounts', payload: payload as object });
}

async function patch(id: string, payload: unknown) {
  return app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, payload: payload as object });
}

describe('account config writable through the API', () => {
  it('still creates an OpenAI-compatible account with a base URL, models and key', async () => {
    await setup();
    const res = await post({
      provider: 'openai-compatible',
      label: 'Local',
      config: { baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama'] },
      secret: KEY,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().account.hasSecret).toBe(true);
    expect(res.payload).not.toContain(KEY);
  });

  it('rejects executable settings on create for every provider', async () => {
    await setup();
    for (const provider of ['claude-cli', 'codex-cli', 'gemini-cli', 'openai-compatible']) {
      const res = await post({
        provider,
        label: 'x',
        config: { binaryPath: '/bin/sh', binaryArgs: ['-c', 'true'] },
      });
      expect(res.statusCode, provider).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
      expect(res.payload).toContain('binaryPath');
    }
    expect(t.engine.accounts.list()).toEqual([]);
  });

  it('rejects unknown keys and malformed values on create', async () => {
    await setup();
    expect(
      (await post({ provider: 'anthropic', label: 'x', config: { other: 1 } })).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          provider: 'openai-compatible',
          label: 'x',
          config: { baseUrl: 'file:///etc' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          provider: 'openai-compatible',
          label: 'x',
          config: { baseUrl: 'http://user:pw@host/v1' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post({ provider: 'anthropic', label: 'x', config: { models: 'not-a-list' } }))
        .statusCode,
    ).toBe(400);
  });

  it('rejects executable settings on PATCH and leaves the account unchanged', async () => {
    await setup();
    const created = t.engine.accounts.create({
      provider: 'claude-cli',
      label: 'cli',
      config: { binaryPath: '/usr/local/bin/claude' },
    });
    for (const config of [
      { binaryPath: '/bin/sh' },
      { binaryPath: '/usr/local/bin/claude', binaryArgs: ['-c'] },
    ]) {
      const res = await patch(created.id, { config });
      expect(res.statusCode).toBe(400);
    }
    expect(t.engine.accounts.get(created.id)?.config).toEqual({
      binaryPath: '/usr/local/bin/claude',
    });
  });

  it('keeps keys the API cannot write when other config is updated', async () => {
    await setup();
    const created = t.engine.accounts.create({
      provider: 'claude-cli',
      label: 'cli',
      config: { binaryPath: '/usr/local/bin/claude', binaryArgs: ['--x'] },
    });
    const res = await patch(created.id, { config: { models: ['sonnet'] } });
    expect(res.statusCode).toBe(200);
    expect(t.engine.accounts.get(created.id)?.config).toEqual({
      binaryPath: '/usr/local/bin/claude',
      binaryArgs: ['--x'],
      models: ['sonnet'],
    });
  });

  it('accepts a client sending back unchanged stored values', async () => {
    await setup();
    const created = t.engine.accounts.create({
      provider: 'openai-compatible',
      label: 'x',
      config: { baseUrl: 'http://127.0.0.1:1/v1', defaultHeaders: { 'x-team': 'a' } },
    });
    const res = await patch(created.id, {
      config: {
        baseUrl: 'http://127.0.0.1:1/v1',
        defaultHeaders: { 'x-team': 'a' },
        models: ['m'],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to move an account with a stored secret to another URL without the secret', async () => {
    await setup();
    const res = await post({
      provider: 'openai-compatible',
      label: 'x',
      config: { baseUrl: 'https://api.example.com/v1' },
      secret: KEY,
    });
    const id = res.json().account.id as string;

    const moved = await patch(id, { config: { baseUrl: 'https://other.example.net/v1' } });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error.code).toBe('secret_required');
    expect(t.engine.accounts.get(id)?.config.baseUrl).toBe('https://api.example.com/v1');

    const removed = await patch(id, { config: { models: ['m'] } });
    expect(removed.statusCode).toBe(400);
    expect(t.engine.accounts.get(id)?.config.baseUrl).toBe('https://api.example.com/v1');
  });

  it('allows an endpoint change when the secret is sent again in the same request', async () => {
    await setup();
    const res = await post({
      provider: 'openai-compatible',
      label: 'x',
      config: { baseUrl: 'https://api.example.com/v1' },
      secret: KEY,
    });
    const id = res.json().account.id as string;
    const moved = await patch(id, {
      config: { baseUrl: 'https://other.example.net/v1' },
      secret: 'sk-new-key',
    });
    expect(moved.statusCode).toBe(200);
    expect(t.engine.keyring.get(id)).toBe('sk-new-key');
  });

  it('allows endpoint and model changes on an account that holds no secret', async () => {
    await setup();
    const res = await post({
      provider: 'openai-compatible',
      label: 'x',
      config: { baseUrl: 'http://127.0.0.1:11434/v1' },
    });
    const id = res.json().account.id as string;
    const moved = await patch(id, { config: { baseUrl: 'http://127.0.0.1:8000/v1' } });
    expect(moved.statusCode).toBe(200);
  });

  it('allows changes that keep the endpoint (models, trailing slash) with a stored secret', async () => {
    await setup();
    const res = await post({
      provider: 'openai-compatible',
      label: 'x',
      config: { baseUrl: 'https://api.example.com/v1' },
      secret: KEY,
    });
    const id = res.json().account.id as string;
    const same = await patch(id, {
      config: { baseUrl: 'https://api.example.com/v1/', models: ['m'] },
    });
    expect(same.statusCode).toBe(200);
  });
});
