import type { ProviderErrorKind, ProviderKind } from './types';

/** Error kinds that should make the router try the next account/provider. */
const FAILOVER_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'quota_exhausted',
  'unavailable',
  'context_length',
  'timeout',
  'network',
]);

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  status?: number;
  provider?: ProviderKind;
  accountId?: string;
  /** Upstream hint (Retry-After) in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly provider?: ProviderKind;
  readonly accountId?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: ProviderErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.provider = opts.provider;
    this.accountId = opts.accountId;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** True when the request may succeed on a different account or provider. */
  get failover(): boolean {
    return FAILOVER_KINDS.has(this.kind);
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      status: this.status,
      provider: this.provider,
      accountId: this.accountId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** Map an HTTP status code from an upstream provider to an error kind. */
export function errorKindFromStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 413) return 'context_length';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  // 529 is Anthropic's "overloaded".
  if (status === 500 || status === 502 || status === 503 || status === 529) return 'unavailable';
  return 'unknown';
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isFailoverEligible(err: unknown): boolean {
  return err instanceof ProviderError && err.failover;
}
