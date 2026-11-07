import {
  type Engine,
  OrchestratorError,
  type OrchestratorErrorCode,
  type OrchestratorService,
  startRunSchema,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';

const STATUS: Record<OrchestratorErrorCode, number> = {
  not_found: 404,
  no_agents: 409,
  not_a_repository: 409,
  busy: 409,
  not_appliable: 409,
};

/** Also matches an `OrchestratorError` from another copy of core (bundled hosts). */
function orchestratorError(error: unknown): OrchestratorError | undefined {
  if (error instanceof OrchestratorError) return error;
  if (!(error instanceof Error) || error.name !== 'OrchestratorError') return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && Object.hasOwn(STATUS, code)
    ? (error as OrchestratorError)
    : undefined;
}

/**
 * Pane orchestrator: `/api/orchestrator/*`. Registered only when the host gave the gateway an
 * `OrchestratorService`; every decision is the service's, these routes only translate HTTP.
 */
export function registerOrchestratorRoutes(
  app: FastifyInstance,
  engine: Engine,
  orchestrator?: OrchestratorService,
): void {
  if (!orchestrator) return;
  const { audit } = engine;

  /** Maps `OrchestratorError` refusals to the `/api` error envelope; anything else is a 500. */
  const guarded = async <T>(
    reply: FastifyReply,
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reply: FastifyReply }> => {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      const known = orchestratorError(error);
      if (!known) throw error;
      return {
        ok: false,
        reply: sendApiError(reply, STATUS[known.code], known.code, known.message),
      };
    }
  };

  const unknownRun = (reply: FastifyReply, id: string) =>
    sendApiError(reply, 404, 'not_found', `unknown run "${id}"`);

  app.get('/api/orchestrator/agents', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { agents: await orchestrator.agents() };
  });

  app.get('/api/orchestrator/runs', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { runs: orchestrator.list() };
  });

  app.post('/api/orchestrator/runs', async (request, reply) => {
    const parsed = startRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid_body', z.prettifyError(parsed.error));
    }
    const result = await guarded(reply, () => orchestrator.start(parsed.data));
    if (!result.ok) return result.reply;
    audit.record({
      actor: 'api',
      action: 'orchestrator.start',
      target: result.value.id,
      details: { agents: result.value.agents },
    });
    return reply.code(202).send(result.value);
  });

  app.get<{ Params: { id: string } }>('/api/orchestrator/runs/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const run = orchestrator.get(request.params.id);
    if (!run) return unknownRun(reply, request.params.id);
    return run;
  });

  app.post<{ Params: { id: string } }>(
    '/api/orchestrator/runs/:id/cancel',
    async (request, reply) => {
      const { id } = request.params;
      if (orchestrator.cancel(id)) {
        audit.record({ actor: 'api', action: 'orchestrator.cancel', target: id });
        return reply.code(204).send();
      }
      const run = orchestrator.get(id);
      if (!run) return unknownRun(reply, id);
      return sendApiError(reply, 409, 'not_active', `run "${id}" is already ${run.status}`);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/orchestrator/runs/:id/apply',
    async (request, reply) => {
      const { id } = request.params;
      const result = await guarded(reply, () => orchestrator.apply(id));
      if (!result.ok) return result.reply;
      audit.record({ actor: 'api', action: 'orchestrator.apply', target: id });
      return result.value;
    },
  );
}
