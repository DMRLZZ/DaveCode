import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DaveEvent, EventBus } from '../events';
import { type Database, openDatabase } from '../storage/database';
import { UsageRepository } from '../storage/usage';
import type { UsageRecord } from '../types';
import { UsageTracker } from './tracker';
import { QuotaEngine } from './window';

const HOUR = 3_600_000;
let db: Database;
let now: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  now = 100 * 24 * HOUR;
});

afterEach(() => {
  db.close();
});

function rec(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: `use_${Math.random().toString(16).slice(2)}`,
    requestId: 'req_x',
    accountId: 'acc_1',
    provider: 'openai',
    model: 'gpt-x',
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 10,
    status: 'success',
    ts: now,
    ...overrides,
  };
}

function setup() {
  const usage = new UsageRepository(db);
  const quota = new QuotaEngine({ clock: () => now });
  const events = new EventBus();
  const tracker = new UsageTracker({
    usage,
    quota,
    events,
    getAccount: (id) => (id === 'acc_1' ? { id, limits: { tokens5h: 100 } } : undefined),
  });
  return { usage, quota, events, tracker };
}

describe('UsageTracker', () => {
  it('hydrates the last 24h of usage into the quota engine', () => {
    const { usage, quota, tracker } = setup();
    usage.insert(rec({ ts: now - 25 * HOUR, promptTokens: 1000 }));
    usage.insert(rec({ ts: now - 6 * HOUR, promptTokens: 100, completionTokens: 0 }));
    usage.insert(rec({ ts: now - HOUR, promptTokens: 20, completionTokens: 0 }));
    expect(tracker.hydrate()).toBe(2);
    const w = quota.usage({ id: 'acc_1', limits: {} }).windows;
    expect(w['24h']).toMatchObject({ tokens: 120, requests: 2 });
    expect(w['5h']).toMatchObject({ tokens: 20, requests: 1 });
  });

  it('persists records, updates windows and emits quota.updated', () => {
    const { usage, tracker, events } = setup();
    const seen: DaveEvent[] = [];
    events.subscribe((e) => seen.push(e));
    const result = tracker.record(rec({ promptTokens: 40, completionTokens: 10 }));
    expect(result.windows['5h']).toMatchObject({ tokens: 50, tokenLimit: 100, utilization: 0.5 });
    expect(usage.recent()).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'quota.updated', usage: { accountId: 'acc_1' } });
  });

  it('treats unknown accounts as unlimited', () => {
    const { tracker } = setup();
    const result = tracker.record(rec({ accountId: 'acc_gone' }));
    expect(result.accountId).toBe('acc_gone');
    expect(result.windows['5h'].utilization).toBe(0);
  });
});
