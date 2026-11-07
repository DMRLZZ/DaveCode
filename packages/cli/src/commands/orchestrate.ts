import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type DaveEvent,
  EventBus,
  ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_LIMITS,
  type OrchestratorAgent,
  type OrchestratorRun,
  type OrchestratorService,
  type OrchestratorTask,
  type StartRunInput,
} from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { createProjectOrchestrator, detectProjectRoot } from '../runtime';
import { formatDuration, truncate } from '../ui/format';
import type { Theme } from '../ui/theme';
import { interruptSignal } from './goal';

/** Flags of `davecode orchestrate`, as commander parses them. */
export interface OrchestrateOptions {
  /** Comma-separated agent ids. */
  agents?: string;
  /** Agent that writes the plan. */
  planner?: string;
  maxTasks?: number;
  apply?: boolean;
  list?: boolean;
  applyRun?: string;
  project?: string;
}

/** Test seams. */
export interface OrchestrateDeps {
  /** Builds the service on the given bus (default: the runtime's construction). */
  service?: (events: EventBus, projectDir: string) => OrchestratorService;
  /** Resolves when the user asks to stop (default: SIGINT/SIGTERM). */
  interrupt?: () => Promise<void>;
}

const AGENT_ALIASES: Record<string, OrchestratorAgent> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  agy: 'agy',
  antigravity: 'agy',
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** `"claude, codex"` → `['claude', 'codex']`: known ids (and aliases), deduplicated, in order. */
export function parseAgents(value: string): OrchestratorAgent[] {
  const agents: OrchestratorAgent[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const agent = AGENT_ALIASES[name];
    if (!agent) {
      throw new CliError(`Unknown agent "${raw.trim()}"`, {
        hint: `Use a comma-separated list of ${ORCHESTRATOR_AGENTS.join(', ')}.`,
      });
    }
    if (!agents.includes(agent)) agents.push(agent);
  }
  if (agents.length === 0) {
    throw new CliError('No agents given', {
      hint: `Use a comma-separated list of ${ORCHESTRATOR_AGENTS.join(', ')}.`,
    });
  }
  return agents;
}

/** `--planner codex` → `'codex'` (aliases accepted, exactly one agent). */
export function parsePlanner(value: string): OrchestratorAgent {
  const agents = parseAgents(value);
  if (agents.length !== 1) throw new CliError('--planner takes exactly one agent');
  return agents[0] as OrchestratorAgent;
}

/** The validated start body for `words` and the flags. */
export function startInput(words: string[], opts: OrchestrateOptions): StartRunInput {
  const objective = words.join(' ').trim();
  if (!objective) {
    throw new CliError('Describe the objective', {
      hint: 'davecode orchestrate "Add a /health endpoint with tests"',
    });
  }
  if (objective.length > ORCHESTRATOR_LIMITS.objectiveMaxLength) {
    throw new CliError(
      `The objective is too long (at most ${ORCHESTRATOR_LIMITS.objectiveMaxLength} characters)`,
    );
  }
  if (
    opts.maxTasks !== undefined &&
    (opts.maxTasks < 1 || opts.maxTasks > ORCHESTRATOR_LIMITS.maxTasks)
  ) {
    throw new CliError(`--max-tasks must be between 1 and ${ORCHESTRATOR_LIMITS.maxTasks}`);
  }
  return {
    objective,
    ...(opts.agents !== undefined ? { agents: parseAgents(opts.agents) } : {}),
    ...(opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {}),
    ...(opts.planner !== undefined ? { planner: parsePlanner(opts.planner) } : {}),
  };
}

export function isRunOver(run: OrchestratorRun): boolean {
  return run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
}

