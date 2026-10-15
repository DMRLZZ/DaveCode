import type { ReportedLimits, ReportedLimitsInput } from '../types';
import type { Clock } from './window';

/** Header observations without a reset time are trusted for this long. */
const DEFAULT_TTL_MS = 10 * 60_000;

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** OpenAI style durations: "1s", "6m0s", "120ms", "1h2m3.5s". */
export function parseDurationMs(text: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = '';
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
    matched += m[0];
  }
  return matched.length > 0 && matched === text.trim() ? Math.round(total) : undefined;
}

function resetToIso(value: string | null, now: number): string | undefined {
  if (!value) return undefined;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate) && /\d{4}-\d{2}-\d{2}/.test(value)) {
    return new Date(asDate).toISOString();
  }
  const ms = parseDurationMs(value);
  return ms === undefined ? undefined : new Date(now + ms).toISOString();
}

interface Dimension {
  remaining?: number;
  limit?: number;
  resetAt?: string;
}

function dimension(headers: Headers, names: [string, string, string], now: number): Dimension {
  const out: Dimension = {};
  const remaining = num(headers.get(names[0]));
  const limit = num(headers.get(names[1]));
  const resetAt = resetToIso(headers.get(names[2]), now);
  if (remaining !== undefined) out.remaining = remaining;
  if (limit !== undefined) out.limit = limit;
  if (resetAt !== undefined) out.resetAt = resetAt;
  return out;
}

function fraction(d: Dimension): number | undefined {
  return d.remaining !== undefined && d.limit !== undefined && d.limit > 0
    ? d.remaining / d.limit
    : undefined;
}

/**
 * Rate-limit state from response headers: Anthropic `anthropic-ratelimit-*` (RFC 3339 resets)
 * and OpenAI-style `x-ratelimit-*` (duration resets). `undefined` when none are present.
 */
export function limitsFromHeaders(
  headers: Headers,
  now = Date.now(),
): ReportedLimitsInput | undefined {
  const pick = (a: Dimension, b: Dimension): Dimension => (a.remaining !== undefined ? a : b);
  const tokens = pick(
    pick(
      dimension(
        headers,
        [
          'anthropic-ratelimit-tokens-remaining',
          'anthropic-ratelimit-tokens-limit',
          'anthropic-ratelimit-tokens-reset',
        ],
        now,
      ),
      dimension(
        headers,
        [
          'anthropic-ratelimit-input-tokens-remaining',
          'anthropic-ratelimit-input-tokens-limit',
          'anthropic-ratelimit-input-tokens-reset',
        ],
        now,
      ),
    ),
    dimension(
      headers,
      ['x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-reset-tokens'],
      now,
    ),
  );
  const requests = pick(
    dimension(
      headers,
      [
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-reset',
      ],
      now,
    ),
    dimension(
      headers,
      [
        'x-ratelimit-remaining-requests',
        'x-ratelimit-limit-requests',
        'x-ratelimit-reset-requests',
      ],
      now,
    ),
  );
  if (tokens.remaining === undefined && requests.remaining === undefined) return undefined;
  const out: ReportedLimitsInput = {};
  if (tokens.remaining !== undefined) out.tokensRemaining = tokens.remaining;
  if (tokens.limit !== undefined) out.tokensLimit = tokens.limit;
  if (requests.remaining !== undefined) out.requestsRemaining = requests.remaining;
  if (requests.limit !== undefined) out.requestsLimit = requests.limit;
  // The reset that matters is the tighter dimension's.
  const tighter = (fraction(tokens) ?? 1) <= (fraction(requests) ?? 1) ? tokens : requests;
  const resetAt = tighter.resetAt ?? tokens.resetAt ?? requests.resetAt;
  if (resetAt !== undefined) out.resetAt = resetAt;
  if (tokens.remaining === 0 || requests.remaining === 0) out.exhausted = true;
  return out;
}

/** Remaining fraction 0..1 of the tightest reported limit; `undefined` when none is known. */
export function reportedFraction(limits: ReportedLimitsInput): number | undefined {
  if (limits.exhausted) return 0;
  const parts: number[] = [];
  if (limits.tokensRemaining !== undefined && limits.tokensLimit) {
    parts.push(limits.tokensRemaining / limits.tokensLimit);
  }
  if (limits.requestsRemaining !== undefined && limits.requestsLimit) {
    parts.push(limits.requestsRemaining / limits.requestsLimit);
  }
  return parts.length > 0 ? Math.min(1, Math.max(0, Math.min(...parts))) : undefined;
}

export interface ReportedLimitsStoreOptions {
  clock?: Clock;
  /** How long observations without `resetAt` stay valid (default 10 min). */
  ttlMs?: number;
}

/** Latest provider-reported limits per account, in memory, expiring at their reset time. */
export class ReportedLimitsStore {
  private readonly entries = new Map<string, ReportedLimits>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(options: ReportedLimitsStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  report(accountId: string, input: ReportedLimitsInput, source: ReportedLimits['source']): void {
    this.entries.set(accountId, {
      ...input,
      source,
      observedAt: new Date(this.clock()).toISOString(),
    });
  }

  get(accountId: string): ReportedLimits | undefined {
    const entry = this.entries.get(accountId);
    if (!entry) return undefined;
    const now = this.clock();
    const expires = entry.resetAt
      ? Date.parse(entry.resetAt)
      : Date.parse(entry.observedAt) + this.ttlMs;
    if (!(expires > now)) {
      this.entries.delete(accountId);
      return undefined;
    }
    return entry;
  }

  /** True while the provider says the account cannot take more requests. */
  exhausted(accountId: string): boolean {
    const entry = this.get(accountId);
    return entry !== undefined && reportedFraction(entry) === 0;
  }

  forget(accountId: string): void {
    this.entries.delete(accountId);
  }
}
