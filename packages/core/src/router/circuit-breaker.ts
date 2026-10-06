import type { Clock } from '../rate-limiter/window';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default 5). */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open probe is allowed (default 60 s). */
  resetMs?: number;
  clock?: Clock;
}

interface Circuit {
  failures: number;
  openedAt?: number;
  probing: boolean;
}

/**
 * Per-account circuit breaker. After `failureThreshold` consecutive failures the account is
 * skipped for `resetMs`; then a single probe request is let through (half-open). A success
 * closes the circuit, a failure re-opens it.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, Circuit>();
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly clock: Clock;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.resetMs = Math.max(0, options.resetMs ?? 60_000);
    this.clock = options.clock ?? Date.now;
  }

  state(id: string): CircuitState {
    const circuit = this.circuits.get(id);
    if (!circuit || circuit.openedAt === undefined) return 'closed';
    return this.clock() - circuit.openedAt >= this.resetMs ? 'half_open' : 'open';
  }

  /** Whether a request may be sent to the account right now (does not change state). */
  allow(id: string): boolean {
    const state = this.state(id);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    return !this.circuits.get(id)?.probing;
  }

  /** Mark the start of an attempt; claims the probe slot when half-open. */
  onAttempt(id: string): void {
    const circuit = this.circuits.get(id);
    if (circuit && this.state(id) === 'half_open') circuit.probing = true;
  }

  onSuccess(id: string): void {
    this.circuits.delete(id);
  }

  onFailure(id: string): void {
    const circuit = this.circuits.get(id) ?? { failures: 0, probing: false };
    const wasProbing = circuit.probing;
    circuit.failures += 1;
    circuit.probing = false;
    if (wasProbing || circuit.failures >= this.failureThreshold) circuit.openedAt = this.clock();
    this.circuits.set(id, circuit);
  }

  /** Forget an account (e.g. after deletion or manual re-enable). */
  reset(id: string): void {
    this.circuits.delete(id);
  }
}
