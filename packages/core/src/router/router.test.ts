import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, type DaveConfigInput } from '../config/schema';
import { ProviderError } from '../errors';
import { type DaveEvent, EventBus } from '../events';
import { ChromiumProfileManager } from '../identity/chromium';
import { Keyring } from '../identity/keyring';
import { SandboxManager } from '../identity/sandbox';
import { estimateTokens } from '../rate-limiter/tokens';
import { UsageTracker } from '../rate-limiter/tracker';
import { QuotaEngine } from '../rate-limiter/window';
import { type AccountCreateInput, AccountRepository } from '../storage/accounts';
import { type Database, openDatabase } from '../storage/database';
import { UsageRepository } from '../storage/usage';
import type { ChatCompletionChunk, ChatRequest, ProviderKind } from '../types';
import { RouterError } from './errors';
import { Router, type RouterOptions } from './router';
import { FakeProvider, providerError } from './testing';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-router-'));
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface HarnessOptions {
  config?: DaveConfigInput;
  random?: () => number;
  breaker?: RouterOptions['breaker'];
}

function harness(options: HarnessOptions = {}) {
  let now = 1_760_000_000_000;
  const clock = () => now;
  const config = configSchema.parse(options.config ?? {});
  const accounts = new AccountRepository(db, clock);
  const usage = new UsageRepository(db);
  const quota = new QuotaEngine({ clock });
  const events = new EventBus(1000);
  const tracker = new UsageTracker({ usage, quota, events, getAccount: (id) => accounts.get(id) });
  const sandboxes = new SandboxManager(join(root, 'sandboxes'));
  const chromium = new ChromiumProfileManager({
    root: join(root, 'profiles'),
    experimentalEnabled: config.experimental.geminiWeb,
  });
  const keyring = new Keyring(db, { key: randomBytes(32) });
  const fakes = new Map<ProviderKind, FakeProvider>();
  const providers = new Map<ProviderKind, FakeProvider>();
  for (const kind of [
    'anthropic',
    'openai',
    'gemini',
    'openai-compatible',
    'claude-cli',
    'codex-cli',
    'gemini-web',
  ] as const) {
    const fake = new FakeProvider(kind, [`${kind}-listed-model`]);
    fakes.set(kind, fake);
    providers.set(kind, fake);
  }
  const router = new Router({
    config,
    accounts,
    providers,
    quota,
    tracker,
    events,
    sandboxes,
    chromium,
    keyring,
    clock,
    random: options.random ?? (() => 0.5),
    breaker: options.breaker,
  });
  const seen: DaveEvent[] = [];
  events.subscribe((e) => seen.push(e));
  return {
    router,
    accounts,
    usage,
    quota,
    keyring,
    providers,
    sandboxes,
    chromium,
    events: seen,
    fake: (kind: ProviderKind) => fakes.get(kind)!,
    add(input: AccountCreateInput) {
      now += 1000; // distinct createdAt for deterministic tie-breaks
      return accounts.create(input);
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    ofType<T extends DaveEvent['type']>(type: T) {
      return seen.filter((e): e is Extract<DaveEvent, { type: T }> => e.type === type);
    },
  };
}

const chat = (model: string, content = 'hello'): ChatRequest => ({
  model,
  messages: [{ role: 'user', content }],
});

async function collect(chunks: AsyncIterable<ChatCompletionChunk>): Promise<string> {
  let text = '';
  for await (const chunk of chunks) text += chunk.choices[0]?.delta.content ?? '';
  return text;
}

describe('Router.complete', () => {
  it('serves from the best account by priority and records usage', async () => {
    const h = harness();
    const low = h.add({ provider: 'openai', label: 'low', priority: 50 });
    h.add({ provider: 'openai', label: 'high', priority: 10 });
    const best = h.accounts.list()[0]!;
    h.fake('openai').script(best.id, {
      type: 'complete',
      content: 'hi',
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
    const { completion, meta } = await h.router.complete(chat('openai/gpt-x'), {
      requestId: 'req_test',
    });
    expect(completion.choices[0]?.message.content).toBe('hi');
    expect(meta).toEqual({
      requestId: 'req_test',
      accountId: best.id,
      provider: 'openai',
      model: 'gpt-x',
      failovers: 0,
    });
    expect(best.id).not.toBe(low.id);
    expect(h.usage.recent()).toMatchObject([
      { requestId: 'req_test', accountId: best.id, promptTokens: 7, completionTokens: 3 },
    ]);
    expect(h.events.map((e) => e.type)).toEqual([
      'request.started',
      'quota.updated',
      'request.completed',
    ]);
    expect(h.quota.usage(best).windows['1m']).toMatchObject({ tokens: 10, requests: 1 });
  });

  it('estimates tokens when the upstream omits usage', async () => {
    const h = harness();
    h.add({ provider: 'openai', label: 'a' });
    const req = chat('openai/gpt-x', 'count these words please');
    await h.router.complete(req);
    const [record] = h.usage.recent();
    expect(record?.promptTokens).toBe(estimateTokens(req.messages));
    expect(record?.completionTokens).toBeGreaterThan(0);
  });

  it('passes decrypted secrets and the per-account sandbox to providers', async () => {
    const h = harness();
    const cli = h.add({ provider: 'claude-cli', label: 'cli' });
    h.keyring.set(cli.id, 'sk-test');
    await h.router.complete(chat('claude-cli/claude-x'));
    expect(h.fake('claude-cli').calls[0]).toMatchObject({
      accountId: cli.id,
      model: 'claude-x',
      secret: 'sk-test',
      sandboxDir: h.sandboxes.dirFor(cli.id),
    });
  });

  it('fails over on 429 to the next account and cools the first down', async () => {
    const h = harness({ config: { routing: { cooldownMs: 30_000 } } });
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    const b = h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, {
      type: 'error',
      error: providerError('rate_limit', { status: 429 }),
    });

    const { meta } = await h.router.complete(chat('openai/gpt-x'));
    expect(meta).toMatchObject({ accountId: b.id, failovers: 1 });
    expect(h.ofType('router.failover')).toMatchObject([
      { fromAccountId: a.id, toAccountId: b.id, reason: 'rate_limit' },
    ]);
    const cooled = h.accounts.get(a.id)!;
    expect(cooled.status).toBe('cooldown');
    expect(Date.parse(cooled.cooldownUntil!)).toBe(h.now() + 30_000);
    expect(h.ofType('account.updated').map((e) => e.account.id)).toContain(a.id);
    expect(h.usage.recent().map((r) => [r.accountId, r.status])).toEqual([
      [b.id, 'success'],
      [a.id, 'rate_limited'],
    ]);

    // While cooling down, A is skipped entirely.
    const again = await h.router.complete(chat('openai/gpt-x'));
    expect(again.meta).toMatchObject({ accountId: b.id, failovers: 0 });

    // After the cooldown, A is back and its status is restored on success.
    h.advance(30_001);
    const later = await h.router.complete(chat('openai/gpt-x'));
    expect(later.meta.accountId).toBe(a.id);
    expect(h.accounts.get(a.id)).toMatchObject({ status: 'active' });
    expect(h.accounts.get(a.id)?.cooldownUntil).toBeUndefined();
  });

  it('honours Retry-After for the cooldown', async () => {
    const h = harness({ config: { routing: { cooldownMs: 60_000 } } });
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, {
      type: 'error',
      error: providerError('unavailable', { status: 503, retryAfterMs: 5_000 }),
    });
    await h.router.complete(chat('openai/gpt-x'));
    expect(Date.parse(h.accounts.get(a.id)!.cooldownUntil!)).toBe(h.now() + 5_000);
  });

  it('does not fail over on auth errors and marks the account as error', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    const b = h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, { type: 'error', error: providerError('auth', { status: 401 }) });
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'auth',
    });
    expect(h.fake('openai').calls.map((c) => c.accountId)).toEqual([a.id]);
    expect(h.accounts.get(a.id)).toMatchObject({ status: 'error', lastError: 'fake auth' });
    expect(h.ofType('router.failover')).toHaveLength(0);
    // Errored accounts are skipped afterwards.
    const { meta } = await h.router.complete(chat('openai/gpt-x'));
    expect(meta.accountId).toBe(b.id);
  });

  it('propagates bad_request and unknown errors without touching the account', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(
      a.id,
      { type: 'error', error: providerError('bad_request', { status: 400 }) },
      { type: 'error', error: new Error('adapter crashed') },
    );
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      kind: 'bad_request',
    });
    const err = await h.router.complete(chat('openai/gpt-x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'unknown', message: 'adapter crashed', accountId: a.id });
    expect(h.accounts.get(a.id)?.status).toBe('active');
    expect(h.fake('openai').calls).toHaveLength(2);
  });

  it('fails over on context_length without cooling the account down', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    const b = h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, { type: 'error', error: providerError('context_length') });
    const { meta } = await h.router.complete(chat('openai/gpt-x'));
    expect(meta.accountId).toBe(b.id);
    expect(h.accounts.get(a.id)?.status).toBe('active');
  });

  it('stops after routing.maxFailovers hops', async () => {
    const h = harness({ config: { routing: { maxFailovers: 1 } } });
    const ids = [1, 2, 3].map((p) => h.add({ provider: 'openai', label: `${p}`, priority: p }).id);
    for (const id of ids) {
      h.fake('openai').script(id, {
        type: 'error',
        error: providerError('unavailable', { status: 503 }),
      });
    }
    const err = await h.router.complete(chat('openai/gpt-x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err).toMatchObject({ code: 'upstream_failed', status: 502, failovers: 1 });
    expect(h.fake('openai').calls.map((c) => c.accountId)).toEqual(ids.slice(0, 2));
    const hops = h.ofType('router.failover');
    expect(hops.at(-1)?.toAccountId).toBeNull();
  });

  it('reports rate_limited (429) when every attempt was rate limited', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.fake('openai').script(a.id, { type: 'error', error: providerError('rate_limit') });
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    // Now cooling down: no capacity at all.
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      code: 'no_capacity',
      status: 429,
    });
  });

  it('distinguishes unknown models and unavailable accounts', async () => {
    const h = harness();
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      code: 'model_not_found',
      status: 404,
    });
    h.add({ provider: 'openai', label: 'off', enabled: false });
    await expect(h.router.complete(chat('openai/gpt-x'))).rejects.toMatchObject({
      code: 'no_available_account',
    });
  });

  it('skips accounts whose provider adapter is not registered', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.providers.delete('openai');
    expect(h.router.plan(chat('openai/gpt-x')).skipped).toEqual([
      { accountId: a.id, model: 'gpt-x', reason: 'no_provider' },
    ]);
  });
});

