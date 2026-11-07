/**
 * Pane orchestrator engine: plans an objective with one agent, runs the subtasks in parallel in
 * their own worktrees (dependencies first), merges each result into the integration branch and
 * lets the user apply it. Talks only to the injected `AgentRunner` and `OrchestratorWorkspace`.
 */
import { randomBytes } from 'node:crypto';
import type { EventBus } from '../events';
import {
  type AgentAvailability,
  type AgentOutput,
  type AgentRunner,
  type AgentRunResult,
  ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_LIMITS,
  type OrchestratorAgent,
  OrchestratorError,
  type OrchestratorRun,
  type OrchestratorService,
  type OrchestratorTask,
  type OrchestratorWorkspace,
  type StartRunInput,
  startRunSchema,
  type TaskWorkspace,
} from './contract';
import {
  buildPlanPrompt,
  buildRepairPrompt,
  buildTaskPrompt,
  type PlanPromptInput,
  parsePlan,
  pickPlanner,
} from './plan';
import { OrchestratorStore } from './store';

export interface OrchestratorServiceOptions {
  /** Absolute project root. */
  projectDir: string;
  /** DaveCode home: runs are kept under `<home>/orchestrator/`. */
  home: string;
  events: EventBus;
  runner: AgentRunner;
  workspace: OrchestratorWorkspace;
  now?: () => Date;
  /** Run id generator (default: 12 random hex characters). */
  newId?: () => string;
}

/** Longest error kept on a run or task. */
const ERROR_MAX_LENGTH = 300;
/** Longest text of one `orchestrator.output` event. */
const OUTPUT_MAX_LENGTH = 2000;
/** Runs kept in memory, as on disk. */
const RUNS_KEPT = 20;

export const INTERRUPTED_ERROR = 'Interrupted: DaveCode closed while this run was active.';

const ACTIVE_STATUSES: ReadonlySet<OrchestratorRun['status']> = new Set(['planning', 'running']);

interface ActiveRun {
  run: OrchestratorRun;
  controller: AbortController;
  done: Promise<void>;
}

/** The run ended with a short, user-facing reason (planning failed…). */
class RunFailure extends Error {}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return clip(message || 'unknown error', ERROR_MAX_LENGTH);
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name: unknown }).name === 'AbortError' ||
      (err as { name: unknown }).name === 'TimeoutError')
  );
}

/** Serializes async work: each call starts after the previous one settled. */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

const isActive = (run: OrchestratorRun) => ACTIVE_STATUSES.has(run.status);

export function createOrchestratorService(
  options: OrchestratorServiceOptions,
): OrchestratorService {
  return new OrchestratorEngine(options);
}

