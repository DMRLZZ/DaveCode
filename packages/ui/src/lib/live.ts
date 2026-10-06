import { applyChainEvent, chainsFromRecords, isChainEvent, type RequestChain } from './traffic';
import type { DaveEvent, LogLevel, UsageRecord } from './types';

/**
 * Client-side state derived from the event stream: the activity feed, request chains,
 * live per-minute token buckets and the runner console. Notifications are coalesced so a
 * burst of events causes one render, not hundreds.
 */

export interface LogLine {
  key: string;
  ts: number;
  level: LogLevel;
  message: string;
  source: 'runner' | 'gateway';
  scope?: string;
  taskId?: string;
}

export interface MinuteBucket {
  ts: number;
  tokens: number;
  requests: number;
}

export interface LiveState {
  /** Most recent events, oldest first. */
  events: DaveEvent[];
  /** Request chains, newest first. */
  chains: RequestChain[];
  logs: LogLine[];
  /** Tokens/requests per minute observed live (keyed by minute start). */
  minutes: MinuteBucket[];
  /** Failover events observed (epoch ms), for the "failovers in the last hour" counter. */
  failoverTs: number[];
}

const MAX_EVENTS = 600;
const MAX_CHAINS = 400;
const MAX_LOGS = 3000;
const MAX_MINUTES = 90;
const MAX_SEEN = 4000;

export function minuteOf(ts: number): number {
  return Math.floor(ts / 60_000) * 60_000;
}

/** Stable identity for de-duplicating replayed events (the SSE stream has no `id:` field). */
export function eventKey(e: DaveEvent): string {
  return JSON.stringify(e);
}

export class LiveStore {
  private state: LiveState = { events: [], chains: [], logs: [], minutes: [], failoverTs: [] };
  private readonly chainIndex = new Map<string, RequestChain>();
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pending: DaveEvent[] = [];
  /** `requestId:fromAccountId` → ts, so seeded records and replayed events never double count. */
  private readonly failovers = new Map<string, number>();
  private logSeq = 0;

  constructor(private readonly flushMs = 200) {}

  getState = (): LiveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Ingest one event. Returns false if it was a duplicate (e.g. replay after reconnect). */
  ingest(event: DaveEvent): boolean {
    const key = eventKey(event);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    this.pending.push(event);
    this.schedule();
    return true;
  }

  /** Seed request chains from `GET /api/requests`; live events take precedence. */
  seedRecords(records: UsageRecord[]): void {
    for (const chain of chainsFromRecords(records)) {
      if (!this.chainIndex.has(chain.requestId)) this.chainIndex.set(chain.requestId, chain);
      chain.attempts.slice(0, -1).forEach((a) => {
        this.failovers.set(`${chain.requestId}:${a.accountId}`, a.endedTs ?? chain.startedTs);
      });
    }
    this.dirty = true;
    this.schedule();
  }

  /** Apply pending events synchronously (tests, or before reading state). */
  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.pending.length === 0 && !this.dirty) return;
    const batch = this.pending;
    this.pending = [];
    this.dirty = false;

    const events = this.state.events.concat(batch);
    const logs = this.state.logs.slice();
    const minuteMap = new Map(this.state.minutes.map((m) => [m.ts, { ...m }]));

    for (const e of batch) {
      if (isChainEvent(e)) {
        this.chainIndex.set(e.requestId, applyChainEvent(this.chainIndex.get(e.requestId), e));
      }
      if (e.type === 'request.completed') {
        const m = minuteOf(e.ts);
        const bucket = minuteMap.get(m) ?? { ts: m, tokens: 0, requests: 0 };
        bucket.tokens += e.promptTokens + e.completionTokens;
        bucket.requests += 1;
        minuteMap.set(m, bucket);
      } else if (e.type === 'router.failover') {
        this.failovers.set(`${e.requestId}:${e.fromAccountId}`, e.ts);
      } else if (e.type === 'runner.log') {
        logs.push({
          key: `l${this.logSeq++}`,
          ts: e.ts,
          level: e.level,
          message: e.message,
          source: 'runner',
          taskId: e.taskId,
        });
      } else if (e.type === 'log') {
        logs.push({
          key: `l${this.logSeq++}`,
          ts: e.ts,
          level: e.level,
          message: e.message,
          source: 'gateway',
          scope: e.scope,
        });
      }
    }

    let chains = [...this.chainIndex.values()].sort((a, b) => b.startedTs - a.startedTs);
    if (chains.length > MAX_CHAINS) {
      for (const c of chains.slice(MAX_CHAINS)) this.chainIndex.delete(c.requestId);
      chains = chains.slice(0, MAX_CHAINS);
    }

    logs.sort((a, b) => a.ts - b.ts);
    const hourAgo = Date.now() - 3_600_000;
    for (const [k, ts] of this.failovers) if (ts < hourAgo) this.failovers.delete(k);

    this.state = {
      events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events,
      chains,
      logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs,
      minutes: [...minuteMap.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_MINUTES),
      failoverTs: [...this.failovers.values()].sort((a, b) => a - b),
    };
    for (const l of this.listeners) l();
  }

  clearLogs(): void {
    this.state = { ...this.state, logs: [] };
    for (const l of this.listeners) l();
  }

  /** Stop pending work. Listeners are owned by React and unsubscribe themselves. */
  dispose(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private schedule(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushMs);
  }
}
