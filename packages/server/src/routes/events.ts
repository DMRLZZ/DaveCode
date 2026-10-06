import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { DaveEvent, Engine } from '@davecode/core';
import type { FastifyInstance } from 'fastify';

function frame(event: DaveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * `GET /api/events`: replays the recent event buffer, then streams live events with a
 * `: ping` heartbeat. Subscriptions and timers are released when the client disconnects.
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

  app.get('/api/events', (_request, reply) => {
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

    for (const event of engine.events.recent()) res.write(frame(event));
    const unsubscribe = engine.events.subscribe((event) => {
      res.write(frame(event));
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
