import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createEngine,
  type DaveEvent,
  type Engine,
  type Goal,
  GoalStore,
  isTerminalGoal,
  loadConfig,
} from '@davecode/core';
import { findGateway, type GatewayClient, GatewayError } from '../client';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { detectProjectRoot, wireProject } from '../runtime';
import { formatDuration } from '../ui/format';
import type { Theme } from '../ui/theme';

export interface GoalOptions {
  maxRounds?: number;
  maxTasks?: number;
  maxTokens?: number;
  dryRun?: boolean;
  project?: string;
}

/** Goal control used by the command: in-process `GoalService` or the gateway's `/api/goals`. */
interface GoalBackend {
  start(input: GoalStartBody): Promise<Goal>;
  cancel(id: string): Promise<Goal>;
  /** Resolves with the finished goal. */
  wait(id: string): Promise<Goal>;
}

interface GoalStartBody {
  objective: string;
  maxRounds?: number;
  maxTasks?: number;
  maxTokens?: number;
  dryRun?: boolean;
}

/** Test seams. */
export interface GoalDeps {
  engine?: Engine;
  /** Resolves when the user asks to stop (default: SIGINT/SIGTERM). */
  interrupt?: () => Promise<void>;
  noGateway?: boolean;
}

async function projectRoot(ctx: CliContext, project?: string): Promise<string> {
  const root = project ? resolve(ctx.cwd, project) : await detectProjectRoot(ctx.cwd, ctx.home);
  if (!root || !existsSync(root)) {
    throw new CliError('Not inside a project', {
      hint: 'Run goal mode inside a repository with a project brain (`git init` and `davecode init`).',
    });
  }
  return root;
}

function interruptSignal(deps: GoalDeps): { promise: Promise<void>; dispose(): void } {
  if (deps.interrupt) return { promise: deps.interrupt(), dispose: () => {} };
  let dispose = () => {};
  const promise = new Promise<void>((done) => {
    const handler = () => {
      dispose();
      done();
    };
    dispose = () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  });
  return { promise, dispose };
}

