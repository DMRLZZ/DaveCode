import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';

function setup() {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetMs: 1000, clock: () => now });
  return { breaker, advance: (ms: number) => (now += ms) };
}

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures', () => {
    const { breaker } = setup();
    breaker.onFailure('a');
    breaker.onFailure('a');
    expect(breaker.state('a')).toBe('closed');
    expect(breaker.allow('a')).toBe(true);
    breaker.onFailure('a');
    expect(breaker.state('a')).toBe('open');
    expect(breaker.allow('a')).toBe(false);
    expect(breaker.allow('b')).toBe(true);
  });

  it('resets the failure count on success', () => {
    const { breaker } = setup();
    breaker.onFailure('a');
    breaker.onFailure('a');
    breaker.onSuccess('a');
    breaker.onFailure('a');
    expect(breaker.state('a')).toBe('closed');
  });

  it('allows a single half-open probe after the reset period', () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) breaker.onFailure('a');
    advance(999);
    expect(breaker.allow('a')).toBe(false);
    advance(1);
    expect(breaker.state('a')).toBe('half_open');
    expect(breaker.allow('a')).toBe(true);
    breaker.onAttempt('a');
    expect(breaker.allow('a')).toBe(false);
    breaker.onSuccess('a');
    expect(breaker.state('a')).toBe('closed');
  });

  it('re-opens immediately when the probe fails', () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) breaker.onFailure('a');
    advance(1000);
    breaker.onAttempt('a');
    breaker.onFailure('a');
    expect(breaker.state('a')).toBe('open');
    breaker.reset('a');
    expect(breaker.state('a')).toBe('closed');
  });
});
