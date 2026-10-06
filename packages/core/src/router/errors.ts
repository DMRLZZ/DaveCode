import type { ProviderError } from '../errors';

export type RouterErrorCode =
  /** No account can serve the requested model or route. */
  | 'model_not_found'
  /** Matching accounts exist but are disabled, in error, or have no provider adapter. */
  | 'no_available_account'
  /** Every matching account is cooling down, saturated or circuit-broken. */
  | 'no_capacity'
  /** The only matching accounts belong to a disabled experimental provider. */
  | 'experimental_disabled'
  /** Every attempted account was rate limited upstream. */
  | 'rate_limited'
  /** Every attempted account failed upstream. */
  | 'upstream_failed';

const STATUS: Record<RouterErrorCode, number> = {
  model_not_found: 404,
  no_available_account: 503,
  no_capacity: 429,
  experimental_disabled: 400,
  rate_limited: 429,
  upstream_failed: 502,
};

export interface RouterErrorOptions {
  requestId: string;
  failovers?: number;
  lastError?: ProviderError;
}

/** A routing failure that is not a single upstream error (see {@link RouterErrorCode}). */
export class RouterError extends Error {
  readonly code: RouterErrorCode;
  /** Suggested HTTP status for the gateway. */
  readonly status: number;
  readonly requestId: string;
  readonly failovers: number;
  readonly lastError?: ProviderError;

  constructor(code: RouterErrorCode, message: string, options: RouterErrorOptions) {
    super(message, { cause: options.lastError });
    this.name = 'RouterError';
    this.code = code;
    this.status = STATUS[code];
    this.requestId = options.requestId;
    this.failovers = options.failovers ?? 0;
    this.lastError = options.lastError;
  }
}
