import type { Account, AccountUsage, QuotaLimits, QuotaWindow, WindowUsage } from '../types';

export type Clock = () => number;

export const QUOTA_WINDOWS: readonly QuotaWindow[] = ['1m', '5h', '24h'];

/** Sliding window sizes in milliseconds. */
export const WINDOW_MS: Readonly<Record<QuotaWindow, number>> = {
  '1m': 60_000,
  '5h': 5 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

/** Events within the same slot are coalesced; bounds memory at 86 400 slots per account. */
const SLOT_MS = 1000;
const WINDOW_COUNT = QUOTA_WINDOWS.length;

/** Token/request limits that apply to a window. Non-positive values mean "unlimited". */
export function limitsFor(
  window: QuotaWindow,
  limits: QuotaLimits,
): { tokenLimit?: number; requestLimit?: number } {
  const pick = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
  const out: { tokenLimit?: number; requestLimit?: number } = {};
  let tokens: number | undefined;
  let requests: number | undefined;
  if (window === '1m') {
    tokens = pick(limits.tpm);
    requests = pick(limits.rpm);
  } else if (window === '5h') {
    tokens = pick(limits.tokens5h);
    requests = pick(limits.requests5h);
  } else {
    tokens = pick(limits.tokensDaily);
    requests = pick(limits.requestsDaily);
  }
  if (tokens !== undefined) out.tokenLimit = tokens;
  if (requests !== undefined) out.requestLimit = requests;
  return out;
}

/**
 * One account's activity: a time-ordered queue of 1 s slots shared by all windows, with a
 * head pointer and running sums per window. Each slot is appended once and evicted once
 * per window, so every operation is amortized O(1).
 */
class AccountSeries {
  private slotTs: number[] = [];
  private slotTokens: number[] = [];
  private slotRequests: number[] = [];
  /** Index of the oldest slot still inside each window. */
  private readonly heads = new Array<number>(WINDOW_COUNT).fill(0);
  private readonly tokenSums = new Array<number>(WINDOW_COUNT).fill(0);
  private readonly requestSums = new Array<number>(WINDOW_COUNT).fill(0);

  add(ts: number, tokens: number, requests: number): void {
    const last = this.slotTs.length - 1;
    let slot = Math.floor(ts / SLOT_MS) * SLOT_MS;
    // Keep the queue ordered: late (out-of-order) events are folded into the newest slot.
    if (last >= 0 && slot < this.slotTs[last]!) slot = this.slotTs[last]!;
    if (last >= 0 && this.slotTs[last] === slot) {
      this.slotTokens[last]! += tokens;
      this.slotRequests[last]! += requests;
      for (let w = 0; w < WINDOW_COUNT; w++) {
        if (this.heads[w]! <= last) {
          this.tokenSums[w]! += tokens;
          this.requestSums[w]! += requests;
        }
      }
      return;
    }
    this.slotTs.push(slot);
    this.slotTokens.push(tokens);
    this.slotRequests.push(requests);
    for (let w = 0; w < WINDOW_COUNT; w++) {
      this.tokenSums[w]! += tokens;
      this.requestSums[w]! += requests;
    }
  }

  /** Evict slots that fell out of each window as of `now`. */
  advance(now: number): void {
    const length = this.slotTs.length;
    for (let w = 0; w < WINDOW_COUNT; w++) {
      const cutoff = now - WINDOW_MS[QUOTA_WINDOWS[w]!];
      let head = this.heads[w]!;
      while (head < length && this.slotTs[head]! <= cutoff) {
        this.tokenSums[w]! -= this.slotTokens[head]!;
        this.requestSums[w]! -= this.slotRequests[head]!;
        head++;
      }
      this.heads[w] = head;
    }
    this.compact();
  }

  /**
   * Drop slots that left every window, either when nothing is left or once they make up
   * at least half of a non-trivial queue (amortized O(1)).
   */
  private compact(): void {
    const drop = Math.min(...this.heads);
    const length = this.slotTs.length;
    if (drop === 0) return;
    if (drop < length && (drop < 1024 || drop * 2 < length)) return;
    this.slotTs = this.slotTs.slice(drop);
    this.slotTokens = this.slotTokens.slice(drop);
    this.slotRequests = this.slotRequests.slice(drop);
    for (let w = 0; w < WINDOW_COUNT; w++) this.heads[w]! -= drop;
  }

  totals(windowIndex: number): { tokens: number; requests: number } {
    return { tokens: this.tokenSums[windowIndex]!, requests: this.requestSums[windowIndex]! };
  }

  get empty(): boolean {
    return this.heads.every((h) => h >= this.slotTs.length);
  }

  /** Number of stored slots, including evicted ones awaiting compaction. */
  get size(): number {
    return this.slotTs.length;
  }
}

export interface QuotaEngineOptions {
  clock?: Clock;
}

export interface RecordOptions {
  /** Event time (epoch ms); defaults to the engine clock. */
  ts?: number;
  /** Requests to count (default 1). */
  requests?: number;
}

type QuotaAccount = Pick<Account, 'id' | 'limits'>;

/**
 * In-memory sliding-window accounting (1 m, 5 h, 24 h) of tokens and requests per account.
 * Persistence and hydration live in {@link UsageTracker}.
 */
export class QuotaEngine {
  private readonly series = new Map<string, AccountSeries>();
  readonly clock: Clock;

  constructor(options: QuotaEngineOptions = {}) {
    this.clock = options.clock ?? Date.now;
  }

  record(accountId: string, tokens: number, options: RecordOptions = {}): void {
    let series = this.series.get(accountId);
    if (!series) {
      series = new AccountSeries();
      this.series.set(accountId, series);
    }
    series.add(options.ts ?? this.clock(), Math.max(0, tokens), Math.max(0, options.requests ?? 1));
    series.advance(this.clock());
  }

  private totals(accountId: string): Array<{ tokens: number; requests: number }> {
    const series = this.series.get(accountId);
    if (!series) return QUOTA_WINDOWS.map(() => ({ tokens: 0, requests: 0 }));
    series.advance(this.clock());
    const totals = QUOTA_WINDOWS.map((_, i) => series.totals(i));
    if (series.empty) this.series.delete(accountId);
    return totals;
  }

  usage(account: QuotaAccount): AccountUsage {
    const totals = this.totals(account.id);
    const windows = {} as Record<QuotaWindow, WindowUsage>;
    QUOTA_WINDOWS.forEach((window, i) => {
      const { tokens, requests } = totals[i]!;
      const limits = limitsFor(window, account.limits);
      const usage: WindowUsage = { window, tokens, requests, utilization: 0, ...limits };
      usage.utilization = Math.max(
        limits.tokenLimit ? tokens / limits.tokenLimit : 0,
        limits.requestLimit ? requests / limits.requestLimit : 0,
      );
      windows[window] = usage;
    });
    return { accountId: account.id, windows };
  }

  /** Highest utilization across all windows (0 when unlimited). */
  maxUtilization(account: QuotaAccount): number {
    const { windows } = this.usage(account);
    return Math.max(...QUOTA_WINDOWS.map((w) => windows[w].utilization));
  }

  /** True when one more request of `estimatedTokens` would overflow any window's limit. */
  wouldExceed(account: QuotaAccount, estimatedTokens: number): boolean {
    const totals = this.totals(account.id);
    return QUOTA_WINDOWS.some((window, i) => {
      const { tokens, requests } = totals[i]!;
      const { tokenLimit, requestLimit } = limitsFor(window, account.limits);
      if (tokenLimit !== undefined && tokens + estimatedTokens > tokenLimit) return true;
      if (requestLimit !== undefined && requests + 1 > requestLimit) return true;
      return false;
    });
  }

  /** Remaining capacity in the tightest window, 0..1 (1 when unlimited or idle). */
  headroom(account: QuotaAccount): number {
    return Math.min(1, Math.max(0, 1 - this.maxUtilization(account)));
  }

  /** Drop all in-memory state for an account (e.g. after deletion). */
  forget(accountId: string): void {
    this.series.delete(accountId);
  }

  /** Accounts currently tracked (for tests and diagnostics). */
  trackedAccounts(): string[] {
    return [...this.series.keys()];
  }

  /** Stored 1 s slots for an account (for tests and diagnostics). */
  slotCount(accountId: string): number {
    return this.series.get(accountId)?.size ?? 0;
  }
}
