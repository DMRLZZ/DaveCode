import { rename, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  blockedTasks,
  nextTask,
  ProjectBrain,
  parseTaskGraph,
  summarize,
  TASK_STATUSES,
  TaskGraphError,
  type TaskNode,
  type TaskStatus,
} from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { formatTaskDetail, formatTaskTree, summaryLine } from '../lib/task-tree';
import { detectProjectRoot } from '../runtime';

async function openBrain(ctx: CliContext): Promise<ProjectBrain> {
  const root = await detectProjectRoot(ctx.cwd, ctx.home);
  const brain = root ? new ProjectBrain(root) : undefined;
  if (!brain || !(await brain.isInitialised())) {
    throw new CliError('No project brain here', {
      hint: 'Run `davecode init` in your repository first.',
    });
  }
  return brain;
}

/** Turn graph validation failures into readable CLI errors. */
async function graphErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaskGraphError) {
      throw new CliError(err.issues.map((i) => i.message).join('\n'), {
        hint: 'TASK_GRAPH.json was left unchanged.',
      });
    }
    throw err;
  }
}

export async function tasksList(ctx: CliContext): Promise<number> {
  const brain = await openBrain(ctx);
  const graph = await graphErrors(() => brain.readGraph());
  if (ctx.json) {
    printJson(ctx, {
      root: brain.root,
      summary: summarize(graph),
      next: nextTask(graph)?.id ?? null,
      blocked: blockedTasks(graph).map((b) => ({
        id: b.task.id,
        reason: b.reason,
        blockedBy: b.blockedBy,
      })),
      graph,
    });
    return EXIT.ok;
  }
  const { theme } = ctx;
  ctx.out(`${theme.bold(theme.accent('Tasks'))}  ${theme.dim(basename(brain.root))}`);
  if (graph.tasks.length > 0) ctx.out(summaryLine(theme, graph));
  ctx.out();
  for (const line of formatTaskTree(theme, graph, { width: ctx.columns })) ctx.out(line);
  if (graph.tasks.length === 0) {
    ctx.out(`Add one with ${theme.accent('davecode tasks add <id> "<title>"')}.`);
  }
  return EXIT.ok;
}

export async function tasksNext(ctx: CliContext): Promise<number> {
  const brain = await openBrain(ctx);
  const graph = await graphErrors(() => brain.readGraph());
  const task = nextTask(graph);
  if (ctx.json) {
    printJson(ctx, { next: task ?? null });
    return EXIT.ok;
  }
  if (!task) {
    const blocked = blockedTasks(graph);
    const running = graph.tasks.filter((t) => t.status === 'IN_PROGRESS');
    ctx.out(ctx.theme.dim('Nothing is ready to run.'));
    for (const t of running) ctx.out(`  ${ctx.theme.accent(t.id)} is in progress`);
    for (const b of blocked) {
      ctx.out(
        `  ${b.task.id} ${ctx.theme.dim(
          b.reason === 'failed-dependency'
            ? `blocked: ${b.blockedBy.join(', ')} failed`
            : `waiting on ${b.blockedBy.join(', ')}`,
        )}`,
      );
    }
    return EXIT.ok;
  }
  for (const line of formatTaskDetail(ctx.theme, task)) ctx.out(line);
  return EXIT.ok;
}

export interface AddTaskOptions {
  depends?: string[];
  priority?: number;
  description?: string;
  acceptance?: string[];
}

export async function tasksAdd(
  ctx: CliContext,
  id: string,
  titleWords: string[],
  opts: AddTaskOptions,
): Promise<number> {
  const title = titleWords.join(' ').trim();
  if (!title) throw new CliError('A task needs a title: davecode tasks add <id> <title…>');
  const brain = await openBrain(ctx);
  const now = new Date().toISOString();
  const task: TaskNode = {
    id,
    title,
    status: 'PENDING',
    dependsOn: opts.depends ?? [],
    createdAt: now,
    updatedAt: now,
  };
  if (opts.priority !== undefined) task.priority = opts.priority;
  if (opts.description) task.description = opts.description;
  if (opts.acceptance && opts.acceptance.length > 0) task.acceptance = opts.acceptance;

  await graphErrors(() =>
    // Read-modify-write under the shared .davecode/.lock (the runner and dashboard use it too).
    brain.withLock(async () => {
      const graph = await brain.readGraph();
      if (graph.tasks.some((t) => t.id === id)) {
        throw new CliError(`Task ${JSON.stringify(id)} already exists`, {
          hint: `Change it with: davecode tasks status ${id} <STATUS>`,
        });
      }
      const next = parseTaskGraph({ ...graph, tasks: [...graph.tasks, task] });
      const tmp = `${brain.paths.taskGraph}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(tmp, brain.paths.taskGraph);
    }),
  );

  if (ctx.json) {
    printJson(ctx, { task });
    return EXIT.ok;
  }
  ctx.out(`${ctx.theme.ok(ctx.theme.glyph.ok)} Added ${ctx.theme.bold(id)}  ${title}`);
  if (task.dependsOn.length > 0)
    ctx.out(ctx.theme.dim(`  depends on ${task.dependsOn.join(', ')}`));
  return EXIT.ok;
}

export function parseStatus(value: string): TaskStatus {
  const normalized = value.trim().toUpperCase().replace(/[-\s]/g, '_');
  const aliases: Record<string, TaskStatus> = {
    DONE: 'SUCCESS',
    RUNNING: 'IN_PROGRESS',
    TODO: 'PENDING',
    FAIL: 'FAILED',
  };
  const status = (aliases[normalized] ?? normalized) as TaskStatus;
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new CliError(`Unknown status ${JSON.stringify(value)}`, {
      hint: `Use one of: ${TASK_STATUSES.join(', ')}`,
    });
  }
  return status;
}

export async function tasksStatus(
  ctx: CliContext,
  id: string,
  statusArg: string,
  opts: { notes?: string },
): Promise<number> {
  const status = parseStatus(statusArg);
  const brain = await openBrain(ctx);
  const task = await graphErrors(() =>
    brain.setTaskStatus(id, status, opts.notes !== undefined ? { notes: opts.notes } : {}),
  );
  if (ctx.json) {
    printJson(ctx, { task });
    return EXIT.ok;
  }
  ctx.out(`${ctx.theme.ok(ctx.theme.glyph.ok)} ${ctx.theme.bold(task.id)} is now ${task.status}`);
  return EXIT.ok;
}
