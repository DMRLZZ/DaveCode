import { errorKindFromStatus, ProviderError, parseRetryAfter } from '../../errors';
import type { ProviderErrorKind, ProviderKind } from '../../types';
import { asString, isRecord } from './util';

export interface ErrorScope {
  provider: ProviderKind;
  accountId: string;
  /** Secret to scrub from any message we surface. */
  secret?: string;
}

const CONTEXT_PATTERNS = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /exceeds the maximum (number of )?tokens/i,
  /input token count.*exceeds/i,
  /too many tokens/i,
];

const QUOTA_PATTERNS = [
  /insufficient[_ ]quota/i,
  /usage limit/i,
  /RESOURCE_EXHAUSTED/,
  /exceeded your current quota/i,
  /credit balance is too low/i,
  /5-hour limit/i,
];

const OVERLOAD_PATTERNS = [/overloaded/i];

const AUTH_PATTERNS = [/api key not valid/i, /API_KEY_INVALID/, /invalid api key/i];

/** Classify an error from message text only; returns undefined when nothing matches. */
export function classifyMessage(text: string): ProviderErrorKind | undefined {
  if (CONTEXT_PATTERNS.some((p) => p.test(text))) return 'context_length';
  if (QUOTA_PATTERNS.some((p) => p.test(text))) return 'quota_exhausted';
  if (OVERLOAD_PATTERNS.some((p) => p.test(text))) return 'unavailable';
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth';
  return undefined;
}

/** Google style `error.details[].retryDelay` ("30s" / "1.5s") from an error body, in ms. */
export function retryDelayFromBody(body: string): number | undefined {
  try {
    const json: unknown = JSON.parse(body);
    const details = isRecord(json) && isRecord(json.error) ? json.error.details : undefined;
    if (!Array.isArray(details)) return undefined;
    for (const d of details) {
      const delay = isRecord(d) ? asString(d.retryDelay) : undefined;
      const match = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
      if (match?.[1]) return Math.round(Number(match[1]) * 1000);
    }
  } catch {
    // not JSON
  }
  return undefined;
}

export function redact(text: string, secret?: string): string {
  if (secret && secret.length >= 4) return text.split(secret).join('[redacted]');
  return text;
}

/** Pull a human message out of the many JSON error envelopes upstreams use. */
export function extractErrorMessage(body: string): { message: string; code?: string } {
  const trimmed = body.trim();
  if (!trimmed) return { message: '' };
  try {
    const json: unknown = JSON.parse(trimmed);
    if (isRecord(json)) {
      const err = json.error;
      if (isRecord(err)) {
        const message = asString(err.message) ?? JSON.stringify(err);
        const code = asString(err.code) ?? asString(err.type) ?? asString(err.status);
        return { message, code };
      }
      if (typeof err === 'string') return { message: err };
      const message = asString(json.message);
      if (message) return { message };
    }
  } catch {
    // not JSON
  }
  return { message: trimmed.slice(0, 500) };
}

const ANTHROPIC_RESET = [
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-reset',
];

/** Derive a retry hint in ms from `retry-after-ms`, `retry-after` or Anthropic reset headers. */
export function retryAfterFromHeaders(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms))) {
    return Math.max(0, Number(ms));
  }
  const standard = parseRetryAfter(headers.get('retry-after'), now);
  if (standard !== undefined) return standard;
  const candidates: Array<{ wait: number; exhausted: boolean }> = [];
  for (const name of ANTHROPIC_RESET) {
    const value = headers.get(name);
    if (!value) continue;
    const at = Date.parse(value);
    if (Number.isNaN(at)) continue;
    const remaining = headers.get(name.replace(/-reset$/, '-remaining'));
    candidates.push({ wait: Math.max(0, at - now), exhausted: remaining === '0' });
  }
  if (candidates.length === 0) return undefined;
  const exhausted = candidates.filter((c) => c.exhausted);
  const pool = exhausted.length > 0 ? exhausted : candidates;
  return Math.max(...pool.map((c) => c.wait));
}

/** Build a ProviderError from an upstream HTTP error response. */
export function errorFromHttp(
  status: number,
  body: string,
  headers: Headers,
  scope: ErrorScope,
): ProviderError {
  const { message, code } = extractErrorMessage(body);
  let kind = errorKindFromStatus(status);
  const byText = classifyMessage(`${code ?? ''} ${message}`);
  if (byText && status < 500) kind = byText;
  if (status >= 500 && kind === 'unknown') kind = 'unavailable';
  const retryAfterMs =
    status === 429 || status === 503 || status === 529
      ? (retryAfterFromHeaders(headers) ?? retryDelayFromBody(body))
      : undefined;
  const text = redact(message || `HTTP ${status}`, scope.secret);
  return new ProviderError(`${scope.provider} upstream error (HTTP ${status}): ${text}`, {
    kind,
    status,
    provider: scope.provider,
    accountId: scope.accountId,
    retryAfterMs,
  });
}

/** Convert any thrown value (fetch failure, abort, parse error) into a ProviderError. */
export function toProviderError(
  err: unknown,
  scope: ErrorScope,
  signal?: AbortSignal,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = isRecord(err) ? asString(err.name) : undefined;
  const aborted = signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError';
  if (aborted) {
    return new ProviderError(`${scope.provider} request aborted or timed out`, {
      kind: 'timeout',
      provider: scope.provider,
      accountId: scope.accountId,
      cause: err,
    });
  }
  const raw = err instanceof Error ? err.message : String(err);
  return new ProviderError(`${scope.provider} network error: ${redact(raw, scope.secret)}`, {
    kind: 'network',
    provider: scope.provider,
    accountId: scope.accountId,
    cause: err,
  });
}
