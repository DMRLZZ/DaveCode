import type { DaveEvent, DaveEventType } from './types';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'mock';

export interface StreamStatus {
  state: StreamState;
  /** Consecutive failed attempts since the last successful open. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt while `reconnecting`. */
  retryAt?: number;
  /** Epoch ms of the last received event or heartbeat-backed open. */
  lastEventAt?: number;
}

export interface StreamHandlers {
  onEvent: (event: DaveEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

/** Every `event:` name the gateway emits (named SSE events do not reach `onmessage`). */
export const EVENT_TYPES: readonly DaveEventType[] = [
  'request.started',
  'request.completed',
  'request.failed',
  'router.failover',
  'account.updated',
  'account.removed',
  'quota.updated',
  'task.updated',
  'task.removed',
  'runner.status',
  'runner.log',
  'log',
];

/** Exponential backoff with ±20% jitter: 1s, 2s, 4s … capped at 30s. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.round(base + jitter);
}

export function parseEvent(data: string): DaveEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<DaveEvent>;
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as DaveEvent;
    }
  } catch {
    // Malformed frames are dropped; the stream itself stays up.
  }
  return null;
}

/**
 * Connect to `/api/events` with automatic reconnect. The browser's built-in EventSource retry
 * gives up on HTTP errors (401, 502…), so reconnection is managed here with backoff.
 */
export function connectEventStream(url: string, handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let timer: number | undefined;
  let attempt = 0;
  let closed = false;
  let lastEventAt: number | undefined;

  const report = (status: Omit<StreamStatus, 'attempt' | 'lastEventAt'>) =>
    handlers.onStatus?.({ ...status, attempt, lastEventAt });

  const onFrame = (e: MessageEvent<string>) => {
    const event = parseEvent(e.data);
    if (!event) return;
    lastEventAt = Date.now();
    handlers.onEvent(event);
  };

  const open = () => {
    if (closed) return;
    report({ state: attempt === 0 ? 'connecting' : 'reconnecting' });
    source = new EventSource(url);
    source.onopen = () => {
      attempt = 0;
      lastEventAt = Date.now();
      report({ state: 'open' });
    };
    source.onmessage = onFrame;
    for (const type of EVENT_TYPES) source.addEventListener(type, onFrame as EventListener);
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      attempt += 1;
      const delay = backoffDelay(attempt);
      report({ state: 'reconnecting', retryAt: Date.now() + delay });
      timer = window.setTimeout(open, delay);
    };
  };

  open();

  return () => {
    closed = true;
    window.clearTimeout(timer);
    source?.close();
    source = null;
  };
}
