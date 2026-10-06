import type { MinuteBucket } from './live';
import type { Account, TimeseriesBucket } from './types';

export interface BurnPoint {
  ts: number;
  tokens: number;
  requests: number;
}

/**
 * Merge the server's per-minute buckets with what the live stream observed, ending at the
 * current (in-progress) minute. Live counts are a lower bound, so take the max per minute.
 */
export function mergeBurn(
  buckets: TimeseriesBucket[] | undefined,
  live: MinuteBucket[],
  now: number,
  minutes = 60,
): BurnPoint[] {
  const end = Math.floor(now / 60_000) * 60_000;
  const start = end - (minutes - 1) * 60_000;
  const map = new Map<number, BurnPoint>();
  for (let ts = start; ts <= end; ts += 60_000) map.set(ts, { ts, tokens: 0, requests: 0 });
  for (const b of buckets ?? []) {
    const m = Math.floor(b.ts / 60_000) * 60_000;
    const p = map.get(m);
    if (p) {
      p.tokens = Math.max(p.tokens, b.tokens);
      p.requests = Math.max(p.requests, b.requests);
    }
  }
  for (const l of live) {
    const p = map.get(l.ts);
    if (p) {
      p.tokens = Math.max(p.tokens, l.tokens);
      p.requests = Math.max(p.requests, l.requests);
    }
  }
  return [...map.values()];
}

/** Average of the last `n` complete points (excludes the in-progress tail). */
export function recentAverage(values: number[], n: number): number {
  const complete = values.slice(0, -1).slice(-n);
  if (complete.length === 0) return 0;
  return complete.reduce((s, v) => s + v, 0) / complete.length;
}

/** Stable categorical slot per account (API order), so colors follow the entity. */
export function accountSlots(accounts: Account[] | undefined): Map<string, number> {
  return new Map((accounts ?? []).map((a, i) => [a.id, i]));
}