function explainGoalError(err: unknown): unknown {
  const code =
    err instanceof GatewayError ? err.code : (err as { code?: unknown } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'busy') {
    return new CliError(message, {
      hint: 'Wait for the runner or the other goal to finish, or stop it from the dashboard.',
    });
  }
  if (code === 'goals_unavailable') {
    return new CliError('The running gateway has no project to run goals in', {
      hint: 'Restart `davecode start` inside this repository, or stop it so `davecode goal` runs in-process.',
    });
  }
  return err;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<Goal['tasks'][number]['status'], (t: Theme) => string> = {
  SUCCESS: (t) => t.ok(t.glyph.success),
  FAILED: (t) => t.error(t.glyph.failed),
  IN_PROGRESS: (t) => t.accent(t.glyph.running),
  PENDING: (t) => t.dim(t.glyph.pending),
};

function printEvent(ctx: CliContext, goalId: string, event: DaveEvent): void {
  if (event.type !== 'goal.log' || event.goalId !== goalId || event.level === 'debug') return;
  const theme = ctx.errTheme;
  const time = new Date(event.ts).toTimeString().slice(0, 8);
  const who = event.role ? theme.accent(`[${event.role}]`) : theme.dim('[goal]');
  const message =
    event.level === 'error'
      ? theme.error(event.message)
      : event.level === 'warn'
        ? theme.warn(event.message)
        : event.message;
  ctx.err(`${theme.dim(time)} ${who} ${message}`);
}

export function describeGoal(theme: Theme, goal: Goal): string[] {
  const lines: string[] = [];
  const colour =
    goal.status === 'succeeded' || goal.status === 'planned'
      ? theme.ok
      : goal.status === 'cancelled' || goal.status === 'budget_exhausted'
        ? theme.warn
        : goal.status === 'failed'
          ? theme.error
          : theme.accent;
  lines.push(
    `${theme.bold(goal.id)} ${colour(goal.status)} ${theme.dim(`round ${goal.round}/${goal.limits.maxRounds}`)}`,
  );
  lines.push(`  ${goal.objective}`);
  lines.push(
    theme.dim(
      `  tokens ${goal.limits.tokensUsed.toLocaleString('en-US')} / ${goal.limits.maxTokens.toLocaleString('en-US')} · tasks ${goal.tasks.length} / ${goal.limits.maxTasks}`,
    ),
  );
  if (goal.tasks.length > 0) lines.push('');
  for (const task of goal.tasks) {
    const glyph = STATUS_GLYPH[task.status](theme);
    lines.push(
      `${glyph} ${theme.bold(task.id)} ${theme.dim(`${task.role}·${task.kind}`)} ${task.title}`,
    );
    if (task.artifact) lines.push(theme.dim(`    ${task.artifact}`));
    else if (task.status === 'FAILED' && task.notes) {
      lines.push(theme.dim(`    ${task.notes.split('\n')[0]?.slice(0, 160) ?? ''}`));
    }
  }
  if (goal.summary) lines.push('', goal.summary.trim());
  if (goal.lastError) lines.push('', theme.error(goal.lastError));
  return lines;
}

export function goalExitCode(goal: Goal): number {
  if (goal.status === 'succeeded' || goal.status === 'planned') return EXIT.ok;
  if (goal.status === 'cancelled') return 130;
  return EXIT.failure;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function gatewayBackend(
  client: GatewayClient,
  onEvent: (e: DaveEvent) => void,
): {
  backend: GoalBackend;
  close(): Promise<void>;
} {
  const controller = new AbortController();
  const finished = new Map<string, (goal: Goal) => void>();
  const pump = (async () => {
    try {
      for await (const event of client.events(controller.signal)) {
        onEvent(event);
        if (event.type === 'goal.updated' && isTerminalGoal(event.goal)) {
          finished.get(event.goal.id)?.(event.goal);
        }
      }
    } catch {
      // aborted or disconnected
    }
  })();
  const backend: GoalBackend = {
    start: async (input) => (await client.post<{ goal: Goal }>('/api/goals', input)).goal,
    cancel: async (id) =>
      (
        await client.post<{ goal: Goal }>(`/api/goals/${id}/cancel`, undefined, {
          timeoutMs: 10 * 60_000,
        })
      ).goal,
    wait: (id) =>
      new Promise<Goal>((resolveGoal) => {
        finished.set(id, resolveGoal);
        // The goal may have finished before the listener was registered.
        void client
          .get<{ goal: Goal }>(`/api/goals/${id}`)
          .then(({ goal }) => {
            if (isTerminalGoal(goal)) resolveGoal(goal);
          })
          .catch(() => undefined);
      }),
  };
  return {
    backend,
    close: async () => {
      controller.abort();
      await pump;
    },
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `davecode goal "<objective>"`: plan and run a goal with the agent team, following its log. */
export async function goalCommand(
  ctx: CliContext,
  words: string[],
  opts: GoalOptions,
  deps: GoalDeps = {},
): Promise<number> {
  const objective = words.join(' ').trim();
  if (!objective)
    throw new CliError('Describe the objective', {
      hint: 'davecode goal "Launch a landing page for my app"',
    });
  const root = await projectRoot(ctx, opts.project);
  const input: GoalStartBody = {
    objective,
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  };

  const config =
    deps.engine?.config ?? loadConfig({ home: ctx.home, env: ctx.env, projectRoot: root });
  const gateway = deps.noGateway ? undefined : await findGateway(config).catch(() => undefined);
  let goalId: string | undefined;
  const onEvent = (event: DaveEvent) => {
    if (goalId) printEvent(ctx, goalId, event);
  };

  let engine: Engine | undefined;
  let backend: GoalBackend;
  let close: () => Promise<void>;
  if (gateway) {
    const remote = gatewayBackend(gateway.client, onEvent);
    backend = remote.backend;
    close = remote.close;
    if (!ctx.json) ctx.err(ctx.errTheme.dim(`Using the gateway at ${gateway.client.baseUrl}`));
  } else {
    engine = deps.engine ?? createEngine({ home: ctx.home, env: ctx.env, projectRoot: root });
    const { goals } = wireProject(engine, root, { env: ctx.env });
    const unsubscribe = engine.events.subscribe(onEvent);
    backend = {
      start: (body) => goals.start(body),
      cancel: (id) => goals.cancel(id),
      wait: async (id) => {
        const goal = await goals.wait(id);
        if (!goal) throw new CliError(`Goal ${id} disappeared`);
        return goal;
      },
    };
    const owned = !deps.engine;
    const used = engine;
    close = async () => {
      unsubscribe();
      if (owned) used.close();
    };
  }

  const interrupt = interruptSignal(deps);
  const started = Date.now();
  try {
    let goal: Goal;
    try {
      goal = await backend.start(input);
    } catch (err) {
      throw explainGoalError(err);
    }
    goalId = goal.id;
    if (!ctx.json) {
      ctx.err(
        ctx.errTheme.dim(
          `Goal ${goal.id} started${input.dryRun ? ' (dry run: plan only)' : ''}. Ctrl+C cancels.`,
        ),
      );
    }
    let cancelling = false;
    void interrupt.promise.then(() => {
      cancelling = true;
      if (!ctx.json) ctx.err(ctx.errTheme.dim('Cancelling…'));
      void backend.cancel(goal.id).catch(() => undefined);
    });
    goal = await backend.wait(goal.id);
    if (ctx.json) printJson(ctx, { goal, cancelled: cancelling });
    else {
      ctx.out();
      for (const line of describeGoal(ctx.theme, goal)) ctx.out(line);
      ctx.out(ctx.theme.dim(`  took ${formatDuration((Date.now() - started) / 1000)}`));
      if (goal.tasks.some((t) => t.artifact)) {
        ctx.out(ctx.theme.dim(`  artifacts in ${root}`));
      }
    }
    return goalExitCode(goal);
  } finally {
    interrupt.dispose();
    await close();
  }
}

/** `davecode goals`: goals of this repository, newest first (read from `.davecode/goals`). */
export async function goalsList(ctx: CliContext, opts: { project?: string }): Promise<number> {
  const root = await projectRoot(ctx, opts.project);
  const goals = await new GoalStore(root).list();
  if (ctx.json) {
    printJson(ctx, { goals });
    return EXIT.ok;
  }
  if (goals.length === 0) {
    ctx.out(ctx.theme.dim('No goals yet. Start one with `davecode goal "<objective>"`.'));
    return EXIT.ok;
  }
  for (const goal of goals) {
    const done = goal.tasks.filter((t) => t.status === 'SUCCESS').length;
    ctx.out(
      `${ctx.theme.bold(goal.id)} ${goal.status.padEnd(16)} ${ctx.theme.dim(`${done}/${goal.tasks.length} tasks · ${goal.createdAt.slice(0, 16).replace('T', ' ')}`)}  ${goal.objective.slice(0, 80)}`,
    );
  }
  return EXIT.ok;
}

/** `davecode goals show <id>`. */
export async function goalsShow(
  ctx: CliContext,
  id: string,
  opts: { project?: string },
): Promise<number> {
  const root = await projectRoot(ctx, opts.project);
  const goal = await new GoalStore(root).load(id);
  if (!goal)
    throw new CliError(`Unknown goal "${id}"`, { hint: 'See `davecode goals` for the ids.' });
  if (ctx.json) printJson(ctx, { goal });
  else for (const line of describeGoal(ctx.theme, goal)) ctx.out(line);
  return EXIT.ok;
}

/** `davecode goals cancel <id>`: through the gateway when one runs it, else marks it cancelled. */
export async function goalsCancel(
  ctx: CliContext,
  id: string,
  opts: { project?: string },
  deps: GoalDeps = {},
): Promise<number> {
  const root = await projectRoot(ctx, opts.project);
  const config =
    deps.engine?.config ?? loadConfig({ home: ctx.home, env: ctx.env, projectRoot: root });
  const gateway = deps.noGateway ? undefined : await findGateway(config).catch(() => undefined);
  let goal: Goal;
  if (gateway) {
    goal = (
      await gateway.client.post<{ goal: Goal }>(`/api/goals/${id}/cancel`, undefined, {
        timeoutMs: 10 * 60_000,
      })
    ).goal;
  } else {
    const store = new GoalStore(root);
    const stored = await store.load(id);
    if (!stored)
      throw new CliError(`Unknown goal "${id}"`, { hint: 'See `davecode goals` for the ids.' });
    goal = stored;
    if (!isTerminalGoal(goal)) {
      const stamp = new Date().toISOString();
      goal.status = 'cancelled';
      goal.updatedAt = stamp;
      goal.finishedAt = stamp;
      delete goal.activeTaskId;
      await store.save(goal);
    }
  }
  if (ctx.json) printJson(ctx, { goal });
  else ctx.out(`${ctx.theme.bold(goal.id)} ${goal.status}`);
  return EXIT.ok;
}