export function runExitCode(run: OrchestratorRun): number {
  return run.status === 'done' ? EXIT.ok : EXIT.failure;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** One display line: no control characters or ANSI from agent output, at most `width` columns. */
export function oneLine(text: string, width = 160): string {
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(flat, width);
}

const TASK_GLYPH: Record<OrchestratorTask['status'], (t: Theme) => string> = {
  pending: (t) => t.dim(t.glyph.pending),
  running: (t) => t.accent(t.glyph.running),
  done: (t) => t.ok(t.glyph.success),
  failed: (t) => t.error(t.glyph.failed),
  conflict: (t) => t.warn(t.glyph.warn),
  cancelled: (t) => t.dim(t.glyph.fail),
  skipped: (t) => t.dim(t.glyph.blocked),
};

const AGENT_WIDTH = Math.max(...ORCHESTRATOR_AGENTS.map((agent) => agent.length));

function agentLabel(theme: Theme, agent: string): string {
  return theme.dim(agent.padEnd(AGENT_WIDTH));
}

function runStatus(theme: Theme, run: OrchestratorRun): string {
  if (run.status === 'done') return theme.ok(run.status);
  if (run.status === 'failed') return theme.error(run.status);
  if (run.status === 'cancelled') return theme.warn(run.status);
  return theme.accent(run.status);
}

function taskOutcome(theme: Theme, task: OrchestratorTask): string {
  const files = task.changedFiles?.length;
  if (task.status === 'done') {
    return files ? theme.dim(`${files} file${files === 1 ? '' : 's'} changed`) : '';
  }
  return task.error ? theme.dim(oneLine(task.error)) : '';
}

function taskLine(theme: Theme, task: OrchestratorTask): string {
  const parts = [
    TASK_GLYPH[task.status](theme),
    theme.bold(task.id),
    agentLabel(theme, task.agent),
    task.status === 'done' ? task.title : `${task.title} ${theme.dim(`(${task.status})`)}`,
  ];
  const outcome = taskOutcome(theme, task);
  return outcome ? `${parts.join(' ')}  ${outcome}` : parts.join(' ');
}

/**
 * Turns the event stream of one run into short progress lines: the plan once, each task
 * starting and finishing, tool calls and errors of the agents. Text replies and status chatter
 * are left for the final summary.
 */
export function createProgress(theme: Theme, runId: string): (event: DaveEvent) => string[] {
  const seen = new Map<string, OrchestratorTask['status']>();
  const agents = new Map<string, string>();
  let planned = false;
  let status: OrchestratorRun['status'] | undefined;

  return (event) => {
    const time = theme.dim(new Date(event.ts).toTimeString().slice(0, 8));
    const lines: string[] = [];
    if (event.type === 'orchestrator.output') {
      if (event.runId !== runId) return lines;
      const { kind, text } = event.output;
      if (kind !== 'tool' && kind !== 'error') return lines;
      const body = oneLine(text);
      if (!body) return lines;
      const who = `${theme.dim(event.taskId)} ${agentLabel(theme, agents.get(event.taskId) ?? '')}`;
      lines.push(`${time}   ${who} ${kind === 'error' ? theme.error(body) : theme.dim(body)}`);
      return lines;
    }
    if (event.type !== 'orchestrator.run' || event.run.id !== runId) return lines;
    const { run } = event;
    if (run.planner) agents.set('plan', run.planner);
    if (run.status !== status) {
      status = run.status;
      if (run.status === 'planning') {
        const by = run.planner ? ` with ${run.planner}` : '';
        lines.push(
          `${time} ${theme.accent(theme.glyph.running)} Planning${by}${theme.glyph.ellipsis}`,
        );
      }
    }
    if (!planned && run.tasks.length > 0) {
      planned = true;
      lines.push(
        `${time} ${theme.bold('Plan')} ${theme.dim(`${run.tasks.length} task${run.tasks.length === 1 ? '' : 's'}`)}`,
      );
      for (const task of run.tasks) {
        const after =
          task.dependsOn.length > 0 ? theme.dim(` after ${task.dependsOn.join(', ')}`) : '';
        lines.push(
          `${time}   ${theme.bold(task.id)} ${agentLabel(theme, task.agent)} ${task.title}${after}`,
        );
      }
    }
    for (const task of run.tasks) {
      agents.set(task.id, task.agent);
      const previous = seen.get(task.id);
      seen.set(task.id, task.status);
      if (previous === task.status || task.status === 'pending') continue;
      if (task.status === 'running') {
        lines.push(
          `${time} ${TASK_GLYPH.running(theme)} ${theme.bold(task.id)} ${agentLabel(theme, task.agent)} started`,
        );
        continue;
      }
      const outcome = taskOutcome(theme, task);
      lines.push(
        `${time} ${TASK_GLYPH[task.status](theme)} ${theme.bold(task.id)} ${agentLabel(theme, task.agent)} ${task.status}${outcome ? `  ${outcome}` : ''}`,
      );
    }
    return lines;
  };
}

/** The finished (or current) state of a run: tasks, outcome and what to do next. */
export function describeRun(theme: Theme, run: OrchestratorRun): string[] {
  const lines: string[] = [];
  const planner = run.planner ? theme.dim(` planned by ${run.planner}`) : '';
  lines.push(`${theme.bold(run.id)} ${runStatus(theme, run)}${planner}`);
  lines.push(`  ${oneLine(run.objective, 200)}`);
  if (run.tasks.length > 0) lines.push('');
  for (const task of run.tasks) {
    lines.push(taskLine(theme, task));
    if (task.status === 'done' && task.summary) {
      lines.push(theme.dim(`    ${oneLine(task.summary)}`));
    }
  }
  if (run.summary) lines.push('', run.summary.trim());
  if (run.error) lines.push('', theme.error(oneLine(run.error, 300)));
  if (run.integrationBranch && run.status === 'done') {
    lines.push('');
    if (run.appliedAt) {
      lines.push(
        theme.dim(`  ${run.integrationBranch} applied to ${run.baseBranch ?? 'the base branch'}`),
      );
    } else {
      lines.push(theme.dim(`  results on ${run.integrationBranch}, nothing changed in your tree`));
      lines.push(theme.dim(`  apply with: davecode orchestrate --apply-run ${run.id}`));
    }
  }
  return lines;
}

/** One line per run for `--list`. */
export function runListLine(theme: Theme, run: OrchestratorRun): string {
  const done = run.tasks.filter((task) => task.status === 'done').length;
  const applied = run.appliedAt ? ' · applied' : '';
  const when = run.createdAt.slice(0, 16).replace('T', ' ');
  return `${theme.bold(run.id)} ${run.status.padEnd(9)} ${theme.dim(`${done}/${run.tasks.length} tasks · ${when}${applied}`)}  ${oneLine(run.objective, 80)}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const HINTS: Record<string, string> = {
  no_agents:
    'Install and sign in to Claude Code (claude), Codex (codex) or Antigravity (agy), or pick others with --agents.',
  not_a_repository: 'Run it inside a git repository with at least one commit.',
  busy: 'Another run is active in this project. Wait for it, or cancel it from the dashboard.',
  not_appliable:
    'Only a finished run that was not applied yet can be applied, and your working tree must be clean.',
  not_found: 'See `davecode orchestrate --list` for the ids.',
};

function explain(err: unknown): unknown {
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  if (name === 'OrchestratorError' && typeof code === 'string' && err instanceof Error) {
    const hint = HINTS[code];
    return new CliError(err.message, hint ? { hint } : {});
  }
  return err;
}

async function projectRoot(ctx: CliContext, project?: string): Promise<string> {
  const root = project ? resolve(ctx.cwd, project) : await detectProjectRoot(ctx.cwd, ctx.home);
  if (!root || !existsSync(root)) {
    throw new CliError('Not inside a git repository', {
      hint: 'Run `davecode orchestrate` inside the repository the agents should work on.',
    });
  }
  return root;
}

async function openService(
  ctx: CliContext,
  opts: OrchestrateOptions,
  deps: OrchestrateDeps,
): Promise<{ service: OrchestratorService; events: EventBus }> {
  const root = await projectRoot(ctx, opts.project);
  const events = new EventBus();
  try {
    const service = deps.service
      ? deps.service(events, root)
      : createProjectOrchestrator({ projectDir: root, home: ctx.home, env: ctx.env, events });
    return { service, events };
  } catch {
    throw new CliError('The pane orchestrator is not available in this build', {
      exitCode: EXIT.unavailable,
    });
  }
}

/** Resolves with the run once it is over (done, failed or cancelled). */
function waitForEnd(
  service: OrchestratorService,
  events: EventBus,
  id: string,
): Promise<OrchestratorRun> {
  return new Promise((resolveRun) => {
    let unsubscribe = () => {};
    const finish = (run: OrchestratorRun) => {
      unsubscribe();
      resolveRun(run);
    };
    unsubscribe = events.subscribe((event) => {
      if (event.type === 'orchestrator.run' && event.run.id === id && isRunOver(event.run)) {
        finish(event.run);
      }
    });
    // It may have ended before the subscription.
    const current = service.get(id);
    if (current && isRunOver(current)) finish(current);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `davecode orchestrate "<objective>"` (and `--list`, `--apply-run <id>`). */
export async function orchestrateCommand(
  ctx: CliContext,
  words: string[],
  opts: OrchestrateOptions,
  deps: OrchestrateDeps = {},
): Promise<number> {
  if (opts.list) return listRuns(ctx, opts, deps);
  if (opts.applyRun !== undefined) return applyRun(ctx, opts.applyRun, opts, deps);

  const input = startInput(words, opts);
  const { service, events } = await openService(ctx, opts, deps);
  const interrupt = interruptSignal(deps);
  const started = Date.now();
  let runId: string | undefined;
  let progress: ((event: DaveEvent) => string[]) | undefined;
  const unsubscribe = events.subscribe((event) => {
    if (ctx.json || !progress) return;
    for (const line of progress(event)) ctx.err(line);
  });
  try {
    let run: OrchestratorRun;
    try {
      run = await service.start(input);
    } catch (err) {
      throw explain(err);
    }
    runId = run.id;
    progress = createProgress(ctx.errTheme, run.id);
    if (!ctx.json) {
      ctx.err(
        ctx.errTheme.dim(`Run ${run.id} started with ${run.agents.join(', ')}. Ctrl+C cancels.`),
      );
      for (const line of progress({ type: 'orchestrator.run', run, ts: Date.now() })) ctx.err(line);
    }
    let cancelled = false;
    void interrupt.promise.then(() => {
      cancelled = true;
      if (!ctx.json) ctx.err(ctx.errTheme.dim(`Cancelling${ctx.errTheme.glyph.ellipsis}`));
      if (runId) service.cancel(runId);
    });
    run = await waitForEnd(service, events, run.id);

    let applyError: CliError | undefined;
    if (opts.apply && run.status === 'done' && !cancelled) {
      try {
        run = await service.apply(run.id);
      } catch (err) {
        const explained = explain(err);
        applyError =
          explained instanceof CliError ? explained : new CliError('Could not apply the run');
      }
    }

    if (ctx.json)
      printJson(ctx, { run, ...(applyError ? { applyError: applyError.message } : {}) });
    else {
      ctx.out();
      for (const line of describeRun(ctx.theme, run)) ctx.out(line);
      ctx.out(ctx.theme.dim(`  took ${formatDuration((Date.now() - started) / 1000)}`));
      if (applyError) {
        ctx.err(`${ctx.errTheme.error('error')}: ${applyError.message}`);
        if (applyError.hint) ctx.err(ctx.errTheme.dim(applyError.hint));
      }
    }
    return applyError ? EXIT.failure : runExitCode(run);
  } finally {
    interrupt.dispose();
    unsubscribe();
    await service.close();
  }
}

async function listRuns(
  ctx: CliContext,
  opts: OrchestrateOptions,
  deps: OrchestrateDeps,
): Promise<number> {
  const { service } = await openService(ctx, opts, deps);
  try {
    const runs = service.list();
    if (ctx.json) printJson(ctx, { runs });
    else if (runs.length === 0) {
      ctx.out(ctx.theme.dim('No runs yet. Start one with `davecode orchestrate "<objective>"`.'));
    } else {
      for (const run of runs) ctx.out(runListLine(ctx.theme, run));
    }
    return EXIT.ok;
  } finally {
    await service.close();
  }
}

async function applyRun(
  ctx: CliContext,
  id: string,
  opts: OrchestrateOptions,
  deps: OrchestrateDeps,
): Promise<number> {
  const { service } = await openService(ctx, opts, deps);
  try {
    let run: OrchestratorRun;
    try {
      run = await service.apply(id);
    } catch (err) {
      throw explain(err);
    }
    if (ctx.json) printJson(ctx, { run });
    else for (const line of describeRun(ctx.theme, run)) ctx.out(line);
    return EXIT.ok;
  } finally {
    await service.close();
  }
}
