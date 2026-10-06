import type {
  Account,
  AccountUsage,
  LogLevel,
  ProviderErrorKind,
  ProviderKind,
  RunnerStatus,
  TaskNode,
} from './types';

/**
 * Real-time events streamed to the dashboard (SSE `/api/events`) and the TUI.
 * Every event carries `ts` in epoch milliseconds. Never put secrets in events.
 */
export type DaveEvent =
  | {
      type: 'request.started';
      requestId: string;
      model: string;
      accountId: string;
      provider: ProviderKind;
      ts: number;
    }
  | {
      type: 'request.completed';
      requestId: string;
      model: string;
      accountId: string;
      provider: ProviderKind;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
      ts: number;
    }
  | {
      type: 'request.failed';
      requestId: string;
      accountId: string;
      provider: ProviderKind;
      error: { kind: ProviderErrorKind; message: string; status?: number };
      ts: number;
    }
  | {
      type: 'router.failover';
      requestId: string;
      fromAccountId: string;
      toAccountId: string | null;
      reason: ProviderErrorKind;
      ts: number;
    }
  | { type: 'account.updated'; account: Account; ts: number }
  | { type: 'account.removed'; accountId: string; ts: number }
  | { type: 'quota.updated'; usage: AccountUsage; ts: number }
  | { type: 'task.updated'; task: TaskNode; ts: number }
  | { type: 'runner.status'; status: RunnerStatus; ts: number }
  | { type: 'runner.log'; level: LogLevel; message: string; taskId?: string; ts: number }
  | { type: 'log'; level: LogLevel; scope: string; message: string; ts: number };

export type DaveEventType = DaveEvent['type'];

/** Distributes an event type over the union so `Omit` keeps each variant intact. */
type WithoutTs<E> = E extends DaveEvent ? Omit<E, 'ts'> & { ts?: number } : never;
export type DaveEventInput = WithoutTs<DaveEvent>;

/** `seq` is a per-process, strictly increasing sequence number (the SSE `id:`). */
export type DaveEventHandler = (event: DaveEvent, seq: number) => void;

export interface SequencedEvent {
  seq: number;
  event: DaveEvent;
}

/**
 * In-process pub/sub with a bounded replay buffer so late subscribers
 * (a freshly opened dashboard tab) can catch up on recent activity.
 */
export class EventBus {
  private readonly handlers = new Set<DaveEventHandler>();
  private readonly buffer: SequencedEvent[] = [];
  private seq = 0;

  constructor(private readonly bufferSize = 500) {}

  emit(input: DaveEventInput): DaveEvent {
    const event = { ...input, ts: input.ts ?? Date.now() } as DaveEvent;
    const seq = ++this.seq;
    this.buffer.push({ seq, event });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const handler of this.handlers) {
      try {
        handler(event, seq);
      } catch {
        // A misbehaving subscriber must never break the emitter.
      }
    }
    return event;
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(handler: DaveEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Most recent events, oldest first. */
  recent(limit = this.bufferSize): DaveEvent[] {
    return this.buffer.slice(-limit).map((entry) => entry.event);
  }

  /** Sequence number of the latest emitted event (0 before the first). */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Buffered events emitted after `afterSeq`, oldest first. A cursor from the future
   * (e.g. a client that saw a previous process) replays the whole buffer.
   */
  since(afterSeq: number): SequencedEvent[] {
    if (afterSeq > this.seq) return [...this.buffer];
    return this.buffer.filter((entry) => entry.seq > afterSeq);
  }
}
