import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { DaveEvent, Engine } from '@davecode/core';
import type { FastifyInstance } from 'fastify';

function frame(event: DaveEvent, seq: number): string {
  return `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Resume cursor from the `Last-Event-ID` header (sent by EventSource on reconnect) or query. */
function resumeCursor(headers: Record<string, unknown>, query: unknown): number {
  const fromQuery =
    typeof query === 'object' && query !== null && 'lastEventId' in query
      ? (query as { lastEventId: unknown }).lastEventId
      : undefined;
  const raw = headers['last-event-id'] ?? fromQuery;
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * `GET /api/events`: replays the buffered events after the client's `Last-Event-ID` (all of
 * them on a first connect), then streams live events with an `id:` per event and a `: ping`
 * heartbeat. Subscriptions and timers are released when the client disconnects.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  engine: Engine,
  heartbeatMs: number,
): void {
  const clients = new Set<ServerResponse>();

  // End open streams before the server stops, otherwise close() would wait on them.
  app.addHook('preClose', async () => {
    for (const res of clients) res.end();
    clients.clear();
  });

  app.get('/api/events', (request, reply) => {
    const cursor = resumeCursor(request.headers, request.query);
    reply.hijack();
    const res = reply.raw;
    // Keep headers set by earlier hooks (CORS).
    const inherited: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) inherited[name] = value;
    }
    res.writeHead(200, {
      ...inherited,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);

    for (const { seq, event } of engine.events.since(cursor)) res.write(frame(event, seq));
    const unsubscribe = engine.events.subscribe((event, seq) => {
      res.write(frame(event, seq));
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(res);
    };
    // Not request.raw 'close': Node emits that once the (empty) body is consumed.
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}
