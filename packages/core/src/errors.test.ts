import { describe, expect, it } from 'vitest';
import { errorKindFromStatus, isFailoverEligible, ProviderError, parseRetryAfter } from './errors';

describe('errorKindFromStatus', () => {
  it.each([
    [429, 'rate_limit'],
    [401, 'auth'],
    [403, 'auth'],
    [503, 'unavailable'],
    [529, 'unavailable'],
    [504, 'timeout'],
    [413, 'context_length'],
    [400, 'bad_request'],
    [418, 'unknown'],
  ] as const)('maps %i to %s', (status, kind) => {
    expect(errorKindFromStatus(status)).toBe(kind);
  });
});

describe('ProviderError', () => {
  it('fails over on rate limits and outages but not on auth or bad requests', () => {
    expect(new ProviderError('x', { kind: 'rate_limit' }).failover).toBe(true);
    expect(new ProviderError('x', { kind: 'unavailable' }).failover).toBe(true);
    expect(new ProviderError('x', { kind: 'auth' }).failover).toBe(false);
    expect(new ProviderError('x', { kind: 'bad_request' }).failover).toBe(false);
  });

  it('is detected by isFailoverEligible only when it is a ProviderError', () => {
    expect(isFailoverEligible(new ProviderError('x', { kind: 'timeout' }))).toBe(true);
    expect(isFailoverEligible(new Error('plain'))).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
  });

  it('parses HTTP dates relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('returns undefined for missing or garbage values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});
