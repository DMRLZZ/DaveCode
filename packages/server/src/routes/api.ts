import {
  type Account,
  type AccountUpdateInput,
  type Engine,
  type RunnerStatus,
  type TaskGraph,
  VERSION,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';
import type { GatewayOptions, RunnerControl } from '../options';
import {
  accountCreateSchema,
  accountPatchSchema,
  limitQuerySchema,
  runnerStartSchema,
  timeseriesQuerySchema,
} from '../schemas';

const EMPTY_GRAPH: TaskGraph = { version: 1, tasks: [] };
const IDLE: RunnerStatus = { state: 'idle' };

function invalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return sendApiError(reply, 400, 'invalid_body', z.prettifyError(error));
}

/** Dashboard REST API (`/api/*`, except the SSE stream). */
export function registerApiRoutes(
  app: FastifyInstance,
  engine: Engine,
  options: GatewayOptions,
): void {
  const { accounts, events, audit, quota, keyring } = engine;
  const now = () => quota.clock();

  const emitAccount = (account: Account) => events.emit({ type: 'account.updated', account });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: VERSION,
    uptimeSec: Math.max(0, Math.floor((now() - engine.startedAt) / 1000)),
    experimental: { ...engine.config.experimental },
  }));

  // --- accounts --------------------------------------------------------------

  app.get('/api/accounts', async () => ({ accounts: accounts.list() }));

  app.post('/api/accounts', async (request, reply) => {
    const parsed = accountCreateSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { secret, ...input } = parsed.data;
    if (input.provider === 'gemini-web' && !engine.config.experimental.geminiWeb) {
      return sendApiError(
        reply,
        400,
        'experimental_disabled',
        'gemini-web is experimental and may violate Google’s Terms of Service. Set experimental.geminiWeb to true to opt in.',
      );
    }
    const account = engine.db.transaction(() => {
      const created = accounts.create(input);
      if (secret !== undefined) keyring.set(created.id, secret);
      audit.record({
        actor: 'api',
        action: 'account.create',
        target: created.id,
        details: { provider: created.provider, label: created.label, hasSecret: !!secret },
      });
      // Re-read so the response reflects the stored secret (hasSecret).
      return accounts.get(created.id) ?? created;
    })();
    emitAccount(account);
    return reply.code(201).send({ account });
  });

  app.patch<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const parsed = accountPatchSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const existing = accounts.get(request.params.id);
    if (!existing) return sendApiError(reply, 404, 'not_found', 'Account not found');

    const { secret, ...fields } = parsed.data;
    const patch: AccountUpdateInput = { ...fields };
    const enabled = fields.enabled ?? existing.enabled;
    if (!enabled) {
      patch.status = 'disabled';
    } else if (fields.enabled === true || secret !== undefined) {
      // Re-enabling or rotating credentials is a manual reset of error/cooldown state.
      patch.status = 'active';
      patch.cooldownUntil = null;
      patch.lastError = null;
      engine.router.breaker.reset(existing.id);
    }
    const account = engine.db.transaction(() => {
      // Store the secret first so the re-read account reports hasSecret correctly.
      if (secret !== undefined) keyring.set(existing.id, secret);
      const updated = accounts.update(existing.id, patch)!;
      audit.record({
        actor: 'api',
        action: 'account.update',
        target: existing.id,
        details: { fields: Object.keys(fields), secretChanged: secret !== undefined },
      });
      return updated;
    })();
    emitAccount(account);
    return { account };
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params;
    if (!accounts.delete(id)) return sendApiError(reply, 404, 'not_found', 'Account not found');
    for (const cleanup of [() => engine.sandboxes.remove(id), () => engine.chromium.remove(id)]) {
      try {
        cleanup();
      } catch (err) {
        request.log.warn({ err, accountId: id }, 'failed to remove account directory');
      }
    }
    quota.forget(id);
    engine.router.breaker.reset(id);
    audit.record({ actor: 'api', action: 'account.delete', target: id });
    events.emit({ type: 'account.removed', accountId: id });
    return reply.code(204).send();
  });

  // --- usage -----------------------------------------------------------------

  app.get('/api/usage', async () => ({
    usage: accounts.list().map((account) => quota.usage(account)),
  }));

  app.get('/api/usage/timeseries', async (request, reply) => {
    const parsed = timeseriesQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    const { minutes, bucketSec } = parsed.data;
    const until = now() + 1;
    const buckets = engine.usage.timeseries({
      since: until - minutes * 60_000,
      until,
      bucketMs: bucketSec * 1000,
    });
    return { buckets };
  });

  app.get('/api/requests', async (request, reply) => {
    const parsed = limitQuerySchema(100).safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    return { requests: engine.usage.recent(parsed.data.limit) };
  });

  app.get('/api/logs', async (request, reply) => {
    const parsed = limitQuerySchema(200).safeParse(request.query);
    if (!parsed.success) return invalid(reply, parsed.error);
    return { events: events.recent(parsed.data.limit) };
  });

  // --- routes ----------------------------------------------------------------

  app.get('/api/routes', async () => ({
    defaultRoute: engine.config.routing.defaultRoute,
    routes: engine.config.routing.routes,
  }));

  // --- project brain (Phase 3) -------------------------------------------------

  app.get('/api/tasks', async () => {
    const { brain } = options;
    if (!brain) return { project: null, graph: EMPTY_GRAPH };
    return { project: brain.project(), graph: await brain.graph() };
  });

  app.get('/api/brain', async () => {
    const { brain } = options;
    if (!brain) return { state: '', architecture: '' };
    const [state, architecture] = await Promise.all([brain.state(), brain.architecture()]);
    return { state, architecture };
  });

  // --- runner (Phase 4) --------------------------------------------------------

  app.get('/api/runner', async () => ({ status: options.runner?.status() ?? IDLE }));

  const control = (action: keyof Omit<RunnerControl, 'status'>) =>
    async function handler(request: FastifyRequest, reply: FastifyReply) {
      const { runner } = options;
      if (!runner) {
        return sendApiError(
          reply,
          501,
          'runner_unavailable',
          'The autonomous runner is not available',
        );
      }
      let taskId: string | undefined;
      if (action === 'start' && request.body !== undefined && request.body !== null) {
        const parsed = runnerStartSchema.safeParse(request.body);
        if (!parsed.success) return invalid(reply, parsed.error);
        taskId = parsed.data.taskId;
      }
      try {
        if (action === 'start') await runner.start(taskId === undefined ? {} : { taskId });
        else await runner[action]();
      } catch (error) {
        // Runner refusals (RunnerError: dirty_worktree, no_brain, busy…) carry an HTTP status
        // and a machine-readable code; forward both so clients don't have to parse messages.
        const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
        if (typeof statusCode === 'number' && statusCode < 500 && typeof code === 'string') {
          return sendApiError(reply, statusCode, code, (error as Error).message);
        }
        throw error;
      }
      audit.record({
        actor: 'api',
        action: `runner.${action}`,
        ...(taskId !== undefined ? { details: { taskId } } : {}),
      });
      return { status: runner.status() };
    };
  app.post('/api/runner/start', control('start'));
  app.post('/api/runner/pause', control('pause'));
  app.post('/api/runner/stop', control('stop'));
}
