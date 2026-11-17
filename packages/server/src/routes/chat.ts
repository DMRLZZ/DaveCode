import {
  ChatError,
  type ChatErrorCode,
  type ChatService,
  createChatSchema,
  type Engine,
  renameChatSchema,
  sendChatSchema,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';

const STATUS: Record<ChatErrorCode, number> = { not_found: 404, busy: 409, no_agent: 409 };

/** Also matches a `ChatError` from another copy of core (bundled hosts). */
function chatError(error: unknown): ChatError | undefined {
  if (error instanceof ChatError) return error;
  if (!(error instanceof Error) || error.name !== 'ChatError') return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && Object.hasOwn(STATUS, code) ? (error as ChatError) : undefined;
}

/**
 * Agent chats: `/api/chat/*`. Registered only when the host gave the gateway a `ChatService`;
 * every decision is the service's, these routes only translate HTTP.
 */
export function registerChatRoutes(app: FastifyInstance, engine: Engine, chat?: ChatService): void {
  if (!chat) return;
  const { audit } = engine;

  const guarded = async <T>(
    reply: FastifyReply,
    work: () => Promise<T> | T,
  ): Promise<{ ok: true; value: T } | { ok: false; reply: FastifyReply }> => {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const known = chatError(error);
      if (!known) throw error;
      return {
        ok: false,
        reply: sendApiError(reply, STATUS[known.code], known.code, known.message),
      };
    }
  };
  const unknown = (reply: FastifyReply, id: string) =>
    sendApiError(reply, 404, 'not_found', `unknown chat "${id}"`);
  const invalid = (reply: FastifyReply, error: z.ZodError) =>
    sendApiError(reply, 400, 'invalid_body', z.prettifyError(error));

  app.get('/api/chat/sessions', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { sessions: chat.list() };
  });

  app.post('/api/chat/sessions', async (request, reply) => {
    const parsed = createChatSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const result = await guarded(reply, () => chat.create(parsed.data));
    if (!result.ok) return result.reply;
    audit.record({
      actor: 'api',
      action: 'chat.create',
      target: result.value.id,
      details: { agent: result.value.agent },
    });
    return reply.code(201).send(result.value);
  });

  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const session = chat.get(request.params.id);
    return session ?? unknown(reply, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/api/chat/sessions/:id', async (request, reply) => {
    const parsed = renameChatSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const session = chat.rename(request.params.id, parsed.data.title);
    return session ?? unknown(reply, request.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/chat/sessions/:id', async (request, reply) => {
    const { id } = request.params;
    const result = await guarded(reply, () => chat.remove(id));
    if (!result.ok) return result.reply;
    if (!result.value) return unknown(reply, id);
    audit.record({ actor: 'api', action: 'chat.remove', target: id });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/api/chat/sessions/:id/messages',
    async (request, reply) => {
      const parsed = sendChatSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error);
      const result = await guarded(reply, () => chat.send(request.params.id, parsed.data));
      if (!result.ok) return result.reply;
      audit.record({
        actor: 'api',
        action: 'chat.send',
        target: request.params.id,
        details: { access: parsed.data.access ?? 'edit' },
      });
      return reply.code(202).send(result.value);
    },
  );

  app.post<{ Params: { id: string } }>('/api/chat/sessions/:id/cancel', async (request, reply) => {
    const { id } = request.params;
    if (chat.cancel(id)) return reply.code(204).send();
    if (!chat.get(id)) return unknown(reply, id);
    return sendApiError(reply, 409, 'not_active', 'the agent is not working on this chat');
  });

  app.get<{ Params: { id: string } }>('/api/chat/sessions/:id/output', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const output = chat.transcript(request.params.id);
    return output ? { output } : unknown(reply, request.params.id);
  });

  app.get<{ Params: { id: string; turn: string } }>(
    '/api/chat/sessions/:id/turns/:turn/patch',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const patch = chat.patch(request.params.id, request.params.turn);
      return patch === undefined ? unknown(reply, request.params.id) : { patch };
    },
  );
}
