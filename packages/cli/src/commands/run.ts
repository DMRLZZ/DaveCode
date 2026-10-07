import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  type AutonomousRunner,
  blockedTasks,
  createEngine,
  type DaveConfig,
  type DaveEvent,
  type Engine,
  loadConfig,
  nextTask,
  ProjectBrain,
  RunnerError,
  type RunnerErrorCode,
  type RunnerStatus,
  type RunOnceResult,
  type TaskGraph,
  type TaskNode,
} from '@davecode/core';
import { findGateway, type GatewayClient, GatewayError } from '../client';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { detectProjectRoot, wireProject } from '../runtime';
import { logText } from '../tui/RunnerView';
import { initialRunnerState, isTerminal } from '../tui/runner-state';
import { formatDuration } from '../ui/format';

export interface RunOptions {
  once?: boolean;
  task?: string;
  project?: string;
}

/** Test seams: an injected runner/engine instead of building them from the project. */
export interface RunDeps {
  wire?: (
    engine: Engine,
    root: string,
  ) => {
    runner: Pick<
      AutonomousRunner,
      'runOnce' | 'start' | 'stop' | 'pause' | 'resume' | 'status' | 'running'
    >;
  };
  engine?: Engine;
  /** Resolves when the user asks to stop (default: SIGINT/SIGTERM). */
  interrupt?: () => Promise<void>;
  /** Skip the running-gateway probe. */
  noGateway?: boolean;
}

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------

const HINTS: Record<RunnerErrorCode, (config: DaveConfig) => { message?: string; hint: string }> = {
  not_a_repo: () => ({
    message: 'This project is not inside a git repository',
    hint: 'The runner works on task branches: run `git init` and make a first commit.',
  }),
  no_brain: () => ({
    message: 'No project brain here',
    hint: 'Run `davecode init`, then add tasks with `davecode tasks add`.',
  }),
  no_base_branch: (config) => ({
    message: `The base branch "${config.runner.baseBranch}" does not exist`,
    hint: 'Create it, or set runner.baseBranch in .davecode/config.json.',
  }),
  dirty_worktree: () => ({
    hint: 'Commit or stash your changes, then run again (the runner never works on top of uncommitted edits).',
  }),
  invalid_graph: () => ({
    hint: 'Fix .davecode/TASK_GRAPH.json; `davecode tasks` shows the problem.',
  }),
  busy: () => ({
    message: 'The runner is already running',
    hint: 'Stop it from the dashboard or the other `davecode run` first.',
  }),
};

const CODE_PATTERNS: Array<[RunnerErrorCode, RegExp]> = [
  ['not_a_repo', /not inside a git repository/i],
  ['no_brain', /no project brain/i],
  ['no_base_branch', /base branch .* does not exist/i],
  ['dirty_worktree', /uncommitted changes/i],
  ['busy', /already running/i],
  ['invalid_graph', /task graph/i],
];

