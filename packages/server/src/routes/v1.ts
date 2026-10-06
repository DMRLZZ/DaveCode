import { Readable } from 'node:stream';
import {
  type ChatCompletionChunk,
  type ChatRequest,
  type Engine,
  newId,
  type RoutingMeta,
  type StreamResult,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { describeRoutingError, sendOpenAIError } from '../errors';
import { chatRequestSchema } from '../schemas';

function setRoutingHeaders(reply: FastifyReply, meta: RoutingMeta): void {
  reply
    .header('x-davecode-request-id', meta.requestId)
    .header('x-davecode-account', meta.accountId)
    .header('x-davecode-provider', meta.provider)
    .header('x-davecode-failovers', String(meta.failovers));
}

function sendRoutingError(reply: FastifyReply, err: unknown): FastifyReply {
  const { status, body } = describeRoutingError(err);
  if (status === 500) reply.log.error({ err }, 'chat completion failed');
  if (err instanceof Error && 'failovers' in err && typeof err.failovers === 'number') {
    reply.header('x-davecode-failovers', String(err.failovers));
  }
  return sendOpenAIError(reply, status, body);
}

/** Frame chunks as SSE, forwarding a mid-stream failure as a final error frame. */
async function* sseFrames(chunks: AsyncIterable<ChatCompletionChunk>): AsyncGenerator<string> {
  try {
    for await (const chunk of chunks) yield `data: ${JSON.stringify(chunk)}\n\n`;
  } catch (err) {
    yield `data: ${JSON.stringify({ error: describeRoutingError(err).body })}\n\n`;
  }
  yield 'data: [DONE]\n\n';
}

/** OpenAI-compatible surface: `GET /v1/models`, `POST /v1/chat/completions`. */
export function registerV1Routes(app: FastifyInstance, engine: Engine): void {
  app.get('/v1/models', async () => ({ object: 'list', data: await engine.router.listModels() }));

  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendOpenAIError(reply, 400, {
        message: z.prettifyError(parsed.error),
        type: 'invalid_request_error',
        code: 'invalid_body',
      });
    }
    const body = parsed.data as ChatRequest;
    const requestId = newId('req');
    reply.header('x-davecode-request-id', requestId);

    // Abort upstream work if the client goes away before we finish.
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    const routeOptions = { requestId, signal: abort.signal };

    if (!body.stream) {
      try {
        const { completion, meta } = await engine.router.complete(body, routeOptions);
        setRoutingHeaders(reply, meta);
        return completion;
      } catch (err) {
        return sendRoutingError(reply, err);
      }
    }

    let result: StreamResult;
    try {
      // Resolves after the first upstream chunk, so failover never leaks partial output.
      result = await engine.router.stream(body, routeOptions);
    } catch (err) {
      return sendRoutingError(reply, err);
    }
    setRoutingHeaders(reply, result.meta);
    reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no');
    return reply.send(Readable.from(sseFrames(result.chunks)));
  });
}
