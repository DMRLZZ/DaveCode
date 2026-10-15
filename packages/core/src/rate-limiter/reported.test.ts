import { describe, expect, it } from 'vitest';
import {
  limitsFromHeaders,
  parseDurationMs,
  ReportedLimitsStore,
  reportedFraction,
} from './reported';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('parseDurationMs', () => {
  it('parses OpenAI reset durations', () => {
    expect(parseDurationMs('1s')).toBe(1000);
    expect(parseDurationMs('6m0s')).toBe(360_000);
    expect(parseDurationMs('120ms')).toBe(120);
    expect(parseDurationMs('1h2m3.5s')).toBe(3_723_500);
    expect(parseDurationMs('soon')).toBeUndefined();
  });
});

describe('limitsFromHeaders', () => {
  it('reads Anthropic rate-limit headers', () => {
    const headers = new Headers({
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-limit': '80000',
      'anthropic-ratelimit-tokens-reset': '2026-10-15T12:01:00Z',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-limit': '50',
    });
    expect(limitsFromHeaders(headers, NOW)).toEqual({
      tokensRemaining: 0,
      tokensLimit: 80000,
      requestsRemaining: 49,
      requestsLimit: 50,
      resetAt: '2026-10-15T12:01:00.000Z',
      exhausted: true,
    });
  });

  it('reads OpenAI-style headers with duration resets', () => {
    const headers = new Headers({
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-limit-tokens': '10000',
      'x-ratelimit-reset-tokens': '6s',
      'x-ratelimit-remaining-requests': '10',
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-reset-requests': '1m0s',
    });
    const limits = limitsFromHeaders(headers, NOW);
    expect(limits).toMatchObject({ tokensRemaining: 9000, requestsRemaining: 10 });
    // Requests are the tighter dimension, so their reset is the one reported.
    expect(limits?.resetAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(limits?.exhausted).toBeUndefined();
    expect(reportedFraction(limits!)).toBe(0.1);
  });

  it('returns undefined without rate-limit headers', () => {
    expect(limitsFromHeaders(new Headers({ 'content-type': 'application/json' }))).toBeUndefined();
  });
});

describe('ReportedLimitsStore', () => {
  it('expires entries at their reset, or after the TTL without one', () => {
    let now = NOW;
    const store = new ReportedLimitsStore({ clock: () => now, ttlMs: 1000 });
    store.report('a', { exhausted: true, resetAt: new Date(NOW + 5000).toISOString() }, 'error');
    store.report('b', { tokensRemaining: 5, tokensLimit: 10 }, 'headers');
    expect(store.exhausted('a')).toBe(true);
    expect(store.get('b')).toMatchObject({
      source: 'headers',
      observedAt: new Date(NOW).toISOString(),
    });
    now += 2000;
    expect(store.get('b')).toBeUndefined();
    expect(store.exhausted('a')).toBe(true);
    now += 4000;
    expect(store.exhausted('a')).toBe(false);
  });
});
