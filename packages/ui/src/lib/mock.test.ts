import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { MockEngine, mulberry32 } from './mock';
import { chainsFromRecords } from './traffic';
import type { DaveEvent } from './types';

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 200 }, () => a());
    expect(xs).toEqual(Array.from({ length: 200 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('MockEngine', () => {
  const engine = () => new MockEngine({ seed: 7, latency: false });

  it('simulates 4–5 accounts across providers with gemini-web disabled', async () => {
    const accounts = await engine().listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(4);
    expect(accounts.length).toBeLessThanOrEqual(5);
    expect(new Set(accounts.map((a) => a.provider))).toEqual(
      new Set(['anthropic', 'openai', 'openai-compatible', 'claude-cli', 'gemini-web']),
    );
    const gemini = accounts.find((a) => a.provider === 'gemini-web');
    expect(gemini?.enabled).toBe(false);
    expect(gemini?.status).toBe('disabled');
  });

  it('generates an hour of traffic including failover chains', async () => {
    const e = engine();
    const buckets = await e.timeseries(60, 60);
    expect(buckets).toHaveLength(60);
    expect(buckets.reduce((s, b) => s + b.tokens, 0)).toBeGreaterThan(100_000);
    const records = await e.requests(2000);
    expect(records.length).toBeGreaterThan(300);
    // Newest first.
    expect(records[0]!.ts).toBeGreaterThanOrEqual(records[records.length - 1]!.ts);
    const chains = chainsFromRecords(records);
    expect(chains.some((c) => c.failovers > 0 && c.outcome === 'success')).toBe(true);
  });

  it('reports quota windows with a hot subscription account', async () => {
    const usage = await engine().usage();
    const claude = usage.find((u) => u.accountId === 'acc_claude_pro');
    expect(claude?.windows['5h'].utilization).toBeGreaterThan(0.75);
    const ollama = usage.find((u) => u.accountId === 'acc_ollama_local');
    expect(ollama?.windows['5h'].utilization).toBe(0);
  });

  it('serves a ~12 task graph in mixed states whose dependencies exist', async () => {
    const { graph, project } = await engine().tasks();
    expect(project?.name).toBe('DaveCode');
    expect(graph.tasks.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(graph.tasks.map((t) => t.id));
    for (const t of graph.tasks) for (const d of t.dependsOn) expect(ids.has(d)).toBe(true);
    const statuses = new Set(graph.tasks.map((t) => t.status));
    expect(statuses).toEqual(new Set(['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED']));
  });

  it('rejects gemini-web accounts while the experimental flag is off', async () => {
    await expect(
      engine().createAccount({ provider: 'gemini-web', label: 'web' }),
    ).rejects.toMatchObject({ status: 400, code: 'experimental_disabled' });
  });

  it('never returns the secret of a created account', async () => {
    const e = engine();
    const account = await e.createAccount({
      provider: 'openai',
      label: 'Mine',
      secret: 'sk-test-123',
    });
    expect(JSON.stringify(account)).not.toContain('sk-test-123');
    expect(JSON.stringify(await e.listAccounts())).not.toContain('sk-test-123');
  });

  it('answers 501 runner_unavailable when the runner is disabled', async () => {
    const e = new MockEngine({ latency: false, runnerAvailable: false });
    const err = await e.runner().catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(501);
    expect((err as ApiError).code).toBe('runner_unavailable');
  });

  describe('editing the task graph', () => {
    const catchApi = async (p: Promise<unknown>) => (await p.catch((x: unknown) => x)) as ApiError;

    it('creates a PENDING task and emits task.updated', async () => {
      const e = engine();
      const events: DaveEvent[] = [];
      const stop = e.subscribe({ onEvent: (ev) => events.push(ev) });
      const task = await e.createTask({
        id: 'docs',
        title: 'Write docs',
        dependsOn: ['p3-brain'],
        priority: 2,
      });
      expect(task).toMatchObject({ id: 'docs', status: 'PENDING', dependsOn: ['p3-brain'] });
      expect((await e.tasks()).graph.tasks.some((t) => t.id === 'docs')).toBe(true);
      expect(events.some((ev) => ev.type === 'task.updated' && ev.task.id === 'docs')).toBe(true);
      stop();
      e.stop();
    });

    it('rejects duplicates, unknown dependencies and cycles like the gateway', async () => {
      const e = engine();
      expect(await catchApi(e.createTask({ id: 'p1-storage', title: 'x' }))).toMatchObject({
        status: 409,
        code: 'duplicate_id',
      });
      expect(await catchApi(e.createTask({ id: 'Bad Id', title: 'x' }))).toMatchObject({
        status: 400,
        code: 'invalid_body',
      });
      expect(
        await catchApi(e.createTask({ id: 'n', title: 'x', dependsOn: ['ghost'] })),
      ).toMatchObject({ status: 400, code: 'unknown_dependency' });
      const cycle = await catchApi(e.updateTask('p1-storage', { dependsOn: ['p1-identity'] }));
      expect(cycle).toMatchObject({ status: 400, code: 'cycle' });
      expect(cycle.cycle).toEqual(['p1-storage', 'p1-identity', 'p1-storage']);
    });

    it('updates fields, clears them with null and enforces transitions', async () => {
      const e = engine();
      const renamed = await e.updateTask('p1-gateway', { title: 'Gateway!', priority: null });
      expect(renamed.title).toBe('Gateway!');
      expect(renamed).not.toHaveProperty('priority');
      expect(await catchApi(e.updateTask('p1-gateway', { status: 'SUCCESS' }))).toMatchObject({
        status: 409,
        code: 'invalid_transition',
      });
      const started = await e.updateTask('p1-gateway', { status: 'IN_PROGRESS' });
      expect(started).toMatchObject({ status: 'IN_PROGRESS', attempts: 1 });
      expect(await catchApi(e.updateTask('nope', { title: 'x' }))).toMatchObject({ status: 404 });
    });

    it('refuses to delete a task with dependents, then deletes a leaf and emits task.removed', async () => {
      const e = engine();
      const refused = await catchApi(e.deleteTask('p1-storage'));
      expect(refused).toMatchObject({ status: 409, code: 'has_dependents' });
      expect(refused.dependents).toEqual(expect.arrayContaining(['p1-identity', 'p2-quota']));
      expect(await catchApi(e.deleteTask('p2-router'))).toMatchObject({ status: 409 });

      const events: DaveEvent[] = [];
      const stop = e.subscribe({ onEvent: (ev) => events.push(ev) });
      await e.deleteTask('release-0.1.0');
      expect((await e.tasks()).graph.tasks.some((t) => t.id === 'release-0.1.0')).toBe(false);
      expect(events.some((ev) => ev.type === 'task.removed' && ev.taskId === 'release-0.1.0')).toBe(
        true,
      );
      stop();
      e.stop();
    });

    it('explains why a targeted runner start is refused', async () => {
      const e = new MockEngine({ seed: 7, latency: false });
      expect(
        await catchApi(
          e.runnerAction('stop').then(() => e.runnerAction('start', { taskId: 'zzz' })),
        ),
      ).toMatchObject({
        status: 404,
        code: 'task_not_found',
      });
      expect(await catchApi(e.runnerAction('start', { taskId: 'p1-storage' }))).toMatchObject({
        status: 409,
        code: 'task_not_runnable',
      });
      const blocked = await catchApi(e.runnerAction('start', { taskId: 'p5-cli' }));
      expect(blocked).toMatchObject({ status: 409, code: 'task_blocked' });
      expect(blocked.message).toContain('"p1-gateway"');
      e.stop();
    });
  });

  describe('editing routes', () => {
    const catchApi = async (p: Promise<unknown>) => (await p.catch((x: unknown) => x)) as ApiError;

    it('replaces the routes and default route, visible in routes() and models()', async () => {
      const e = engine();
      const res = await e.updateRoutes({
        routes: [
          { name: 'only', targets: [{ provider: 'openai', model: 'gpt-5.5' }] },
          { name: 'second', targets: [{ provider: 'anthropic', model: 'claude-haiku-5' }] },
        ],
        defaultRoute: 'second',
      });
      expect(res).toMatchObject({ defaultRoute: 'second', shadowedByProject: false });
      expect(await e.routes()).toEqual({
        defaultRoute: 'second',
        routes: res.routes,
      });
      const ids = (await e.models()).filter((m) => m.owned_by === 'davecode').map((m) => m.id);
      expect(ids).toEqual(['davecode/only', 'davecode/second']);
    });

    it('validates like the gateway', async () => {
      const e = engine();
      const target = { provider: 'openai' as const, model: 'm' };
      for (const body of [
        { routes: [{ name: 'Bad', targets: [target] }] },
        { routes: [{ name: 'a', targets: [] }] },
        {
          routes: [
            { name: 'a', targets: [target] },
            { name: 'a', targets: [target] },
          ],
        },
        { routes: [{ name: 'a', targets: [target] }], defaultRoute: 'missing' },
        { routes: [{ name: 'a', targets: [{ ...target, model: ' ' }] }] },
      ]) {
        expect(await catchApi(e.updateRoutes(body))).toMatchObject({
          status: 400,
          code: 'invalid_body',
        });
      }
      expect(
        await catchApi(
          e.updateRoutes({
            routes: [{ name: 'a', targets: [{ ...target, accountId: 'acc_nope' }] }],
          }),
        ),
      ).toMatchObject({ status: 400, code: 'unknown_account' });
      // Nothing was applied.
      expect((await e.routes()).routes.map((r) => r.name)).toContain('auto');
    });
  });

  describe('live simulation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('replays the buffer, then streams requests and runner transitions', async () => {
      const e = new MockEngine({ seed: 3, latency: false });
      const events: DaveEvent[] = [];
      const stop = e.subscribe({ onEvent: (ev) => events.push(ev) });
      await vi.advanceTimersByTimeAsync(0);
      const replayed = events.length;
      expect(replayed).toBeGreaterThan(20);

      await vi.advanceTimersByTimeAsync(60_000);
      const live = events.slice(replayed);
      const types = new Set(live.map((ev) => ev.type));
      expect(types.has('request.started')).toBe(true);
      expect(types.has('request.completed')).toBe(true);
      expect(types.has('quota.updated')).toBe(true);
      expect(types.has('runner.status')).toBe(true);
      expect(types.has('runner.log')).toBe(true);
      // The initial task merges within the first minute.
      expect(live.some((ev) => ev.type === 'task.updated' && ev.task.status === 'SUCCESS')).toBe(
        true,
      );

      await e.runnerAction('pause');
      expect((await e.runner()).state).toBe('paused');
      await e.runnerAction('start');
      expect((await e.runner()).state).not.toBe('paused');
      await e.runnerAction('stop');
      expect((await e.runner()).state).toBe('stopped');
      stop();
      e.stop();
    });
  });
});
