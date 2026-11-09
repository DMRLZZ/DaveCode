import {
  ChangesError,
  type ChangesErrorCode,
  type ChangesService,
  createWorkspaceSchema,
  type Engine,
  mergeSchema,
  removeSchema,
  shipSchema,
  suggestSchema,
  workspaceIdSchema,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type ZodType, z } from 'zod';
import { sendApiError } from '../errors';

const STATUS: Record<ChangesErrorCode, number> = {
  not_found: 404,
  not_a_repository: 409,
  invalid: 400,
  limit: 409,
  nothing_to_commit: 409,
  dirty: 409,
  conflict: 409,
  unavailable: 409,
};

/** Also matches a `ChangesError` from another copy of core (bundled hosts). */
function changesError(error: unknown): ChangesError | undefined {
  if (error instanceof ChangesError) return error;
  if (!(error instanceof Error) || error.name !== 'ChangesError') return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && Object.hasOwn(STATUS, code)
    ? (error as ChangesError)
    : undefined;
}

type Params = { Params: { id: string } };

/**
 * Changes review: `/api/changes/*`. Registered only when the host gave the gateway a
 * `ChangesService`; every decision is the service's, these routes only translate HTTP.
 */
export function registerChangesRoutes(
  app: FastifyInstance,
  engine: Engine,
  changes?: ChangesService,
): void {
  if (!changes) return;
  const { audit } = engine;

  /** Runs `work`, mapping `ChangesError` refusals to the `/api` envelope. */
  const guarded = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await work() };
    } catch (error) {
      const known = changesError(error);
      if (!known) throw error;
      return {
        ok: false as const,
        reply: sendApiError(reply, STATUS[known.code], known.code, known.message),
      };
    }
  };

  /** Parses `body` (an empty body counts as `{}`), or sends `400 invalid_body`. */
  const body = <T>(schema: ZodType<T>, raw: unknown, reply: FastifyReply) => {
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    sendApiError(reply, 400, 'invalid_body', z.prettifyError(parsed.error));
    return undefined;
  };

  /** The `:id` param, or `404` for anything that is not a workspace id. */
  const workspaceId = (id: string, reply: FastifyReply) => {
    if (workspaceIdSchema.safeParse(id).success) return id;
    sendApiError(reply, 404, 'not_found', `unknown workspace "${id.slice(0, 40)}"`);
    return undefined;
  };

  app.get('/api/changes/workspaces', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await guarded(reply, () => changes.list());
    return result.ok ? { workspaces: result.value } : result.reply;
  });

  app.post('/api/changes/workspaces', async (request, reply) => {
    const input = body(createWorkspaceSchema, request.body, reply);
    if (!input) return reply;
    const result = await guarded(reply, () => changes.create(input));
    if (!result.ok) return result.reply;
    audit.record({ actor: 'api', action: 'changes.create', target: result.value.id });
    return reply.code(201).send(result.value);
  });

  app.get<Params>('/api/changes/workspaces/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = workspaceId(request.params.id, reply);
    if (!id) return reply;
    const result = await guarded(reply, () => changes.get(id));
    return result.ok ? result.value : result.reply;
  });

  app.get<Params & { Querystring: { path?: unknown } }>(
    '/api/changes/workspaces/:id/diff',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const id = workspaceId(request.params.id, reply);
      if (!id) return reply;
      const file = request.query.path;
      if (
        file !== undefined &&
        (typeof file !== 'string' || file.length === 0 || file.length > 4096)
      ) {
        return sendApiError(reply, 400, 'invalid_query', '`path` must be a file path');
      }
      const result = await guarded(reply, () => changes.diff(id, file));
      return result.ok ? result.value : result.reply;
    },
  );

  app.post<Params>('/api/changes/workspaces/:id/suggest', async (request, reply) => {
    const id = workspaceId(request.params.id, reply);
    if (!id) return reply;
    const input = body(suggestSchema, request.body, reply);
    if (!input) return reply;
    const result = await guarded(reply, () => changes.suggest(id, input));
    return result.ok ? result.value : result.reply;
  });

  app.post<Params>('/api/changes/workspaces/:id/ship', async (request, reply) => {
    const id = workspaceId(request.params.id, reply);
    if (!id) return reply;
    const input = body(shipSchema, request.body, reply);
    if (!input) return reply;
    const result = await guarded(reply, () => changes.ship(id, input));
    if (!result.ok) return result.reply;
    audit.record({
      actor: 'api',
      action: 'changes.ship',
      target: id,
      details: {
        ok: result.value.ok,
        steps: result.value.steps.map((s) => `${s.phase}:${s.ok ? 'ok' : 'failed'}`),
      },
    });
    return result.value;
  });

  app.post<Params>('/api/changes/workspaces/:id/merge', async (request, reply) => {
    const id = workspaceId(request.params.id, reply);
    if (!id) return reply;
    const input = body(mergeSchema, request.body, reply);
    if (!input) return reply;
    const result = await guarded(reply, () => changes.merge(id, input));
    if (!result.ok) return result.reply;
    audit.record({ actor: 'api', action: 'changes.merge', target: id });
    return result.value;
  });

  app.delete<Params & { Querystring: { deleteBranch?: string } }>(
    '/api/changes/workspaces/:id',
    async (request, reply) => {
      const id = workspaceId(request.params.id, reply);
      if (!id) return reply;
      const input = removeSchema.parse({ deleteBranch: request.query.deleteBranch === 'true' });
      const result = await guarded(reply, () => changes.remove(id, input));
      if (!result.ok) return result.reply;
      audit.record({ actor: 'api', action: 'changes.remove', target: id, details: input });
      return reply.code(204).send();
    },
  );
}