/** Turn a `RunnerError` (or the gateway's 409 for one) into a CLI error with a fix. */
export function explainRunnerError(err: unknown, config: DaveConfig): unknown {
  const message = err instanceof Error ? err.message : String(err);
  let code: RunnerErrorCode | undefined;
  if (err instanceof RunnerError) code = err.code;
  else if (err instanceof GatewayError && err.status === 409) {
    // The gateway forwards RunnerError codes; fall back to message matching for older gateways.
    code =
      err.code in HINTS
        ? (err.code as RunnerErrorCode)
        : CODE_PATTERNS.find(([, re]) => re.test(message))?.[0];
  }
  if (!code) return err;
  const friendly = HINTS[code](config);
  return new CliError(friendly.message ?? message, { hint: friendly.hint });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Waiter {
  promise: Promise<void>;
  dispose(): void;
}

/** Resolves on SIGINT/SIGTERM; `dispose()` removes the listeners again. */
function signalWaiter(): Waiter {
  let dispose = () => {};
  const promise = new Promise<void>((resolveSignal) => {
    const done = () => {
      dispose();
      resolveSignal();
    };
    dispose = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
  return { promise, dispose };
}

function interruptFor(deps: RunDeps): Waiter {
  return deps.interrupt ? { promise: deps.interrupt(), dispose: () => {} } : signalWaiter();
}

/** `--task <id>` can only confirm the runner's own pick (it always takes the next ready task). */
export function checkRequestedTask(graph: TaskGraph, id: string): void {
  const task = graph.tasks.find((t) => t.id === id);
  if (!task)
    throw new CliError(`Unknown task ${JSON.stringify(id)}`, { hint: 'See `davecode tasks`.' });
  const next = nextTask(graph);
  if (next?.id === id) return;
  const blocked = blockedTasks(graph).find((b) => b.task.id === id);
  const why =
    task.status !== 'PENDING'
      ? `it is ${task.status}`
      : blocked
        ? blocked.reason === 'failed-dependency'
          ? `${blocked.blockedBy.join(', ')} failed`
          : `it waits on ${blocked.blockedBy.join(', ')}`
        : `"${next?.id}" comes first by priority`;
  throw new CliError(`Task ${id} is not next: ${why}`, {
    hint:
      task.status === 'PENDING' && !blocked
        ? `Raise its priority in .davecode/TASK_GRAPH.json, or run without --task to do ${next?.id} first.`
        : 'The runner always takes the next ready task; see `davecode tasks`.',
  });
}

export function describeResult(ctx: CliContext, result: RunOnceResult): string[] {
  const { theme } = ctx;
  const task = result.task ? `${theme.bold(result.task.id)} ${result.task.title}` : '';
  const lines: string[] = [];
  switch (result.outcome) {
    case 'success':
      lines.push(`${theme.ok(theme.glyph.ok)} ${task} ${theme.ok('succeeded')}`);
      if (result.delivery?.mode === 'pr' && result.delivery.url) {
        lines.push(`  pull request ${theme.accent(result.delivery.url)}`);
      } else if (result.delivery) lines.push(theme.dim('  merged into the base branch'));
      break;
    case 'failed':
      lines.push(`${theme.error(theme.glyph.fail)} ${task} ${theme.error('failed')}`);
      if (result.branch) lines.push(theme.dim(`  work kept on ${result.branch}`));
      break;
    case 'idle':
      lines.push(theme.dim('Nothing to do: no task is ready (see `davecode tasks`).'));
      break;
    case 'stopped':
      lines.push(theme.warn(`${theme.glyph.warn} Stopped; the task is back to PENDING.`));
      if (result.branch) lines.push(theme.dim(`  partial work kept on ${result.branch}`));
      break;
    default:
      lines.push(
        `${theme.error(theme.glyph.fail)} Runner error: ${result.error ?? 'unknown error'}`,
      );
  }
  if (result.outcome === 'success' || result.outcome === 'failed') {
    lines.push(theme.dim(`  repair cycles ${result.repairCycles}`));
    if (result.validation && !result.validation.ok) {
      const failing = result.validation.steps.filter((s) => !s.ok).map((s) => s.name);
      if (failing.length > 0) lines.push(theme.dim(`  failing checks: ${failing.join(', ')}`));
    }
    if (result.verdict) {
      lines.push(
        theme.dim(
          `  judge ${result.verdict.pass ? 'passed' : 'rejected'}${result.verdict.confidence !== undefined ? ` (confidence ${result.verdict.confidence.toFixed(2)})` : ''}`,
        ),
      );
    }
    if (result.summary) lines.push('', result.summary.trim());
  }
  return lines;
}

export function exitCodeFor(result: RunOnceResult): number {
  if (result.outcome === 'success' || result.outcome === 'idle') return EXIT.ok;
  if (result.outcome === 'stopped') return 130;
  return EXIT.failure;
}

function printEvent(ctx: CliContext, event: DaveEvent, toStderr: boolean): void {
  const write = toStderr ? ctx.err : ctx.out;
  const theme = toStderr ? ctx.errTheme : ctx.theme;
  if (event.type === 'runner.log' && event.level !== 'debug') {
    write(
      logText(theme, { ts: event.ts, level: event.level, message: event.message }, ctx.columns),
    );
  } else if (event.type === 'runner.status') {
    const s = event.status;
    write(
      theme.dim(
        `${new Date(event.ts).toTimeString().slice(0, 8)} ${theme.glyph.arrow} ${s.state}${s.taskId ? ` · ${s.taskId}` : ''}${s.repairCycle ? ` · repair ${s.repairCycle}` : ''}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runCommand(
  ctx: CliContext,
  opts: RunOptions,
  deps: RunDeps = {},
): Promise<number> {
  const root = opts.project
    ? resolve(ctx.cwd, opts.project)
    : await detectProjectRoot(ctx.cwd, ctx.home);
  if (!root || !existsSync(root)) {
    throw new CliError('Not inside a project', {
      hint: 'Run `davecode run` inside a git repository with a project brain (`davecode init`).',
    });
  }
  const config =
    deps.engine?.config ?? loadConfig({ home: ctx.home, env: ctx.env, projectRoot: root });

  if (opts.task) {
    const brain = new ProjectBrain(root);
    if (!(await brain.isInitialised()))
      throw explainRunnerError(new RunnerError('no_brain', 'no project brain'), config);
    checkRequestedTask(await brain.readGraph(), opts.task);
  }

  // A gateway (davecode start) may already own a runner for this repository.
  const gateway = deps.noGateway ? undefined : await findGateway(config).catch(() => undefined);
  if (gateway) {
    const status = await gateway.client
      .get<{ status: RunnerStatus }>('/api/runner')
      .then((r) => r.status)
      .catch(() => undefined);
    if (status && !['idle', 'stopped', 'error'].includes(status.state)) {
      throw new CliError(`The gateway's runner is already ${status.state}`, {
        hint: `Watch it in the dashboard at ${gateway.client.baseUrl}/ or stop it there first.`,
      });
    }
    if (!opts.once) return driveGateway(ctx, gateway.client, config, root);
  }

  const engine = deps.engine ?? createEngine({ home: ctx.home, env: ctx.env, projectRoot: root });
  try {
    const { runner } = (deps.wire ?? ((e, r) => wireProject(e, r, { env: ctx.env })))(engine, root);
    const graph = await new ProjectBrain(root)
      .readGraph()
      .catch(() => ({ version: 1 as const, tasks: [] }));
    return opts.once
      ? await runOnce(ctx, engine, runner, config, deps)
      : await runContinuous(ctx, engine, runner, config, basename(root), graph.tasks, deps);
  } finally {
    if (!deps.engine) engine.close();
  }
}

type RunnerLike = ReturnType<NonNullable<RunDeps['wire']>>['runner'];

async function runOnce(
  ctx: CliContext,
  engine: Engine,
  runner: RunnerLike,
  config: DaveConfig,
  deps: RunDeps,
): Promise<number> {
  const unsubscribe = engine.events.subscribe((event) => printEvent(ctx, event, ctx.json));
  let interrupted = false;
  const interrupt = interruptFor(deps);
  void interrupt.promise.then(() => {
    interrupted = true;
    if (!ctx.json) ctx.err(ctx.errTheme.dim('Stopping safely…'));
    void runner.stop();
  });
  const started = Date.now();
  let result: RunOnceResult;
  try {
    result = await runner.runOnce();
  } catch (err) {
    throw explainRunnerError(err, config);
  } finally {
    unsubscribe();
    interrupt.dispose();
  }
  if (ctx.json) {
    printJson(ctx, { ...result, interrupted });
  } else {
    ctx.out();
    for (const line of describeResult(ctx, result)) ctx.out(line);
    ctx.out(ctx.theme.dim(`  took ${formatDuration((Date.now() - started) / 1000)}`));
  }
  return exitCodeFor(result);
}

async function runContinuous(
  ctx: CliContext,
  engine: Engine,
  runner: RunnerLike,
  config: DaveConfig,
  projectName: string,
  tasks: TaskNode[],
  deps: RunDeps,
): Promise<number> {
  // Buffer events emitted before the view mounts so the first log lines are not lost.
  const early: DaveEvent[] = [];
  const unsubscribeEarly = engine.events.subscribe((e) => early.push(e));
  try {
    await runner.start();
  } catch (err) {
    unsubscribeEarly();
    throw explainRunnerError(err, config);
  }

  if (!ctx.interactive) {
    unsubscribeEarly();
    for (const event of early) printEvent(ctx, event, false);
    const unsubscribe = engine.events.subscribe((event) => printEvent(ctx, event, false));
    const finished = new Promise<void>((resolveDone) => {
      const timer = setInterval(() => {
        if (!runner.running) {
          clearInterval(timer);
          resolveDone();
        }
      }, 250);
    });
    const interrupt = interruptFor(deps);
    await Promise.race([interrupt.promise, finished]);
    interrupt.dispose();
    if (runner.running) {
      ctx.out(ctx.theme.dim('Stopping safely…'));
      await runner.stop();
    }
    unsubscribe();
  } else {
    const [{ render }, { createElement }, { RunnerApp }] = await Promise.all([
      import('ink'),
      import('react'),
      import('../tui/RunnerView'),
    ]);
    let initial = initialRunnerState(runner.status(), tasks);
    const { runnerReducer } = await import('../tui/runner-state');
    for (const event of early) initial = runnerReducer(initial, event);
    unsubscribeEarly();
    const instance = render(
      createElement(RunnerApp, {
        theme: ctx.theme,
        initial,
        subscribe: (onEvent: (e: DaveEvent) => void) => engine.events.subscribe(onEvent),
        maxRepairCycles: config.runner.maxRepairCycles,
        projectName,
        stop: () => runner.stop(),
        pause: () => runner.pause(),
        resume: () => runner.resume(),
      }),
      { stdout: ctx.io.stdout as NodeJS.WriteStream, exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
    if (runner.running) await runner.stop();
  }
  const final = runner.status();
  if (final.state === 'error') {
    ctx.err(ctx.errTheme.error(`Runner error: ${final.lastError ?? 'unknown error'}`));
    return EXIT.failure;
  }
  return EXIT.ok;
}

/** Continuous mode against the runner of a running gateway, fed by `/api/events`. */
async function driveGateway(
  ctx: CliContext,
  client: GatewayClient,
  config: DaveConfig,
  root: string,
): Promise<number> {
  try {
    await client.post('/api/runner/start');
  } catch (err) {
    if (err instanceof GatewayError && err.status === 501) {
      throw new CliError('The running gateway has no project brain to work on', {
        hint: 'Restart `davecode start` inside this repository, or stop it so `davecode run` can work in-process.',
      });
    }
    throw explainRunnerError(err, config);
  }
  const stop = async () => {
    await client.post('/api/runner/stop', undefined, { timeoutMs: 10 * 60_000 });
  };
  const controller = new AbortController();
  const listeners = new Set<(e: DaveEvent) => void>();
  let latest: RunnerStatus = { state: 'selecting' };
  const pump = (async () => {
    try {
      for await (const event of client.events(controller.signal)) {
        if (event.type === 'runner.status') latest = event.status;
        for (const listener of listeners) listener(event);
      }
    } catch {
      // aborted or disconnected
    }
  })();

  try {
    if (!ctx.interactive) {
      const print = (e: DaveEvent) => printEvent(ctx, e, false);
      listeners.add(print);
      await signalWaiter().promise;
      ctx.out(ctx.theme.dim('Stopping safely…'));
      await stop();
    } else {
      const [{ render }, { createElement }, { RunnerApp }, { tasks }] = await Promise.all([
        import('ink'),
        import('react'),
        import('../tui/RunnerView'),
        client
          .get<{ graph: TaskGraph }>('/api/tasks')
          .then((r) => ({ tasks: r.graph.tasks }))
          .catch(() => ({ tasks: [] as TaskNode[] })),
      ]);
      const status = await client
        .get<{ status: RunnerStatus }>('/api/runner')
        .then((r) => r.status)
        .catch(() => latest);
      const instance = render(
        createElement(RunnerApp, {
          theme: ctx.theme,
          initial: initialRunnerState(status, tasks),
          subscribe: (onEvent: (e: DaveEvent) => void) => {
            listeners.add(onEvent);
            return () => listeners.delete(onEvent);
          },
          maxRepairCycles: config.runner.maxRepairCycles,
          projectName: basename(root),
          stop,
          pause: async () => {
            await client.post('/api/runner/pause');
          },
          resume: async () => {
            await client.post('/api/runner/start');
          },
        }),
        { stdout: ctx.io.stdout as NodeJS.WriteStream, exitOnCtrlC: false },
      );
      await instance.waitUntilExit();
      if (!isTerminal(latest.state)) await stop().catch(() => undefined);
    }
  } finally {
    controller.abort();
    await pump;
  }
  return latest.state === 'error' ? EXIT.failure : EXIT.ok;
}
