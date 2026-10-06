import { describe, expect, it } from 'vitest';
import { backoffDelay, parseEvent } from './events';
import { LiveStore, minuteOf } from './live';
import type { DaveEvent } from './types';

describe('LiveStore', () => {
  const now = Date.now();
  const completed: DaveEvent = {
    type: 'request.completed',
    requestId: 'r1',
    model: 'gpt-5.5',
    accountId: 'acc_openai',
    provider: 'openai',
    promptTokens: 1000,
    completionTokens: 250,
    latencyMs: 800,
    ts: now,
  };

  it('de-duplicates replayed events', () => {
    const store = new LiveStore(0);
    expect(store.ingest(completed)).toBe(true);
    expect(store.ingest({ ...completed })).toBe(false);
    store.flush();
    expect(store.getState().events).toHaveLength(1);
  });

  it('aggregates live tokens per minute and tracks failovers', () => {
    const store = new LiveStore(0);
    store.ingest(completed);
    store.ingest({ ...completed, requestId: 'r2', promptTokens: 10, completionTokens: 5 });
    store.ingest({
      type: 'router.failover',
      requestId: 'r3',
      fromAccountId: 'a',
      toAccountId: 'b',
      reason: 'rate_limit',
      ts: now,
    });
    store.flush();
    const { minutes, failoverTs, chains } = store.getState();
    expect(minutes).toEqual([{ ts: minuteOf(now), tokens: 1265, requests: 2 }]);
    expect(failoverTs).toHaveLength(1);
    expect(chains).toHaveLength(3);
  });

  it('collects runner and gateway logs in time order', () => {
    const store = new LiveStore(0);
    store.ingest({ type: 'runner.log', level: 'info', message: 'second', ts: now + 1 });
    store.ingest({ type: 'log', level: 'warn', scope: 'router', message: 'first', ts: now });
    store.flush();
    expect(store.getState().logs.map((l) => [l.message, l.source])).toEqual([
      ['first', 'gateway'],
      ['second', 'runner'],
    ]);
  });
});

describe('event stream helpers', () => {
  it('backs off exponentially with a 30s cap', () => {
    const mid = () => 0.5; // zero jitter
    expect([1, 2, 3, 4, 10].map((n) => backoffDelay(n, mid))).toEqual([
      1000, 2000, 4000, 8000, 30000,
    ]);
  });

  it('parses frames and drops malformed ones', () => {
    expect(parseEvent('{"type":"log","level":"info","scope":"x","message":"y","ts":1}')?.type).toBe(
      'log',
    );
    expect(parseEvent('not json')).toBeNull();
    expect(parseEvent('{"no":"type"}')).toBeNull();
  });
});
