import { z } from 'zod';
import type { TaskGraph, TaskNode, TaskStatus } from '../types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TaskGraphIssueCode =
  | 'invalid_json'
  | 'schema'
  | 'duplicate_id'
  | 'unknown_dependency'
  | 'self_dependency'
  | 'cycle'
  | 'unknown_task'
  | 'invalid_transition'
  /** Deleting a task that other tasks still depend on. */
  | 'has_dependents'
  /** Deleting a task the runner is working on. */
  | 'task_in_progress';

export interface TaskGraphIssue {
  code: TaskGraphIssueCode;
  message: string;
  taskId?: string;
  /** For `cycle`: the ids along the cycle, first id repeated at the end. */
  cycle?: string[];
  /** For `has_dependents`: ids of the tasks that depend on `taskId`. */
  dependents?: string[];
}

/** Thrown when a task graph is malformed or an update is not allowed. */
export class TaskGraphError extends Error {
  readonly issues: TaskGraphIssue[];

  constructor(issues: TaskGraphIssue[]) {
    super(
      issues.length === 1
        ? `Invalid task graph: ${issues[0]?.message}`
        : `Invalid task graph (${issues.length} issues):\n${issues
            .map((i) => `  - ${i.message}`)
            .join('\n')}`,
    );
    this.name = 'TaskGraphError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED'] as const;

/** kebab-case or snake_case segments, dots allowed inside (e.g. `release-0.1.0`). */
const TASK_ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, 'must be lowercase kebab-case or snake_case (letters, digits, - _ .)');

export const taskStatusSchema = z.enum(TASK_STATUSES);

export const taskNodeSchema = z.object({
  id: taskIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusSchema,
  dependsOn: z.array(z.string().min(1)).default([]),
  priority: z.number().finite().optional(),
  acceptance: z.array(z.string()).optional(),
  attempts: z.number().int().nonnegative().optional(),
  branch: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const taskGraphSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskNodeSchema),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Follows `dependsOn` edges; returns each distinct cycle as `[a, b, c, a]`. Ignores self-loops. */
export function findCycles(graph: TaskGraph): string[][] {
  const byId = new Map<string, TaskNode>();
  for (const task of graph.tasks) if (!byId.has(task.id)) byId.set(task.id, task);

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    onStack.add(id);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) continue;
      if (onStack.has(dep)) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = canonicalCycleKey(cycle);
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!done.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    onStack.delete(id);
    done.add(id);
  };

  for (const id of byId.keys()) if (!done.has(id)) visit(id);
  return cycles;
}

function canonicalCycleKey(cycle: string[]): string {
  const ring = cycle.slice(0, -1);
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    if ((ring[i] as string) < (ring[start] as string)) start = i;
  }
  return [...ring.slice(start), ...ring.slice(0, start)].join('\u0000');
}

/** Structural checks on an already schema-valid graph. Returns every issue found. */
export function validateTaskGraph(graph: TaskGraph): TaskGraphIssue[] {
  const issues: TaskGraphIssue[] = [];
  const ids = new Set<string>();
  const reportedDuplicates = new Set<string>();

  for (const task of graph.tasks) {
    if (ids.has(task.id) && !reportedDuplicates.has(task.id)) {
      reportedDuplicates.add(task.id);
      issues.push({
        code: 'duplicate_id',
        taskId: task.id,
        message: `duplicate task id "${task.id}"`,
      });
    }
    ids.add(task.id);
  }

  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        issues.push({
          code: 'self_dependency',
          taskId: task.id,
          message: `task "${task.id}" depends on itself`,
        });
      } else if (!ids.has(dep)) {
        issues.push({
          code: 'unknown_dependency',
          taskId: task.id,
          message: `task "${task.id}" depends on unknown task "${dep}"`,
        });
      }
    }
  }

  for (const cycle of findCycles(graph)) {
    issues.push({
      code: 'cycle',
      cycle,
      message: `dependency cycle: ${cycle.join(' → ')}`,
    });
  }
  return issues;
}

