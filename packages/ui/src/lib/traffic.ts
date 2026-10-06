import type { DaveEvent, ProviderErrorKind, ProviderKind, UsageRecord } from './types';

/**
 * A request as the user experiences it: one `requestId`, possibly several upstream attempts
 * linked by failovers (acc A → 429 → acc B ✓). Built from `request.*` / `router.failover`
 * events and from `UsageRecord`s grouped by `requestId`.
 */
export type AttemptOutcome = 'pending' | 'success' | 'failed';

export interface ChainAttempt {
  accountId: string;
  provider: ProviderKind;
  startedTs: number;
  endedTs?: number;
  outcome: AttemptOutcome;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  errorKind?: ProviderErrorKind;
  errorStatus?: number;
  errorMessage?: string;
  /** The router announced a failover away from this attempt. */
  failedOver?: boolean;
}

export interface RequestChain {
  requestId: string;
  model: string;
  startedTs: number;
  updatedTs: number;
  attempts: ChainAttempt[];
  outcome: AttemptOutcome;
  failovers: number;
  /** True once the router reported there is no further candidate (`toAccountId: null`). */
  exhausted: boolean;
}

export type ChainEvent = Extract<
  DaveEvent,
  { type: 'request.started' | 'request.completed' | 'request.failed' | 'router.failover' }
>;

export function isChainEvent(e: DaveEvent): e is ChainEvent {
  return (
    e.type === 'request.started' ||
    e.type === 'request.completed' ||
    e.type === 'request.failed' ||
    e.type === 'router.failover'
  );
}

export function emptyChain(requestId: string, ts: number, model = ''): RequestChain {
  return {
    requestId,
    model,
    startedTs: ts,
    updatedTs: ts,
    attempts: [],
    outcome: 'pending',
    failovers: 0,
    exhausted: false,
  };
}

function lastPendingIndex(attempts: ChainAttempt[], accountId: string): number {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (a && a.accountId === accountId && a.outcome === 'pending') return i;
  }
  return -1;
}

/**
 * Seeded records and replayed events describe the same attempts. Two observations of the
 * same account within this window are treated as one attempt.
 */
const MATCH_MS = 2000;

function findMatching(
  attempts: ChainAttempt[],
  accountId: string,
  ts: number,
  field: 'startedTs' | 'endedTs',
  outcome?: AttemptOutcome,
): number {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i];
    if (!a || a.accountId !== accountId) continue;
    if (outcome && a.outcome !== outcome) continue;
    const at = a[field];
    if (at !== undefined && Math.abs(at - ts) <= MATCH_MS) return i;
  }
  return -1;
}

function deriveOutcome(chain: RequestChain): AttemptOutcome {
  const last = chain.attempts[chain.attempts.length - 1];
  if (!last) return 'pending';
  if (last.outcome === 'success') return 'success';
  if (last.outcome === 'pending') return 'pending';
  // The last attempt failed: the request is only over if the router gave up, or if no
  // failover was announced for it (non-eligible errors such as `auth` end the request).
  if (chain.exhausted) return 'failed';
  return chain.failovers >= chain.attempts.length ? 'pending' : 'failed';
}