class OrchestratorEngine implements OrchestratorService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly store: OrchestratorStore;
  /** Newest first. */
  private runs: OrchestratorRun[];
  private readonly active = new Map<string, ActiveRun>();
  private readonly applying = new Set<string>();
  /** A `start` that passed the busy check but has not registered its run yet. */
  private starting = false;
  /** Every git mutation goes through here: worktree, commit and merge must not interleave. */
  private readonly git = new Queue();

  constructor(private readonly options: OrchestratorServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomBytes(6).toString('hex'));
    this.store = new OrchestratorStore(options.home, options.projectDir);
    this.runs = this.store.load();
    this.recoverInterrupted();
  }

  // --- Public API ------------------------------------------------------------------------------

  agents(): Promise<AgentAvailability[]> {
    return this.options.runner.availability();
  }

  async start(rawInput: StartRunInput): Promise<OrchestratorRun> {
    const input = startRunSchema.parse(rawInput);
    this.assertIdle();
    this.starting = true;
    try {
      const { workspace, runner } = this.options;
      let head: { branch: string; commit: string };
      try {
        const checked = await workspace.check();
        if (!checked.ok) throw new OrchestratorError('not_a_repository', clip(checked.reason, 300));
        head = { branch: checked.branch, commit: checked.commit };
      } catch (err) {
        if (err instanceof OrchestratorError) throw err;
        throw new OrchestratorError('not_a_repository', errorText(err));
      }

      const availability = await runner.availability();
      const available = new Set(availability.filter((a) => a.available).map((a) => a.agent));
      const wanted = new Set<OrchestratorAgent>(input.agents ?? ORCHESTRATOR_AGENTS);
      const agents = ORCHESTRATOR_AGENTS.filter((a) => wanted.has(a) && available.has(a));
      if (agents.length === 0) {
        throw new OrchestratorError(
          'no_agents',
          input.agents
            ? `None of the selected agents (${input.agents.join(', ')}) is installed.`
            : 'No agent CLI (claude, codex, agy) was found on PATH.',
        );
      }

      if (input.planner && !available.has(input.planner)) {
        throw new OrchestratorError(
          'no_agents',
          `The chosen planner (${input.planner}) is not installed.`,
        );
      }
      const planner = input.planner ?? pickPlanner(agents);

      const id = this.newId();
      let integrationBranch: string;
      try {
        integrationBranch = await this.git.run(() => workspace.createIntegration(id, head.commit));
      } catch (err) {
        throw new OrchestratorError('not_a_repository', errorText(err));
      }

      const stamp = this.stamp();
      const run: OrchestratorRun = {
        id,
        objective: input.objective,
        status: 'planning',
        agents,
        planner,
        baseBranch: head.branch,
        baseCommit: head.commit,
        integrationBranch,
        tasks: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.runs.unshift(run);
      this.trim();
      const active: ActiveRun = {
        run,
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      this.active.set(id, active);
      this.changed(run);
      active.done = this.execute(active, input.maxTasks ?? ORCHESTRATOR_LIMITS.defaultMaxTasks)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(id);
        });
      return structuredClone(run);
    } finally {
      this.starting = false;
    }
  }

  get(id: string): OrchestratorRun | undefined {
    const run = this.find(id);
    return run ? structuredClone(run) : undefined;
  }

  list(): OrchestratorRun[] {
    return this.runs.map((run) => structuredClone(run));
  }

  cancel(id: string): boolean {
    const active = this.active.get(id);
    if (!active || !isActive(active.run)) return false;
    active.controller.abort();
    return true;
  }

  async apply(id: string): Promise<OrchestratorRun> {
    const run = this.find(id);
    if (!run) throw new OrchestratorError('not_found', `No orchestrator run ${id}.`);
    if (run.status !== 'done') {
      throw new OrchestratorError(
        'not_appliable',
        `The run is ${run.status}; only a finished run can be applied.`,
      );
    }
    if (run.appliedAt) throw new OrchestratorError('not_appliable', 'The run was already applied.');
    if (!run.integrationBranch || !run.baseBranch) {
      throw new OrchestratorError('not_appliable', 'The run has no integration branch to apply.');
    }
    if (this.applying.has(id)) {
      throw new OrchestratorError('not_appliable', 'The run is already being applied.');
    }
    const baseBranch = run.baseBranch;
    this.applying.add(id);
    try {
      let result: Awaited<ReturnType<OrchestratorWorkspace['apply']>>;
      try {
        result = await this.git.run(() => this.options.workspace.apply(id, baseBranch));
      } catch (err) {
        result = { ok: false, reason: errorText(err) };
      }
      if (!result.ok) throw new OrchestratorError('not_appliable', clip(result.reason, 300));
      run.appliedAt = this.stamp();
      this.changed(run);
      return structuredClone(run);
    } finally {
      this.applying.delete(id);
    }
  }

  async close(): Promise<void> {
    const pending = [...this.active.values()];
    for (const active of pending) active.controller.abort();
    await Promise.all(pending.map((active) => active.done));
    await this.store.flush();
  }

  // --- Run lifecycle ---------------------------------------------------------------------------

  private async execute(active: ActiveRun, maxTasks: number): Promise<void> {
    const { run, controller } = active;
    try {
      run.tasks = await this.plan(active, maxTasks);
      if (controller.signal.aborted) throw controller.signal.reason;
      run.status = 'running';
      this.changed(run);
      await this.runTasks(active);
      this.finish(run, controller.signal.aborted);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        this.finish(run, true);
      } else {
        for (const task of run.tasks) this.endTask(task, 'cancelled');
        run.status = 'failed';
        run.error = errorText(err);
        run.summary = `The run failed: ${run.error}`;
        this.changed(run);
      }
    } finally {
      try {
        await this.options.workspace.cleanup(run.id);
      } catch {
        // Leftover worktrees are harmless; the branches hold the work.
      }
    }
  }

  private async plan(active: ActiveRun, maxTasks: number): Promise<OrchestratorTask[]> {
    const { run } = active;
    const planner = run.planner!;
    const promptInput: PlanPromptInput = { objective: run.objective, agents: run.agents, maxTasks };
    const ask = async (prompt: string): Promise<AgentRunResult> => {
      const result = await this.options.runner.run({
        agent: planner,
        cwd: this.options.projectDir,
        prompt,
        mode: 'plan',
        signal: active.controller.signal,
        timeoutMs: ORCHESTRATOR_LIMITS.planTimeoutMs,
        onOutput: (chunk) => this.output(run.id, 'plan', chunk),
      });
      if (!result.ok) {
        throw new RunFailure(
          `The planner (${planner}) failed: ${result.error ?? 'no reason given'}`,
        );
      }
      return result;
    };

    this.output(run.id, 'plan', { kind: 'status', text: `Planning with ${planner}…` });
    const first = await ask(buildPlanPrompt(promptInput));
    const parsed = parsePlan(first.text, { agents: run.agents, maxTasks });
    if (parsed.ok) return parsed.tasks;

    this.output(run.id, 'plan', {
      kind: 'status',
      text: `The plan was not usable (${parsed.error}); asking ${planner} to fix it.`,
    });
    const second = await ask(buildRepairPrompt(promptInput, first.text, parsed.error));
    const repaired = parsePlan(second.text, { agents: run.agents, maxTasks });
    if (repaired.ok) return repaired.tasks;
    throw new RunFailure(`The planner did not return a usable plan: ${repaired.error}`);
  }

  private async runTasks(active: ActiveRun): Promise<void> {
    const { run, controller } = active;
    const running = new Map<string, Promise<void>>();
    const busyAgents = new Set<OrchestratorAgent>();

    while (!controller.signal.aborted) {
      this.skipBlocked(run);
      for (const task of run.tasks) {
        if (running.size >= ORCHESTRATOR_LIMITS.maxParallel) break;
        if (task.status !== 'pending' || busyAgents.has(task.agent)) continue;
        if (!task.dependsOn.every((dep) => this.taskById(run, dep)?.status === 'done')) continue;
        busyAgents.add(task.agent);
        const work = this.runTask(active, task).finally(() => {
          running.delete(task.id);
          busyAgents.delete(task.agent);
        });
        running.set(task.id, work);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.all(running.values());

    for (const task of run.tasks) {
      if (task.status !== 'pending') continue;
      if (controller.signal.aborted) this.endTask(task, 'cancelled');
      else this.endTask(task, 'skipped', 'Its dependencies never finished.');
    }
  }

  /** Pending tasks that depend on a task that ended without `done` will never run. */
  private skipBlocked(run: OrchestratorRun): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of run.tasks) {
        if (task.status !== 'pending') continue;
        const blocker = task.dependsOn
          .map((dep) => this.taskById(run, dep))
          .find(
            (dep) =>
              dep && dep.status !== 'done' && dep.status !== 'pending' && dep.status !== 'running',
          );
        if (!blocker) continue;
        this.endTask(
          task,
          'skipped',
          `Depends on ${blocker.id} (${blocker.title}), which ended ${blocker.status}.`,
        );
        this.changed(run);
        changed = true;
      }
    }
  }

  /** Never rejects: every outcome ends up on the task. */
  private async runTask(active: ActiveRun, task: OrchestratorTask): Promise<void> {
    const { run, controller } = active;
    const { workspace, runner } = this.options;
    const signal = controller.signal;
    task.status = 'running';
    task.startedAt = this.stamp();
    this.changed(run);
    try {
      const ws: TaskWorkspace = await this.git.run(() =>
        workspace.createTask(run.id, task.id, run.integrationBranch!),
      );
      task.branch = ws.branch;
      if (signal.aborted) throw signal.reason;
      this.changed(run);

      this.output(run.id, task.id, {
        kind: 'status',
        text: `Starting ${task.agent} on ${ws.branch}`,
      });
      const result = await runner.run({
        agent: task.agent,
        cwd: ws.path,
        prompt: buildTaskPrompt({ objective: run.objective, task, tasks: run.tasks }),
        mode: 'edit',
        signal,
        timeoutMs: ORCHESTRATOR_LIMITS.taskTimeoutMs,
        onOutput: (chunk) => this.output(run.id, task.id, chunk),
      });
      if (signal.aborted) throw signal.reason;
      if (result.text.trim())
        task.summary = clip(result.text, ORCHESTRATOR_LIMITS.summaryMaxLength);
      if (!result.ok) {
        this.endTask(task, 'failed', result.error ?? `${task.agent} did not finish the task.`);
        return;
      }

      const files = await this.git.run(() => workspace.commitTask(ws, `davecode: ${task.title}`));
      task.changedFiles = files;
      if (files.length > 0) {
        const merged = await this.git.run(() =>
          workspace.mergeIntoIntegration(
            run.id,
            ws.branch,
            `davecode: merge ${task.id} ${task.title}`,
          ),
        );
        if (!merged.ok) {
          this.endTask(task, 'conflict', merged.reason);
          return;
        }
      }
      this.endTask(task, 'done');
    } catch (err) {
      if (signal.aborted || isAbortError(err)) this.endTask(task, 'cancelled');
      else this.endTask(task, 'failed', errorText(err));
    } finally {
      this.changed(run);
    }
  }

  /** Final status and deterministic summary. */
  private finish(run: OrchestratorRun, cancelled: boolean): void {
    for (const task of run.tasks) {
      if (task.status === 'pending' || task.status === 'running') this.endTask(task, 'cancelled');
    }
    const total = run.tasks.length;
    const done = run.tasks.filter((t) => t.status === 'done').length;
    const notes = run.tasks.filter((t) => t.status !== 'done').map((t) => describeOutcome(t));
    const where = run.integrationBranch ?? 'the integration branch';

    if (cancelled) {
      run.status = 'cancelled';
      run.summary =
        total === 0
          ? 'Cancelled while planning.'
          : `Cancelled: ${done} of ${total} tasks had finished on ${where}.`;
    } else if (done > 0) {
      run.status = 'done';
      const tail = notes.length > 0 ? ` ${notes.join('; ')}.` : '';
      run.summary = `${done} of ${total} tasks finished on ${where}.${tail} Apply it to merge into ${run.baseBranch ?? 'the base branch'}.`;
    } else {
      run.status = 'failed';
      run.error = 'No task finished.';
      run.summary = `None of the ${total} tasks finished. ${notes.join('; ')}.`;
    }
    this.changed(run);
  }

  private endTask(
    task: OrchestratorTask,
    status: OrchestratorTask['status'],
    error?: string,
  ): void {
    if (task.status !== 'pending' && task.status !== 'running') return;
    task.status = status;
    if (error) task.error = clip(error, ERROR_MAX_LENGTH);
    if (task.startedAt) task.finishedAt = this.stamp();
  }

  // --- Helpers ---------------------------------------------------------------------------------

  private assertIdle(): void {
    const current = [...this.active.values()].find((a) => isActive(a.run));
    if (current || this.starting) {
      throw new OrchestratorError(
        'busy',
        current
          ? `Run ${current.run.id} is still ${current.run.status}; cancel it or wait for it to end.`
          : 'Another run is starting.',
      );
    }
  }

  private recoverInterrupted(): void {
    const interrupted = this.runs.filter(isActive);
    if (interrupted.length === 0) return;
    const stamp = this.stamp();
    for (const run of interrupted) {
      for (const task of run.tasks) {
        if (task.status === 'running') {
          task.status = 'failed';
          task.error = INTERRUPTED_ERROR;
          task.finishedAt = stamp;
        } else if (task.status === 'pending') {
          task.status = 'cancelled';
        }
      }
      run.status = 'failed';
      run.error = INTERRUPTED_ERROR;
      run.updatedAt = stamp;
      const { workspace } = this.options;
      Promise.resolve()
        .then(() => workspace.cleanup(run.id))
        .catch(() => undefined);
    }
    void this.store.save(this.runs);
  }

  private find(id: string): OrchestratorRun | undefined {
    return this.runs.find((run) => run.id === id);
  }

  private taskById(run: OrchestratorRun, id: string): OrchestratorTask | undefined {
    return run.tasks.find((task) => task.id === id);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Keeps the newest runs, never dropping an active one. */
  private trim(): void {
    if (this.runs.length <= RUNS_KEPT) return;
    const keep = new Set(this.runs.slice(0, RUNS_KEPT));
    this.runs = this.runs.filter((run) => keep.has(run) || this.active.has(run.id));
  }

  /** Records a state change: bump `updatedAt`, persist, emit a snapshot. */
  private changed(run: OrchestratorRun): void {
    run.updatedAt = this.stamp();
    void this.store.save(this.runs);
    this.options.events.emit({
      type: 'orchestrator.run',
      run: structuredClone(run),
      ts: this.now().getTime(),
    });
  }

  private output(runId: string, taskId: string, chunk: AgentOutput): void {
    const text =
      chunk.text.length > OUTPUT_MAX_LENGTH ? chunk.text.slice(0, OUTPUT_MAX_LENGTH) : chunk.text;
    if (!text && chunk.kind !== 'error') return;
    this.options.events.emit({
      type: 'orchestrator.output',
      runId,
      taskId,
      output: { kind: chunk.kind, text },
      ts: this.now().getTime(),
    });
  }
}

function describeOutcome(task: OrchestratorTask): string {
  const reason = task.error ? `: ${clip(task.error, 120)}` : '';
  switch (task.status) {
    case 'conflict':
      return `${task.id} conflicts with the integration branch${reason}`;
    case 'failed':
      return `${task.id} failed${reason}`;
    case 'skipped':
      return `${task.id} was skipped${reason}`;
    case 'cancelled':
      return `${task.id} was cancelled`;
    default:
      return `${task.id} is ${task.status}`;
  }
}