/** Validates an arbitrary value (or JSON string) into a `TaskGraph`, or throws `TaskGraphError`. */
export function parseTaskGraph(input: unknown): TaskGraph {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      throw new TaskGraphError([
        {
          code: 'invalid_json',
          message: `not valid JSON (${err instanceof Error ? err.message : String(err)})`,
        },
      ]);
    }
  }

  const parsed = taskGraphSchema.safeParse(value);
  if (!parsed.success) {
    throw new TaskGraphError(
      parsed.error.issues.map((issue) => ({
        code: 'schema' as const,
        message: `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      })),
    );
  }

  const graph: TaskGraph = parsed.data;
  const issues = validateTaskGraph(graph);
  if (issues.length > 0) throw new TaskGraphError(issues);
  return graph;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

function indexById(graph: TaskGraph): Map<string, TaskNode> {
  return new Map(graph.tasks.map((t) => [t.id, t]));
}

/** Tasks ordered so every task appears after its dependencies (file order breaks ties). */
export function topologicalOrder(graph: TaskGraph): TaskNode[] {
  const cycles = findCycles(graph);
  if (cycles.length > 0) {
    throw new TaskGraphError(
      cycles.map((cycle) => ({
        code: 'cycle' as const,
        cycle,
        message: `dependency cycle: ${cycle.join(' → ')}`,
      })),
    );
  }
  const byId = indexById(graph);
  const ordered: TaskNode[] = [];
  const visited = new Set<string>();
  const visit = (task: TaskNode): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const dep of task.dependsOn) {
      const depTask = byId.get(dep);
      if (depTask) visit(depTask);
    }
    ordered.push(task);
  };
  for (const task of graph.tasks) visit(task);
  return ordered;
}

function isUnblocked(task: TaskNode, byId: Map<string, TaskNode>): boolean {
  return task.dependsOn.every((dep) => byId.get(dep)?.status === 'SUCCESS');
}

/** PENDING tasks whose dependencies are all SUCCESS: highest priority first, ties in file order. */
export function readyTasks(graph: TaskGraph): TaskNode[] {
  const byId = indexById(graph);
  return graph.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === 'PENDING' && isUnblocked(task, byId))
    .sort((a, b) => (b.task.priority ?? 0) - (a.task.priority ?? 0) || a.index - b.index)
    .map(({ task }) => task);
}

/** The next task the runner should pick, if any. */
export function nextTask(graph: TaskGraph): TaskNode | undefined {
  return readyTasks(graph)[0];
}

export interface BlockedTask {
  task: TaskNode;
  /** `waiting`: dependencies still pending/in progress. `failed-dependency`: a dependency FAILED. */
  reason: 'waiting' | 'failed-dependency';
  /** Direct dependencies responsible for the block. */
  blockedBy: string[];
}

/** PENDING tasks that cannot start yet, with the reason. */
export function blockedTasks(graph: TaskGraph): BlockedTask[] {
  const byId = indexById(graph);
  const result: BlockedTask[] = [];
  for (const task of graph.tasks) {
    if (task.status !== 'PENDING') continue;
    const failed = task.dependsOn.filter((d) => byId.get(d)?.status === 'FAILED');
    if (failed.length > 0) {
      result.push({ task, reason: 'failed-dependency', blockedBy: failed });
      continue;
    }
    const waiting = task.dependsOn.filter((d) => byId.get(d)?.status !== 'SUCCESS');
    if (waiting.length > 0) result.push({ task, reason: 'waiting', blockedBy: waiting });
  }
  return result;
}

export type RunnableCheck =
  | { ok: true; task: TaskNode }
  | {
      ok: false;
      reason: 'unknown_task' | 'wrong_status' | 'blocked';
      message: string;
      /** For `blocked`: the direct dependencies that are not SUCCESS yet. */
      blockedBy?: string[];
    };

/** Explains whether task `id` could be picked by the runner right now (PENDING and unblocked). */
export function checkRunnable(graph: TaskGraph, id: string): RunnableCheck {
  const byId = indexById(graph);
  const task = byId.get(id);
  if (!task) return { ok: false, reason: 'unknown_task', message: `unknown task "${id}"` };
  if (task.status !== 'PENDING') {
    return {
      ok: false,
      reason: 'wrong_status',
      message: `task "${id}" is ${task.status}; only PENDING tasks can run${
        task.status === 'IN_PROGRESS' ? '' : ' (reopen it first)'
      }`,
    };
  }
  const blockedBy = task.dependsOn.filter((dep) => byId.get(dep)?.status !== 'SUCCESS');
  if (blockedBy.length > 0) {
    return {
      ok: false,
      reason: 'blocked',
      blockedBy,
      message: `task "${id}" is blocked by unfinished dependencies: ${blockedBy
        .map((dep) => `"${dep}" (${byId.get(dep)?.status ?? 'missing'})`)
        .join(', ')}`,
    };
  }
  return { ok: true, task };
}

export interface GraphSummary {
  total: number;
  counts: Record<TaskStatus, number>;
  /** Percentage of SUCCESS tasks, 0..100 with one decimal. */
  progress: number;
}

export function summarize(graph: TaskGraph): GraphSummary {
  const counts: Record<TaskStatus, number> = { PENDING: 0, IN_PROGRESS: 0, SUCCESS: 0, FAILED: 0 };
  for (const task of graph.tasks) counts[task.status] += 1;
  const total = graph.tasks.length;
  const progress = total === 0 ? 0 : Math.round((counts.SUCCESS / total) * 1000) / 10;
  return { total, counts, progress };
}

// ---------------------------------------------------------------------------
// Updates (immutable)
// ---------------------------------------------------------------------------

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUCCESS', 'FAILED', 'PENDING'],
  FAILED: ['PENDING'],
  SUCCESS: ['PENDING'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export type TaskPatch = Partial<Omit<TaskNode, 'id'>>;

/** Optional fields of a task that an edit may remove again. */
export type ClearableTaskField = 'description' | 'priority' | 'acceptance' | 'notes';

export interface UpdateOptions {
  /** Timestamp to stamp into `updatedAt` (defaults to now). */
  now?: Date;
  /** Optional fields to remove from the task (applied after the patch). */
  clear?: readonly ClearableTaskField[];
}

/**
 * Returns a new graph with `patch` applied to task `id`. Status changes must follow the allowed
 * transitions; moving to IN_PROGRESS increments `attempts`. The result is re-validated, so a
 * patch to `dependsOn` cannot introduce unknown ids or cycles.
 */
export function updateTask(
  graph: TaskGraph,
  id: string,
  patch: TaskPatch,
  opts: UpdateOptions = {},
): TaskGraph {
  const index = graph.tasks.findIndex((t) => t.id === id);
  const current = graph.tasks[index];
  if (index < 0 || !current) {
    throw new TaskGraphError([
      { code: 'unknown_task', taskId: id, message: `unknown task "${id}"` },
    ]);
  }

  const next: TaskNode = { ...current, ...definedOnly(patch) };
  if (patch.status !== undefined && patch.status !== current.status) {
    if (!canTransition(current.status, patch.status)) {
      throw new TaskGraphError([
        {
          code: 'invalid_transition',
          taskId: id,
          message: `task "${id}": cannot move ${current.status} → ${patch.status} (allowed from ${current.status}: ${ALLOWED_TRANSITIONS[current.status].join(', ')})`,
        },
      ]);
    }
    if (patch.status === 'IN_PROGRESS') next.attempts = (current.attempts ?? 0) + 1;
  }
  for (const field of opts.clear ?? []) delete next[field];
  next.updatedAt = (opts.now ?? new Date()).toISOString();

  const tasks = graph.tasks.map((t, i) => (i === index ? next : t));
  const updated: TaskGraph = { ...graph, tasks };
  const issues = validateTaskGraph(updated);
  if (issues.length > 0) throw new TaskGraphError(issues);
  return updated;
}

/** What it takes to create a task; it always starts PENDING. */
export interface NewTask {
  id: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  priority?: number;
  acceptance?: string[];
  notes?: string;
}

/** Returns a new graph with a PENDING task appended. Re-validated: duplicates, unknown ids, cycles. */
export function addTask(graph: TaskGraph, input: NewTask, opts: UpdateOptions = {}): TaskGraph {
  const stamp = (opts.now ?? new Date()).toISOString();
  const task: TaskNode = {
    id: input.id,
    title: input.title,
    status: 'PENDING',
    dependsOn: [...(input.dependsOn ?? [])],
    createdAt: stamp,
    updatedAt: stamp,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  const created: TaskGraph = { ...graph, tasks: [...graph.tasks, task] };
  const issues = validateTaskGraph(created);
  if (issues.length > 0) throw new TaskGraphError(issues);
  return created;
}

/** Ids of the tasks that list `id` in their `dependsOn`. */
export function dependentsOf(graph: TaskGraph, id: string): string[] {
  return graph.tasks.filter((t) => t.dependsOn.includes(id)).map((t) => t.id);
}

/**
 * Returns a new graph without task `id`. Refused (`has_dependents`) while other tasks depend on
 * it, and (`task_in_progress`) while the task is IN_PROGRESS.
 */
export function removeTask(graph: TaskGraph, id: string): TaskGraph {
  const task = graph.tasks.find((t) => t.id === id);
  if (!task) {
    throw new TaskGraphError([
      { code: 'unknown_task', taskId: id, message: `unknown task "${id}"` },
    ]);
  }
  const dependents = dependentsOf(graph, id);
  if (dependents.length > 0) {
    throw new TaskGraphError([
      {
        code: 'has_dependents',
        taskId: id,
        dependents,
        message: `cannot delete "${id}": ${dependents.map((d) => `"${d}"`).join(', ')} depend on it`,
      },
    ]);
  }
  if (task.status === 'IN_PROGRESS') {
    throw new TaskGraphError([
      {
        code: 'task_in_progress',
        taskId: id,
        message: `cannot delete "${id}" while it is IN_PROGRESS; reopen it first`,
      },
    ]);
  }
  return { ...graph, tasks: graph.tasks.filter((t) => t.id !== id) };
}

export function setTaskStatus(
  graph: TaskGraph,
  id: string,
  status: TaskStatus,
  opts: UpdateOptions & { notes?: string } = {},
): TaskGraph {
  const patch: TaskPatch = { status };
  if (opts.notes !== undefined) patch.notes = opts.notes;
  return updateTask(graph, id, patch, opts.now ? { now: opts.now } : {});
}

function definedOnly(patch: TaskPatch): TaskPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}