describe('experimental and subscription filtering', () => {
  it('excludes gemini-web unless experimental.geminiWeb is on', async () => {
    const off = harness();
    off.add({ provider: 'gemini-web', label: 'web' });
    await expect(off.router.complete(chat('gemini-web/gemini-x'))).rejects.toMatchObject({
      code: 'experimental_disabled',
      status: 400,
    });
    expect(off.fake('gemini-web').calls).toHaveLength(0);
  });

  it('routes to gemini-web with an isolated Chromium profile when enabled', async () => {
    const on = harness({ config: { experimental: { geminiWeb: true } } });
    const web = on.add({ provider: 'gemini-web', label: 'web' });
    const { meta } = await on.router.complete(chat('gemini-web/gemini-x'));
    expect(meta.accountId).toBe(web.id);
    expect(on.fake('gemini-web').calls[0]?.sandboxDir).toBe(on.chromium.profileDir(web.id));
  });

  it('uses only the best subscription account per provider without rotation', async () => {
    const h = harness();
    const second = h.add({ provider: 'claude-cli', label: 'second', priority: 20 });
    const primary = h.add({ provider: 'claude-cli', label: 'primary', priority: 10 });
    const plan = h.router.plan(chat('claude-cli/claude-x'));
    expect(plan.candidates.map((c) => c.account.id)).toEqual([primary.id]);
    expect(plan.skipped).toEqual([
      { accountId: second.id, model: 'claude-x', reason: 'subscription' },
    ]);

    h.fake('claude-cli').script(primary.id, { type: 'error', error: providerError('rate_limit') });
    await expect(h.router.complete(chat('claude-cli/claude-x'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(h.fake('claude-cli').calls.map((c) => c.accountId)).toEqual([primary.id]);
    // The secondary login does not take over while the primary cools down.
    await expect(h.router.complete(chat('claude-cli/claude-x'))).rejects.toMatchObject({
      code: 'no_capacity',
    });
  });

  it('breaks subscription ties by age', () => {
    const h = harness();
    const older = h.add({ provider: 'codex-cli', label: 'older' });
    h.add({ provider: 'codex-cli', label: 'newer' });
    expect(h.router.plan(chat('codex-cli/gpt-x')).candidates.map((c) => c.account.id)).toEqual([
      older.id,
    ]);
  });

  it('still fails over from a subscription to API-key accounts', async () => {
    const h = harness({
      config: {
        routing: {
          routes: [
            {
              name: 'auto',
              targets: [
                { provider: 'claude-cli', model: 'claude-x' },
                { provider: 'anthropic', model: 'claude-x' },
              ],
            },
          ],
        },
      },
    });
    const cli = h.add({ provider: 'claude-cli', label: 'cli' });
    const api = h.add({ provider: 'anthropic', label: 'api' });
    h.fake('claude-cli').script(cli.id, { type: 'error', error: providerError('quota_exhausted') });
    const { meta } = await h.router.complete(chat('davecode/auto'));
    expect(meta).toMatchObject({ accountId: api.id, provider: 'anthropic', failovers: 1 });
  });

  it('rotates subscription accounts when multiAccountRotation is on', async () => {
    const h = harness({ config: { experimental: { multiAccountRotation: true } } });
    const a = h.add({ provider: 'claude-cli', label: 'a', priority: 1 });
    const b = h.add({ provider: 'claude-cli', label: 'b', priority: 2 });
    h.fake('claude-cli').script(a.id, { type: 'error', error: providerError('rate_limit') });
    const { meta } = await h.router.complete(chat('claude-cli/claude-x'));
    expect(meta).toMatchObject({ accountId: b.id, failovers: 1 });
  });
});

describe('scoring', () => {
  it('applies backpressure above the threshold', async () => {
    const h = harness();
    const busy = h.add({ provider: 'openai', label: 'busy', limits: { tpm: 1000 } });
    const idle = h.add({ provider: 'openai', label: 'idle', limits: { tpm: 1000 } });
    h.quota.record(busy.id, 880); // 88% > 85%
    h.quota.record(idle.id, 100);
    const plan = h.router.plan(chat('openai/gpt-x', 'hi'));
    expect(plan.candidates.map((c) => c.account.label)).toEqual(['idle', 'busy']);
    const [first, second] = plan.candidates;
    expect(first!.effectiveWeight).toBeCloseTo(0.9);
    // headroom 0.12 × backpressure (0.12 / 0.15)
    expect(second!.effectiveWeight).toBeCloseTo(0.12 * 0.8);
  });

  it('prefers higher weight × headroom within a priority', () => {
    const h = harness();
    h.add({ provider: 'openai', label: 'light', weight: 1 });
    h.add({ provider: 'openai', label: 'heavy', weight: 3 });
    expect(h.router.plan(chat('openai/gpt-x')).candidates.map((c) => c.account.label)).toEqual([
      'heavy',
      'light',
    ]);
  });

  it('balances traffic proportionally to weight', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const h = harness({ random });
    h.add({ provider: 'openai', label: 'light', weight: 1 });
    h.add({ provider: 'openai', label: 'heavy', weight: 3 });
    let heavy = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      if (h.router.plan(chat('openai/gpt-x')).candidates[0]?.account.label === 'heavy') heavy++;
    }
    expect(heavy / runs).toBeGreaterThan(0.7);
    expect(heavy / runs).toBeLessThan(0.8);
  });

  it('shifts traffic to alternates above the 5h quota threshold', () => {
    const h = harness();
    const preferred = h.add({
      provider: 'anthropic',
      label: 'preferred',
      priority: 1,
      limits: { tokens5h: 1000 },
    });
    h.add({ provider: 'anthropic', label: 'alternate', priority: 2 });
    h.quota.record(preferred.id, 800);
    expect(h.router.plan(chat('anthropic/claude-x')).candidates[0]?.account.label).toBe(
      'preferred',
    );
    h.quota.record(preferred.id, 110); // 91% of 5h
    const plan = h.router.plan(chat('anthropic/claude-x'));
    expect(plan.candidates.map((c) => [c.account.label, c.shifted])).toEqual([
      ['alternate', false],
      ['preferred', true],
    ]);
  });

  it('filters accounts whose window would overflow', () => {
    const h = harness();
    const tight = h.add({ provider: 'openai', label: 'tight', limits: { rpm: 1 } });
    h.add({ provider: 'openai', label: 'roomy' });
    h.quota.record(tight.id, 1);
    const plan = h.router.plan(chat('openai/gpt-x'));
    expect(plan.candidates.map((c) => c.account.label)).toEqual(['roomy']);
    expect(plan.skipped).toEqual([{ accountId: tight.id, model: 'gpt-x', reason: 'quota' }]);
  });

  it('orders route targets before priority and sends each target its own model', async () => {
    const h = harness({
      config: {
        routing: {
          routes: [
            {
              name: 'fast',
              targets: [
                { provider: 'openai', model: 'gpt-fast' },
                { provider: 'anthropic', model: 'claude-fast' },
              ],
            },
          ],
        },
      },
    });
    const ant = h.add({ provider: 'anthropic', label: 'ant', priority: 1 });
    const oai = h.add({ provider: 'openai', label: 'oai', priority: 50 });
    h.fake('openai').script(oai.id, { type: 'error', error: providerError('timeout') });
    const { meta } = await h.router.complete(chat('davecode/fast'));
    expect(meta).toMatchObject({ accountId: ant.id, model: 'claude-fast', failovers: 1 });
    expect(h.fake('openai').calls[0]?.model).toBe('gpt-fast');
    expect(h.fake('anthropic').calls[0]?.model).toBe('claude-fast');
  });
});

describe('circuit breaker integration', () => {
  it('skips an account after consecutive failures and probes it after the reset', async () => {
    const h = harness({
      config: { routing: { cooldownMs: 0 } },
      breaker: { failureThreshold: 2, resetMs: 10_000 },
    });
    const flaky = h.add({ provider: 'openai', label: 'flaky', priority: 1 });
    const stable = h.add({ provider: 'openai', label: 'stable', priority: 2 });
    const fail = { type: 'error', error: providerError('unavailable') } as const;
    h.fake('openai').script(flaky.id, fail, fail);
    await h.router.complete(chat('openai/gpt-x'));
    h.advance(1);
    await h.router.complete(chat('openai/gpt-x'));
    h.advance(1);
    expect(h.router.breaker.state(flaky.id)).toBe('open');
    const plan = h.router.plan(chat('openai/gpt-x'));
    expect(plan.skipped).toEqual([{ accountId: flaky.id, model: 'gpt-x', reason: 'circuit_open' }]);
    expect((await h.router.complete(chat('openai/gpt-x'))).meta.accountId).toBe(stable.id);

    h.advance(10_000);
    expect(h.router.breaker.state(flaky.id)).toBe('half_open');
    expect((await h.router.complete(chat('openai/gpt-x'))).meta.accountId).toBe(flaky.id);
    expect(h.router.breaker.state(flaky.id)).toBe('closed');
  });
});

describe('Router.stream', () => {
  it('streams chunks and records usage once consumed', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.fake('openai').script(a.id, {
      type: 'stream',
      chunks: ['Hel', 'lo'],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    const { meta, chunks } = await h.router.stream(chat('openai/gpt-x'));
    expect(meta).toMatchObject({ accountId: a.id, failovers: 0 });
    expect(h.usage.recent()).toHaveLength(0);
    expect(await collect(chunks)).toBe('Hello');
    expect(h.usage.recent()).toMatchObject([
      { accountId: a.id, status: 'success', promptTokens: 4, completionTokens: 2 },
    ]);
    expect(h.ofType('request.completed')).toHaveLength(1);
  });

  it('fails over when the stream errors before the first chunk', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    const b = h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, {
      type: 'stream',
      chunks: ['never'],
      failAfter: 0,
      error: providerError('rate_limit', { retryAfterMs: 1000 }),
    });
    const { meta, chunks } = await h.router.stream(chat('openai/gpt-x'));
    expect(meta).toMatchObject({ accountId: b.id, failovers: 1 });
    expect(await collect(chunks)).toBe(`ok from ${b.id}`);
    expect(h.accounts.get(a.id)?.status).toBe('cooldown');
  });

  it('does not fail over once the first chunk was produced', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, {
      type: 'stream',
      chunks: ['partial ', 'never'],
      failAfter: 1,
      error: providerError('unavailable'),
    });
    const { meta, chunks } = await h.router.stream(chat('openai/gpt-x'));
    expect(meta.accountId).toBe(a.id);
    const received: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of chunks) received.push(String(chunk.choices[0]?.delta.content));
      })(),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(received).toEqual(['partial ']);
    expect(h.fake('openai').calls).toHaveLength(1);
    expect(h.usage.recent()).toMatchObject([{ accountId: a.id, status: 'error' }]);
    expect(h.ofType('request.failed')).toHaveLength(1);
    expect(h.ofType('router.failover')).toHaveLength(0);
  });

  it('records usage and releases upstream when the consumer stops early', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.fake('openai').script(a.id, { type: 'stream', chunks: ['one ', 'two ', 'three'] });
    const { chunks } = await h.router.stream(chat('openai/gpt-x'));
    for await (const chunk of chunks) {
      expect(chunk.choices[0]?.delta.content).toBe('one ');
      break;
    }
    expect(h.usage.recent()).toMatchObject([{ accountId: a.id, status: 'success' }]);
  });

  it('treats a client abort mid-stream as cancelled, not as an account failure', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.fake('openai').script(a.id, {
      type: 'stream',
      chunks: ['one ', 'two '],
      failAfter: 1,
      error: providerError('timeout'),
    });
    const controller = new AbortController();
    const { chunks } = await h.router.stream(chat('openai/gpt-x'), { signal: controller.signal });
    await expect(
      (async () => {
        for await (const _chunk of chunks) controller.abort();
      })(),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(h.usage.recent()).toMatchObject([{ accountId: a.id, status: 'cancelled' }]);
    expect(h.accounts.get(a.id)).toMatchObject({ status: 'active' });
    expect(h.accounts.get(a.id)?.cooldownUntil).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'request.failed')).toHaveLength(0);
  });

  it('does not fail over or cool down when the client aborts before the first byte', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a', priority: 1 });
    const b = h.add({ provider: 'openai', label: 'b', priority: 2 });
    h.fake('openai').script(a.id, { type: 'error', error: providerError('timeout') });
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.router.complete(chat('openai/gpt-x'), { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(h.fake('openai').calls.map((c) => c.accountId)).toEqual([a.id]);
    expect(h.accounts.get(a.id)).toMatchObject({ status: 'active' });
    expect(h.usage.recent()).toMatchObject([{ accountId: a.id, status: 'cancelled' }]);
    expect(b.status).toBe('active');
  });

  it('treats an empty stream as success', async () => {
    const h = harness();
    const a = h.add({ provider: 'openai', label: 'a' });
    h.fake('openai').script(a.id, { type: 'stream', chunks: [] });
    const { chunks } = await h.router.stream(chat('openai/gpt-x'));
    expect(await collect(chunks)).toBe('');
    expect(h.usage.recent()).toMatchObject([{ status: 'success' }]);
  });
});

describe('Router.listModels', () => {
  it('lists account models, routes and the default route', async () => {
    const h = harness({
      config: {
        routing: { routes: [{ name: 'fast', targets: [{ provider: 'openai', model: 'gpt-x' }] }] },
      },
    });
    h.add({ provider: 'openai', label: 'listed', config: { models: ['gpt-x', 'gpt-y'] } });
    h.add({ provider: 'anthropic', label: 'dynamic' });
    h.add({ provider: 'openai', label: 'dup', config: { models: ['gpt-x'] } });
    h.add({ provider: 'gemini', label: 'off', enabled: false });
    h.add({ provider: 'gemini-web', label: 'web' });
    const ids = (await h.router.listModels()).map((m) => [m.id, m.owned_by]);
    expect(ids).toEqual([
      ['gpt-x', 'openai'],
      ['gpt-y', 'openai'],
      ['anthropic-listed-model', 'anthropic'],
      ['davecode/auto', 'davecode'],
      ['davecode/fast', 'davecode'],
    ]);
  });
});