/** Pure reducer: returns a new chain with the event applied. */
export function applyChainEvent(chain: RequestChain | undefined, e: ChainEvent): RequestChain {
  const base = chain ?? emptyChain(e.requestId, e.ts);
  const next: RequestChain = {
    ...base,
    attempts: base.attempts.map((a) => ({ ...a })),
    startedTs: Math.min(base.startedTs, e.ts),
    updatedTs: Math.max(base.updatedTs, e.ts),
  };

  switch (e.type) {
    case 'request.started': {
      if (!next.model) next.model = e.model;
      if (
        lastPendingIndex(next.attempts, e.accountId) === -1 &&
        findMatching(next.attempts, e.accountId, e.ts, 'startedTs') === -1
      ) {
        next.attempts.push({
          accountId: e.accountId,
          provider: e.provider,
          startedTs: e.ts,
          outcome: 'pending',
        });
      }
      break;
    }
    case 'request.completed': {
      if (!next.model) next.model = e.model;
      let i = lastPendingIndex(next.attempts, e.accountId);
      if (i === -1) i = findMatching(next.attempts, e.accountId, e.ts, 'endedTs', 'success');
      if (i === -1) {
        next.attempts.push({
          accountId: e.accountId,
          provider: e.provider,
          startedTs: e.ts - e.latencyMs,
          outcome: 'pending',
        });
        i = next.attempts.length - 1;
      }
      const a = next.attempts[i];
      if (a) {
        a.outcome = 'success';
        a.endedTs = e.ts;
        a.latencyMs = e.latencyMs;
        a.promptTokens = e.promptTokens;
        a.completionTokens = e.completionTokens;
      }
      next.startedTs = Math.min(next.startedTs, e.ts - e.latencyMs);
      break;
    }
    case 'request.failed': {
      let i = lastPendingIndex(next.attempts, e.accountId);
      if (i === -1) i = findMatching(next.attempts, e.accountId, e.ts, 'endedTs', 'failed');
      if (i === -1) {
        next.attempts.push({
          accountId: e.accountId,
          provider: e.provider,
          startedTs: e.ts,
          outcome: 'pending',
        });
        i = next.attempts.length - 1;
      }
      const a = next.attempts[i];
      if (a) {
        const wasPending = a.outcome === 'pending';
        a.outcome = 'failed';
        a.endedTs = wasPending ? e.ts : (a.endedTs ?? e.ts);
        a.latencyMs = a.latencyMs ?? e.ts - a.startedTs;
        a.errorKind = e.error.kind;
        a.errorStatus = e.error.status;
        a.errorMessage = e.error.message;
      }
      break;
    }
    case 'router.failover': {
      if (e.toAccountId === null) next.exhausted = true;
      let found = false;
      for (let i = next.attempts.length - 1; i >= 0; i--) {
        const a = next.attempts[i];
        if (a && a.accountId === e.fromAccountId) {
          found = true;
          if (!a.failedOver) {
            a.failedOver = true;
            next.failovers += 1;
          }
          a.errorKind ??= e.reason;
          if (a.outcome === 'pending') {
            a.outcome = 'failed';
            a.endedTs = e.ts;
          }
          break;
        }
      }
      if (!found) next.failovers += 1;
      break;
    }
  }

  next.outcome = deriveOutcome(next);
  return next;
}

/** Build chains from `GET /api/requests` records (one record per upstream attempt). */
export function chainsFromRecords(records: UsageRecord[]): RequestChain[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const list = groups.get(r.requestId);
    if (list) list.push(r);
    else groups.set(r.requestId, [r]);
  }
  const chains: RequestChain[] = [];
  for (const [requestId, list] of groups) {
    list.sort((a, b) => a.ts - b.ts);
    const first = list[0];
    if (!first) continue;
    const attempts: ChainAttempt[] = list.map((r, i) => ({
      accountId: r.accountId,
      provider: r.provider,
      startedTs: r.ts - r.latencyMs,
      endedTs: r.ts,
      outcome: r.status === 'success' ? 'success' : 'failed',
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      errorKind: r.errorKind ?? (r.status === 'rate_limited' ? 'rate_limit' : undefined),
      errorStatus: r.status === 'rate_limited' ? 429 : undefined,
      failedOver: i < list.length - 1,
    }));
    const last = attempts[attempts.length - 1];
    chains.push({
      requestId,
      model: first.model,
      startedTs: attempts[0]?.startedTs ?? first.ts,
      updatedTs: last?.endedTs ?? first.ts,
      attempts,
      outcome: last?.outcome === 'success' ? 'success' : 'failed',
      failovers: Math.max(0, attempts.length - 1),
      exhausted: last?.outcome !== 'success',
    });
  }
  return chains.sort((a, b) => b.startedTs - a.startedTs);
}

export function chainTokens(chain: RequestChain): { prompt: number; completion: number } {
  let prompt = 0;
  let completion = 0;
  for (const a of chain.attempts) {
    prompt += a.promptTokens ?? 0;
    completion += a.completionTokens ?? 0;
  }
  return { prompt, completion };
}

/** End-to-end latency as the client saw it (first attempt start → last attempt end). */
export function chainLatency(chain: RequestChain): number | undefined {
  const last = chain.attempts[chain.attempts.length - 1];
  if (!last?.endedTs) return undefined;
  return last.endedTs - chain.startedTs;
}

export function errorStatusLabel(a: ChainAttempt): string {
  if (a.errorStatus) return String(a.errorStatus);
  switch (a.errorKind) {
    case 'rate_limit':
      return '429';
    case 'quota_exhausted':
      return 'quota';
    case 'unavailable':
      return '503';
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'auth':
      return '401';
    case 'context_length':
      return 'ctx';
    case 'bad_request':
      return '400';
    default:
      return 'error';
  }
}
