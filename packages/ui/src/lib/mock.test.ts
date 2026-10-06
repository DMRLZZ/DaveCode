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
