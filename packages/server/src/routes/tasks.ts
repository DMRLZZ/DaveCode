import {
  type ClearableTaskField,
  type Engine,
  type NewTask,
  TaskGraphError,
  type TaskGraphIssue,
  type TaskPatch,
} from '@davecode/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';
import type { BrainSource, GatewayOptions } from '../options';
import { taskCreateSchema, taskPatchSchema } from '../schemas';

/** How a task graph issue is reported: HTTP status plus the extra envelope fields. */
function describeIssue(issue: TaskGraphIssue): {
  status: number;
  code: string;
  extra: Record<string, unknown>;
} {
  switch (issue.code) {
    case 'unknown_task':
      return { status: 404, code: 'not_found', extra: {} };
    case 'duplicate_id':
    case 'invalid_transition':
    case 'task_in_progress':
      return { status: 409, code: issue.code, extra: {} };
    case 'has_dependents':
      return { status: 409, code: 'has_dependents', extra: { dependents: issue.dependents ?? [] } };
    case 'cycle':
      return { status: 400, code: 'cycle', extra: { cycle: issue.cycle ?? [] } };
    case 'unknown_dependency':
    case 'self_dependency':
      return { status: 400, code: issue.code, extra: {} };
    default:
      // The stored TASK_GRAPH.json itself is unreadable or invalid.
      return { status: 409, code: 'invalid_graph', extra: {} };
  }
}

function sendGraphError(reply: FastifyReply, error: TaskGraphError): FastifyReply {
  // Report the most specific issue: a cycle beats generic dependency problems.
  const issue = error.issues.find((i) => i.code === 'cycle') ?? error.issues[0];
  if (!issue) return sendApiError(reply, 400, 'invalid_graph', error.message);
  const { status, code, extra } = describeIssue(issue);
  return sendApiError(reply, status, code, issue.message, extra);
}

/** Task graph writes: `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`. */
export function registerTaskRoutes(
  app: FastifyInstance,
  engine: Engine,
  options: GatewayOptions,
): void {
  const { audit } = engine;

  /** The brain, or the error reply to send (no project, or a read-only source). */
  const writable = (reply: FastifyReply): BrainSource | FastifyReply => {
    const { brain } = options;
    if (!brain) {
      return sendApiError(
        reply,
        409,
        'no_brain',
        'No project brain is loaded; start the gateway inside a project (davecode init)',
      );
    }
    return brain;
  };

  const guarded = async <T>(
    reply: FastifyReply,
    run: () => Promise<T>,
  ): Promise<T | FastifyReply> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TaskGraphError) return sendGraphError(reply, error);
      // Brain refusals such as MissingBrainError carry an HTTP status and a machine code.
      const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
      if (typeof statusCode === 'number' && statusCode < 500 && typeof code === 'string') {
        return sendApiError(reply, statusCode, code, (error as Error).message);
      }
      throw error;
    }
  };

  const readOnly = (reply: FastifyReply) =>
    sendApiError(reply, 501, 'brain_read_only', 'The project brain of this gateway is read-only');

  app.post('/api/tasks', async (request, reply) => {
    const parsed = taskCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid_body', z.prettifyError(parsed.error));
    }
    const brain = writable(reply);
    if (isReply(brain)) return brain;
    if (!brain.createTask) return readOnly(reply);
    const input: NewTask = parsed.data;
    const create = brain.createTask.bind(brain);
    const result = await guarded(reply, () => create(input));
    if (isReply(result)) return result;
    audit.record({ actor: 'api', action: 'task.create', target: input.id });
    return reply.code(201).send({ task: result });
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const parsed = taskPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(reply, 400, 'invalid_body', z.prettifyError(parsed.error));
    }
    const brain = writable(reply);
    if (isReply(brain)) return brain;
    if (!brain.updateTask) return readOnly(reply);

    const { description, priority, acceptance, notes, ...rest } = parsed.data;
    const patch: TaskPatch = { ...rest };
    const clear: ClearableTaskField[] = [];
    const optional = { description, priority, acceptance, notes };
    for (const [key, value] of Object.entries(optional) as Array<[ClearableTaskField, unknown]>) {
      if (value === null) clear.push(key);
      else if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }
    const { id } = request.params;
    const update = brain.updateTask.bind(brain);
    const result = await guarded(reply, () => update(id, patch, { clear }));
    if (isReply(result)) return result;
    audit.record({
      actor: 'api',
      action: 'task.update',
      target: id,
      details: { fields: Object.keys(parsed.data) },
    });
    return { task: result };
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const brain = writable(reply);
    if (isReply(brain)) return brain;
    if (!brain.removeTask) return readOnly(reply);
    const { id } = request.params;
    const remove = brain.removeTask.bind(brain);
    const result = await guarded(reply, () => remove(id));
    if (isReply(result)) return result;
    audit.record({ actor: 'api', action: 'task.delete', target: id });
    return reply.code(204).send();
  });
}

function isReply(value: unknown): value is FastifyReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sent' in value &&
    typeof (value as { code?: unknown }).code === 'function'
  );
}
