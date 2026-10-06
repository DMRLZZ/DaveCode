import { describe, expect, it } from 'vitest';
import type { QuotaLimits } from '../types';
import { limitsFor, QuotaEngine, WINDOW_MS } from './window';

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(start = 10 * 24 * HOUR) {
  let now = start;
  const engine = new QuotaEngine({ clock: () => now });
  return {
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const account = (limits: QuotaLimits = {}) => ({ id: 'acc_1', limits });

describe('limitsFor', () => {
  it('maps windows to limit fields and ignores non-positive limits', () => {
    const limits: QuotaLimits = { tpm: 10, rpm: 2, tokens5h: 0, requestsDaily: 5 };
    expect(limitsFor('1m', limits)).toEqual({ tokenLimit: 10, requestLimit: 2 });
    expect(limitsFor('5h', limits)).toEqual({});
    expect(limitsFor('24h', limits)).toEqual({ requestLimit: 5 });
  });
});

describe('QuotaEngine', () => {
  it('reports zero usage and full headroom for unknown or unlimited accounts', () => {
    const { engine } = setup();
    const usage = engine.usage(account());
    expect(usage.accountId).toBe('acc_1');
    expect(usage.windows['1m']).toEqual({ window: '1m', tokens: 0, requests: 0, utilization: 0 });
    expect(engine.headroom(account())).toBe(1);
    engine.record('acc_1', 1_000_000);
    expect(engine.headroom(account())).toBe(1);
    expect(engine.wouldExceed(account(), 1e9)).toBe(false);
  });

  it('accumulates tokens and requests in every window', () => {
    const { engine, advance } = setup();
    engine.record('acc_1', 100);
    advance(500);
    engine.record('acc_1', 50);
    advance(2000);
    engine.record('acc_1', 25, { requests: 2 });
    const { windows } = engine.usage(account());
    for (const w of ['1m', '5h', '24h'] as const) {
      expect(windows[w].tokens).toBe(175);
      expect(windows[w].requests).toBe(4);
    }
  });

  it('slides each window independently', () => {
    const { engine, advance } = setup();
    engine.record('acc_1', 100);
    advance(WINDOW_MS['1m'] + 1000);
    engine.record('acc_1', 10);
    let w = engine.usage(account()).windows;
    expect(w['1m'].tokens).toBe(10);
    expect(w['5h'].tokens).toBe(110);
    advance(5 * HOUR);
    w = engine.usage(account()).windows;
    expect(w['1m'].tokens).toBe(0);
    expect(w['5h'].tokens).toBe(0);
    expect(w['24h'].tokens).toBe(110);
    advance(24 * HOUR);
    w = engine.usage(account()).windows;
    expect(w['24h'].tokens).toBe(0);
    expect(engine.trackedAccounts()).toEqual([]);
  });

  it('computes utilization as the max of token and request ratios', () => {
    const { engine } = setup();
    const acc = account({ tpm: 1000, rpm: 4, tokens5h: 10_000 });
    engine.record('acc_1', 500);
    engine.record('acc_1', 100);
    engine.record('acc_1', 100);
    const usage = engine.usage(acc);
    expect(usage.windows['1m']).toMatchObject({
      tokens: 700,
      requests: 3,
      tokenLimit: 1000,
      requestLimit: 4,
      utilization: 0.75,
    });
    expect(usage.windows['5h'].utilization).toBeCloseTo(0.07);
    expect(usage.windows['24h'].utilization).toBe(0);
    expect(engine.headroom(acc)).toBeCloseTo(0.25);
    expect(engine.maxUtilization(acc)).toBe(0.75);
  });

  it('predicts overflow for tokens and requests', () => {
    const { engine, advance } = setup();
    const acc = account({ tpm: 1000, rpm: 2 });
    expect(engine.wouldExceed(acc, 1000)).toBe(false);
    expect(engine.wouldExceed(acc, 1001)).toBe(true);
    engine.record('acc_1', 600);
    expect(engine.wouldExceed(acc, 400)).toBe(false);
    expect(engine.wouldExceed(acc, 401)).toBe(true);
    engine.record('acc_1', 0);
    expect(engine.wouldExceed(acc, 1)).toBe(true); // rpm reached
    advance(61_000);
    expect(engine.wouldExceed(acc, 1000)).toBe(false);
  });

  it('clamps headroom to 0 when over the limit', () => {
    const { engine } = setup();
    const acc = account({ tpm: 100 });
    engine.record('acc_1', 250);
    expect(engine.usage(acc).windows['1m'].utilization).toBe(2.5);
    expect(engine.headroom(acc)).toBe(0);
  });

  it('accepts historical timestamps (hydration)', () => {
    const { engine, now } = setup();
    engine.record('acc_1', 100, { ts: now() - 23 * HOUR });
    engine.record('acc_1', 10, { ts: now() - 2 * HOUR });
    engine.record('acc_1', 1, { ts: now() - 1000 });
    const w = engine.usage(account()).windows;
    expect(w['24h'].tokens).toBe(111);
    expect(w['5h'].tokens).toBe(11);
    expect(w['1m'].tokens).toBe(1);
  });

  it('folds out-of-order events into the newest slot', () => {
    const { engine, now } = setup();
    engine.record('acc_1', 5);
    engine.record('acc_1', 7, { ts: now() - 10 * MIN });
    expect(engine.usage(account()).windows['1m'].tokens).toBe(12);
  });

  it('coalesces events per second and compacts expired slots', () => {
    const { engine, advance } = setup();
    for (let i = 0; i < 10; i++) engine.record('acc_1', 1);
    expect(engine.slotCount('acc_1')).toBe(1);
    for (let i = 0; i < 3000; i++) {
      engine.record('acc_1', 1);
      advance(30_000);
    }
    // 3000 slots × 30 s = 25 h of traffic; only ~24 h (2880 slots) can be live, and
    // compaction keeps the backlog of expired slots bounded.
    expect(engine.usage(account()).windows['24h'].requests).toBeLessThanOrEqual(2881);
    expect(engine.slotCount('acc_1')).toBeLessThan(2880 * 2);
    advance(25 * HOUR);
    engine.usage(account());
    expect(engine.slotCount('acc_1')).toBe(0);
  });

  it('forgets accounts', () => {
    const { engine } = setup();
    engine.record('acc_1', 5);
    engine.forget('acc_1');
    expect(engine.usage(account()).windows['1m'].tokens).toBe(0);
  });

  it('handles many operations quickly (no full scans)', () => {
    const { engine, advance } = setup();
    const acc = account({ tpm: 1e12 });
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) {
      engine.record('acc_1', 10);
      engine.wouldExceed(acc, 10);
      advance(250);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
