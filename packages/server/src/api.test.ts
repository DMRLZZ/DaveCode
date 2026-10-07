import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunner,
  type DaveEvent,
  ProjectBrain,
  ProjectBrainSource,
  type RunnerStatus,
  type TaskGraph,
} from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './gateway';
import type { BrainSource, GatewayOptions, RunnerControl } from './options';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;

async function setup(
  config?: Parameters<typeof makeTestEngine>[0],
  options: GatewayOptions = {},
): Promise<DaveEvent[]> {
  t = makeTestEngine(config);
  app = await buildGateway(t.engine, options);
  const seen: DaveEvent[] = [];
  t.engine.events.subscribe((e) => seen.push(e));
  return seen;
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
});

const SECRET = 'sk-super-secret-value';

describe('GET /api/health', () => {
  it('reports status, version and experimental flags', async () => {
    await setup({ experimental: { multiAccountRotation: true } });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      version: expect.any(String),
      uptimeSec: expect.any(Number),
      experimental: { geminiWeb: false, multiAccountRotation: true },
    });
  });
});

describe('/api/accounts', () => {
  it('reports hasSecret without ever returning the secret', async () => {
    await setup();
    const bare = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        provider: 'openai-compatible',
        label: 'Local',
        config: { baseUrl: 'http://x/v1' },
      },
    });
    const { account } = bare.json();
    expect(account.hasSecret).toBe(false);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { secret: SECRET },
    });
    expect(patched.json().account.hasSecret).toBe(true);
    expect(patched.payload).not.toContain(SECRET);

    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.json().accounts[0].hasSecret).toBe(true);
    expect(list.payload).not.toContain(SECRET);
  });

  it('creates accounts with write-only secrets', async () => {
    const seen = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        provider: 'anthropic',
        label: 'Work',
        priority: 10,
        weight: 2,
        limits: { tpm: 1000, tokens5h: 50_000 },
        config: { models: ['claude-x'], maxTokens: 4096 },
        secret: SECRET,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain(SECRET);
    const { account } = res.json();
    expect(account).toMatchObject({
      id: expect.stringMatching(/^acc_/),
      provider: 'anthropic',
      label: 'Work',
      priority: 10,
      weight: 2,
      limits: { tpm: 1000, tokens5h: 50_000 },
      config: { models: ['claude-x'], maxTokens: 4096 },
      status: 'active',
      enabled: true,
    });
    expect(t.engine.keyring.get(account.id)).toBe(SECRET);

    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.json().accounts).toHaveLength(1);
    expect(list.payload).not.toContain(SECRET);

    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(seen.map((e) => e.type)).toContain('account.updated');
    const audit = t.engine.audit.list();
    expect(audit[0]).toMatchObject({ action: 'account.create', target: account.id });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  it('validates bodies', async () => {
    await setup();
    const cases: Array<Record<string, unknown>> = [
      { provider: 'nope', label: 'x' },
      { provider: 'openai' },
      { provider: 'openai', label: 'x', priority: -1 },
      { provider: 'openai', label: 'x', limits: { tpm: 0 } },
      { provider: 'openai', label: 'x', unknownField: true },
      { provider: 'openai', label: 'x', config: { apiKey: 'sk-oops' } },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/accounts', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error: { message: expect.any(String), code: 'invalid_body' } });
    }
    expect(t.engine.accounts.list()).toHaveLength(0);
  });

  it('rejects gemini-web unless the experimental flag is on', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { provider: 'gemini-web', label: 'web' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('experimental_disabled');
    await app.close();
    t.cleanup();

    await setup({ experimental: { geminiWeb: true } });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { provider: 'gemini-web', label: 'web' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('patches accounts and manages status transitions', async () => {
    await setup();
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.engine.accounts.update(account.id, {
      status: 'error',
      lastError: 'bad key',
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    let res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { label: 'renamed', limits: { rpm: 5 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({
      label: 'renamed',
      limits: { rpm: 5 },
      status: 'error',
    });

    res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { secret: SECRET },
    });
    expect(res.payload).not.toContain(SECRET);
    expect(res.json().account.status).toBe('active');
    expect(res.json().account.lastError).toBeUndefined();
    expect(res.json().account.cooldownUntil).toBeUndefined();
    expect(t.engine.keyring.get(account.id)).toBe(SECRET);

    res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { enabled: false },
    });
    expect(res.json().account).toMatchObject({ enabled: false, status: 'disabled' });

    res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { enabled: true },
    });
    expect(res.json().account).toMatchObject({ enabled: true, status: 'active' });

    res = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${account.id}`,
      payload: { provider: 'gemini' },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PATCH', url: '/api/accounts/acc_missing', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { message: 'Account not found', code: 'not_found' } });
  });

  it('deletes accounts with their secret and sandbox', async () => {
    const seen = await setup();
    const account = t.engine.accounts.create({ provider: 'claude-cli', label: 'cli' });
    t.engine.keyring.set(account.id, SECRET);
    const sandbox = t.engine.sandboxes.ensure(account.id);
    t.engine.quota.record(account.id, 100);

    const res = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}` });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');
    expect(t.engine.accounts.get(account.id)).toBeUndefined();
    expect(t.engine.keyring.has(account.id)).toBe(false);
    expect(existsSync(sandbox)).toBe(false);
    expect(t.engine.quota.trackedAccounts()).not.toContain(account.id);
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'account.removed', accountId: account.id }),
    );

    const again = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('usage and logs', () => {
  it('exposes usage, timeseries, recent requests and logs', async () => {
    await setup();
    const account = t.engine.accounts.create({
      provider: 'openai',
      label: 'a',
      limits: { tpm: 10_000 },
    });
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'openai/gpt-x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);

    const usage = (await app.inject({ method: 'GET', url: '/api/usage' })).json();
    expect(usage.usage).toHaveLength(1);
    expect(usage.usage[0]).toMatchObject({
      accountId: account.id,
      windows: { '1m': { window: '1m', requests: 1, tokenLimit: 10_000 } },
    });

    const series = await app.inject({
      method: 'GET',
      url: '/api/usage/timeseries?minutes=10&bucketSec=60',
    });
    expect(series.statusCode).toBe(200);
    const { buckets } = series.json();
    expect(buckets.length).toBeGreaterThanOrEqual(10);
    const total = buckets.reduce((n: number, b: { requests: number }) => n + b.requests, 0);
    expect(total).toBe(1);
    expect(buckets.at(-1).byAccount[account.id]).toMatchObject({ requests: 1 });

    const bad = await app.inject({ method: 'GET', url: '/api/usage/timeseries?minutes=0' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_body');

    const requests = (await app.inject({ method: 'GET', url: '/api/requests?limit=5' })).json();
    expect(requests.requests).toHaveLength(1);
    expect(requests.requests[0]).toMatchObject({ accountId: account.id, status: 'success' });
    expect((await app.inject({ method: 'GET', url: '/api/requests?limit=0' })).statusCode).toBe(
      400,
    );

    const logs = (await app.inject({ method: 'GET', url: '/api/logs?limit=2' })).json();
    expect(logs.events).toHaveLength(2);
    expect(logs.events.at(-1).type).toBe('request.completed');
  });
});

describe('GET /api/routes', () => {
  it('returns the default route and configured routes', async () => {
    const routes = [{ name: 'fast', targets: [{ provider: 'openai' as const, model: 'gpt-x' }] }];
    await setup({ routing: { defaultRoute: 'fast', routes } });
    const res = await app.inject({ method: 'GET', url: '/api/routes' });
    expect(res.json()).toEqual({ defaultRoute: 'fast', routes });
  });
});

describe('brain and runner', () => {
  it('returns empty defaults when Phase 3/4 sources are absent', async () => {
    await setup();
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json()).toEqual({
      project: null,
      graph: { version: 1, tasks: [] },
    });
    expect((await app.inject({ method: 'GET', url: '/api/brain' })).json()).toEqual({
      state: '',
      architecture: '',
    });
    expect((await app.inject({ method: 'GET', url: '/api/runner' })).json()).toEqual({
      status: { state: 'idle' },
    });
    for (const action of ['start', 'pause', 'stop']) {
      const res = await app.inject({ method: 'POST', url: `/api/runner/${action}` });
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('runner_unavailable');
    }
  });

  it('forwards runner refusal codes instead of a generic bad_request', async () => {
    const refusal = Object.assign(new Error('Working tree has uncommitted changes'), {
      statusCode: 409,
      code: 'dirty_worktree',
    });
    const runner: RunnerControl = {
      status: () => ({ state: 'idle' }),
      start: () => Promise.reject(refusal),
      pause: () => {},
      stop: () => {},
    };
    await setup(undefined, { runner });
    const res = await app.inject({ method: 'POST', url: '/api/runner/start' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'dirty_worktree', message: 'Working tree has uncommitted changes' },
    });
  });

  describe('POST /api/runner/start body', () => {
    const makeRunner = () => {
      const start = vi.fn<(opts?: { taskId?: string }) => void>();
      const runner: RunnerControl = {
        status: () => ({ state: 'selecting' }),
        start,
        pause: () => {},
        stop: () => {},
      };
      return Object.assign(runner, { start });
    };

    it('stays backward compatible: no body, empty JSON body and {} all start the loop', async () => {
      const runner = makeRunner();
      await setup(undefined, { runner });
      expect((await app.inject({ method: 'POST', url: '/api/runner/start' })).statusCode).toBe(200);
      const emptyJson = await app.inject({
        method: 'POST',
        url: '/api/runner/start',
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(emptyJson.statusCode).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url: '/api/runner/start', payload: {} })).statusCode,
      ).toBe(200);
      expect(runner.start.mock.calls).toEqual([[{}], [{}], [{}]]);
    });

    it('passes taskId through to the runner', async () => {
      const runner = makeRunner();
      await setup(undefined, { runner });
      const res = await app.inject({
        method: 'POST',
        url: '/api/runner/start',
        payload: { taskId: 'build-api' },
      });
      expect(res.statusCode).toBe(200);
      expect(runner.start).toHaveBeenCalledWith({ taskId: 'build-api' });
    });

    it('rejects a malformed body with 400 invalid_body', async () => {
      const runner = makeRunner();
      await setup(undefined, { runner });
      for (const payload of [{ taskId: 5 }, { taskId: '' }, { other: true }]) {
        const res = await app.inject({ method: 'POST', url: '/api/runner/start', payload });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_body');
      }
      expect(runner.start).not.toHaveBeenCalled();
    });

    it('forwards runner refusals for a task: unknown 404, blocked 409', async () => {
      const refusal = (code: string, status: number, message: string) =>
        Object.assign(new Error(message), { statusCode: status, code });
      const runner: RunnerControl = {
        status: () => ({ state: 'idle' }),
        start: (opts) => {
          if (opts?.taskId === 'zzz') throw refusal('task_not_found', 404, 'unknown task "zzz"');
          if (opts?.taskId === 'b') {
            throw refusal('task_blocked', 409, 'task "b" is blocked by "a" (PENDING)');
          }
        },
        pause: () => {},
        stop: () => {},
      };
      await setup(undefined, { runner });
      const missing = await app.inject({
        method: 'POST',
        url: '/api/runner/start',
        payload: { taskId: 'zzz' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('task_not_found');
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/runner/start',
        payload: { taskId: 'b' },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toEqual({
        code: 'task_blocked',
        message: 'task "b" is blocked by "a" (PENDING)',
      });
    });
  });

  it('delegates to injected brain and runner implementations', async () => {
    const graph: TaskGraph = {
      version: 1,
      tasks: [{ id: 't1', title: 'Task', status: 'PENDING', dependsOn: [] }],
    };
    const brain: BrainSource = {
      project: () => ({ root: '/repo', name: 'repo' }),
      graph: async () => graph,
      state: async () => '# State',
      architecture: async () => '# Arch',
    };
    let status: RunnerStatus = { state: 'idle' };
    const runner: RunnerControl = {
      status: () => status,
      start: vi.fn(() => {
        status = { state: 'selecting', startedAt: '2026-01-01T00:00:00.000Z' };
      }),
      pause: vi.fn(async () => {
        status = { state: 'paused' };
      }),
      stop: vi.fn(() => {
        status = { state: 'stopped' };
      }),
    };
    await setup(undefined, { brain, runner });
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json()).toEqual({
      project: { root: '/repo', name: 'repo' },
      graph,
    });
    expect((await app.inject({ method: 'GET', url: '/api/brain' })).json()).toEqual({
      state: '# State',
      architecture: '# Arch',
    });
    const started = await app.inject({ method: 'POST', url: '/api/runner/start' });
    expect(started.json()).toEqual({
      status: { state: 'selecting', startedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/runner/pause' })).json().status.state,
    ).toBe('paused');
    expect(
      (await app.inject({ method: 'POST', url: '/api/runner/stop' })).json().status.state,
    ).toBe('stopped');
    expect(runner.start).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'GET', url: '/api/runner' })).json().status.state).toBe(
      'stopped',
    );
  });

  it('serves the core ProjectBrainSource and AutonomousRunner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'davecode-api-brain-'));
    try {
      t = makeTestEngine();
      const project = await ProjectBrain.init(root, { events: t.engine.events, name: 'demo' });
      const runner = createRunner(t.engine, { brain: project, global: false });
      app = await buildGateway(t.engine, { brain: new ProjectBrainSource(project), runner });

      const tasks = (await app.inject({ method: 'GET', url: '/api/tasks' })).json();
      expect(tasks.project.root).toBe(root);
      expect(tasks.graph).toEqual({ version: 1, tasks: [] });
      expect((await app.inject({ method: 'GET', url: '/api/brain' })).json().state).toContain(
        '# demo: project state',
      );

      // Not a git repository: the runner refuses to start and the API reports why.
      const start = await app.inject({ method: 'POST', url: '/api/runner/start' });
      expect(start.statusCode).toBe(409);
      expect(start.json().error.message).toMatch(/not inside a git repository/);
      const status = (await app.inject({ method: 'GET', url: '/api/runner' })).json().status;
      expect(status.state).toBe('error');
      const stop = await app.inject({ method: 'POST', url: '/api/runner/stop' });
      expect(stop.json().status.state).toBe('stopped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unknown /api routes', () => {
  it('return the /api error envelope', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { message: 'Unknown endpoint GET /api/nope', code: 'not_found' },
    });
  });
});
