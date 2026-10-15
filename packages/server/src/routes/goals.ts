import type { Engine } from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';
import type { GatewayOptions, GoalControl, GoalStartInput } from '../options';
import { goalStartSchema } from '../schemas';

/** Goal mode: `GET/POST /api/goals`, `GET /api/goals/:id`, `POST /api/goals/:id/cancel`. */
export function registerGoalRoutes(
  app: FastifyInstance,
  engine: Engine,
  options: GatewayOptions,
): void {
  const { audit } = engine;

  const unavailable = (reply: FastifyReply) =>
    sendApiError(
      reply,
      501,
      'goals_unavailable',
      'Goal mode is not available; start the gateway inside a project (davecode init)',
    );

  /** Forwards refusals that carry an HTTP status and a code (GoalError: busy, not_found…). */
  const guarded = async <T>(reply: FastifyReply, run: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await run() };
    } catch (error) {
      const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
      if (typeof statusCode === 'number' && statusCode < 500 && typeof code === 'string') {
        return {
          ok: false as const,
          reply: sendApiError(reply, statusCode, code, (error as Error).message),
        };
      }
      throw error;
    }
  };

  const control = (reply: FastifyReply): GoalControl | undefined => {
    if (!options.goals) unavailable(reply);
    return options.goals;
  };

  app.get('/api/goals', async (_request, reply) => {
    const goals = control(reply);
    if (!goals) return reply;
    return { goals: await goals.list() };
  });

  app.get<{ Params: { id: string } }>('/api/goals/:id', async (request, reply) => {
    const goals = control(reply);
    if (!goals) return reply;
    const goal = await goals.get(request.params.id);
    if (!goal) return sendApiError(reply, 404, 'not_found', `unknown goal "${request.params.id}"`);
    return { goal };
  });

  app.post('/api/goals', async (request, reply) => {
    const parsed = goalStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid_body', z.prettifyError(parsed.error));
    }
    const goals = control(reply);
    if (!goals) return reply;
    const input: GoalStartInput = parsed.data;
    const result = await guarded(reply, () => goals.start(input));
    if (!result.ok) return result.reply;
    audit.record({
      actor: 'api',
      action: 'goal.start',
      target: result.value.id,
      details: { dryRun: input.dryRun === true },
    });
    return reply.code(202).send({ goal: result.value });
  });

  app.post<{ Params: { id: string } }>('/api/goals/:id/cancel', async (request, reply) => {
    const goals = control(reply);
    if (!goals) return reply;
    const result = await guarded(reply, () => goals.cancel(request.params.id));
    if (!result.ok) return result.reply;
    audit.record({ actor: 'api', action: 'goal.cancel', target: request.params.id });
    return { goal: result.value };
  });
}
