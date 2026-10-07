/**
 * The autonomous runner: walks the task DAG and, for each ready task, branches, implements,
 * validates, repairs (up to `runner.maxRepairCycles`), judges and merges. State machine as in
 * docs/ARCHITECTURE.md ("Autonomous loop"):
 *
 *   idle → selecting → preparing → implementing → validating → (repairing → implementing)*
 *        → merging → selecting …   plus paused, stopped and error.
 *
 * Structurally satisfies the server's `RunnerControl` (`status`, `start`, `pause`, `stop`).
 */
import { buildTaskContext } from '../brain/context';
import type { GlobalBrain } from '../brain/global';
import { checkRunnable, nextTask } from '../brain/graph';
import type { ProjectBrain } from '../brain/project';
import type { DaveConfig } from '../config/schema';
import { EventBus } from '../events';
import type { LogLevel, RunnerState, RunnerStatus, TaskNode } from '../types';
import { type Executor, ExecutorAbortedError, ExecutorError } from './executor';
import { Git, GitError } from './git';
import { createJudge, type Judge, JudgeError, type JudgeVerdict } from './judge';
import { truncateHead } from './process';
import { type ValidationReport, Validator } from './validator';

export type RunnerConfig = DaveConfig['runner'];

export type RunnerErrorCode =
  | 'not_a_repo'
  | 'no_brain'
  | 'no_base_branch'
  | 'dirty_worktree'
  | 'invalid_graph'
  | 'busy'
  /** `taskId` does not exist in the task graph. */
  | 'task_not_found'
  /** `taskId` exists but is not PENDING. */
  | 'task_not_runnable'
  /** `taskId` is PENDING but depends on unfinished tasks. */
  | 'task_blocked';

/** A precondition failed: the runner refuses to start. */
export class RunnerError extends Error {
  /** HTTP status hint for the gateway's error handler (404 for an unknown task, else 409). */
  readonly statusCode: number;

  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerError';
    this.statusCode = code === 'task_not_found' ? 404 : 409;
  }
}

/** Internal: unwinds the current step when `stop()` is requested. */
class StopSignal extends Error {
  constructor() {
    super('runner stopped');
    this.name = 'StopSignal';
  }
}

export interface AutonomousRunnerOptions {
  /** Brain of the repository to work on; its root must be inside a git work tree. */
  brain: ProjectBrain;
  /** The parsed `runner` config section. */
  config: RunnerConfig;
  executor: Executor;
  /** Global brain injected into every task context. */
  global?: Pick<GlobalBrain, 'compose'>;
  /** Default: `runner.validate` commands with `runner.commandTimeoutMs`. */
  validator?: Pick<Validator, 'validate'>;
  /** Default: `createJudge(runner.judge)` (the `llm` judge needs `createRunner`). */
  judge?: Judge;
  /** Default: `new Git(brain.root)`. */
  git?: Git;
  /** Receives `runner.status` and `runner.log` (default: a private bus, see `events`). */
  events?: EventBus;
  /** Character budget for `buildTaskContext`. */
  contextBudgetChars?: number;
}

/** Options for {@link AutonomousRunner.runOnce} and {@link AutonomousRunner.start}. */
export interface RunTaskOptions {
  /**
   * Run this task instead of the runner's own pick. It must exist, be PENDING and have every
   * dependency SUCCESS, otherwise a {@link RunnerError} (`task_not_found`, `task_not_runnable`
   * or `task_blocked`) is raised.
   */
  taskId?: string;
}

export type RunOutcome = 'success' | 'failed' | 'idle' | 'stopped' | 'error';

export interface RunOnceResult {
  /**
   * `success`: merged (or PR opened). `failed`: task marked FAILED. `idle`: no task was ready.
   * `stopped`: interrupted by `stop()` (task back to PENDING). `error`: unexpected failure.
   */
  outcome: RunOutcome;
  /** The task as last written to the graph. */
  task?: TaskNode;
  /** Repair cycles used. */
  repairCycles: number;
  /** Executor summary of the final pass. */
  summary?: string;
  validation?: ValidationReport;
  verdict?: JudgeVerdict;
  /** How the change landed (`merge` locally or `pr` with its URL). */
  delivery?: { mode: 'merge' | 'pr'; url?: string };
  /** Task branch (kept for inspection when the task failed or was stopped). */
  branch?: string;
  error?: string;
}

const CONVENTIONAL =
  /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\([^)]+\))?!?: /;

/** Conventional Commit message for a finished task. */
export function commitMessage(task: TaskNode, summary: string): string {
  const title = task.title.trim().replace(/\s+/g, ' ');
  let header = CONVENTIONAL.test(title) ? title : `feat: ${title}`;
  if (header.length > 100) header = `${header.slice(0, 97)}...`;
  const body = truncateHead(summary.trim(), 2_000);
  return `${header}\n\n${body ? `${body}\n\n` : ''}DaveCode-Task: ${task.id}`;
}

export class AutonomousRunner {
  readonly events: EventBus;
  readonly root: string;
  private readonly brain: ProjectBrain;
  private readonly config: RunnerConfig;
  private readonly executor: Executor;
  private readonly validator: Pick<Validator, 'validate'>;
  private readonly judge: Judge;
  private readonly git: Git;
  private readonly global: Pick<GlobalBrain, 'compose'> | undefined;
  private readonly contextBudgetChars: number | undefined;

  private current: RunnerStatus = { state: 'idle' };
  /** The running continuous loop or single run, if any. */
  private active: Promise<unknown> | undefined;
  private controller: AbortController | undefined;
  private idleSleep: AbortController | undefined;
  private stopRequested = false;
  private pauseRequested = false;
  private resumeState: RunnerState = 'selecting';
  private pauseWaiters: Array<() => void> = [];
  private last: RunOnceResult | undefined;

  constructor(options: AutonomousRunnerOptions) {
    this.brain = options.brain;
    this.root = options.brain.root;
    this.config = options.config;
    this.executor = options.executor;
    this.events = options.events ?? new EventBus();
    this.git = options.git ?? new Git(this.root);
    this.validator =
      options.validator ??
      new Validator({
        root: this.root,
        commands: options.config.validate,
        timeoutMs: options.config.commandTimeoutMs,
      });
    this.judge = options.judge ?? createJudge(options.config.judge);
    this.global = options.global;
    this.contextBudgetChars = options.contextBudgetChars;
  }

  // -- public control surface -------------------------------------------------

  status(): RunnerStatus {
    return { ...this.current };
  }

  /** Result of the most recent task run. */
  get lastResult(): RunOnceResult | undefined {
    return this.last;
  }

  /** True while the continuous loop or a single run is in progress (including paused). */
  get running(): boolean {
    return this.active !== undefined;
  }

  /**
   * Starts the continuous (24/7) loop, or resumes it when paused. Resolves once the loop has
   * started. Rejects with {@link RunnerError} when a precondition fails (dirty tree, no brain…).
   */
  async start(opts: RunTaskOptions = {}): Promise<void> {
    if (this.pauseRequested) {
      this.resume();
      return;
    }
    if (this.active) return;
    this.stopRequested = false;
    let started: () => void = () => undefined;
    let refused: (err: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      refused = reject;
    });
    this.active = (async () => {
      try {
        await this.preflightChecks();
        if (opts.taskId !== undefined) await this.assertRunnable(opts.taskId);
        this.beginSession();
      } catch (err) {
        refused(err);
        return;
      }
      started();
      await this.loop(opts.taskId);
    })().finally(() => {
      this.active = undefined;
    });
    // Resolve once started; the loop keeps running in the background.
    await ready;
  }

  /**
   * Implements at most one task, then returns. For the CLI (`davecode run`). With `taskId` that
   * exact task is run (or a {@link RunnerError} explains why it cannot be).
   */
  async runOnce(opts: RunTaskOptions = {}): Promise<RunOnceResult> {
    if (this.active) throw new RunnerError('busy', 'the runner is already running');
    this.stopRequested = false;
    let resolveDone: () => void = () => undefined;
    this.active = new Promise<void>((r) => {
      resolveDone = r;
    });
    try {
      await this.preflightChecks();
      if (opts.taskId !== undefined) await this.assertRunnable(opts.taskId);
      this.beginSession();
      const result = await this.selectAndRun(opts.taskId);
      if (result.outcome !== 'error') {
        this.setState(this.stopRequested ? 'stopped' : 'idle', {});
      }
      return result;
    } catch (err) {
      if (err instanceof StopSignal) {
        this.setState('stopped', {});
        return { outcome: 'stopped', repairCycles: 0 };
      }
      if (!(err instanceof RunnerError)) this.fail(err);
      throw err;
    } finally {
      this.endSession();
      this.active = undefined;
      resolveDone();
    }
  }

  /** Pauses at the next step boundary. In-flight work (a model call, a test run) completes. */
  pause(): void {
    if (!this.active || this.pauseRequested) return;
    this.pauseRequested = true;
    this.resumeState = this.current.state === 'paused' ? 'selecting' : this.current.state;
    this.setState('paused', {});
    this.log('info', 'paused; the current step will finish first');
  }

  /** Resumes after {@link pause}. */
  resume(): void {
    if (!this.pauseRequested) return;
    this.pauseRequested = false;
    this.setState(this.resumeState, {});
    this.log('info', 'resumed');
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Stops safely: aborts the in-flight model call or command, keeps partial work on the task
   * branch, puts the task back to PENDING and returns to the base branch. Resolves when done.
   */
  async stop(): Promise<void> {
    if (!this.active) {
      if (this.current.state !== 'stopped') this.setState('stopped', {});
      return;
    }
    this.stopRequested = true;
    this.controller?.abort();
    this.idleSleep?.abort();
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    this.pauseRequested = false;
    for (const wake of waiters) wake();
    try {
      await this.active;
    } catch {
      // errors are reflected in status()
    }
    if (this.current.state !== 'error' && this.current.state !== 'stopped') {
      this.setState('stopped', {});
    }
  }

  // -- loop -------------------------------------------------------------------

  private beginSession(): void {
    this.controller = new AbortController();
    if (this.stopRequested) this.controller.abort();
    this.current = { state: this.current.state, startedAt: new Date().toISOString() };
    this.log('info', `runner started on ${this.root} (executor: ${this.executor.name})`);
  }

  private endSession(): void {
    this.controller = undefined;
    this.idleSleep = undefined;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.pauseWaiters = [];
  }

  private async loop(firstTaskId?: string): Promise<void> {
    let target = firstTaskId;
    try {
      for (;;) {
        const result = await this.selectAndRun(target);
        target = undefined;
        if (result.outcome === 'error' || result.outcome === 'stopped') return;
        if (result.outcome === 'idle') {
          this.log('debug', `no ready task; polling again in ${this.config.idlePollMs} ms`);
          await this.sleep(this.config.idlePollMs);
        }
      }
    } catch (err) {
      if (!(err instanceof StopSignal)) this.fail(err);
    } finally {
      if (this.stopRequested && this.current.state !== 'error') this.setState('stopped', {});
      this.endSession();
    }
  }

  /** Throws a {@link RunnerError} naming why `taskId` cannot be run now. */
  private async assertRunnable(taskId: string): Promise<void> {
    const check = checkRunnable(await this.brain.readGraph(), taskId);
    if (check.ok) return;
    const code: RunnerErrorCode =
      check.reason === 'unknown_task'
        ? 'task_not_found'
        : check.reason === 'blocked'
          ? 'task_blocked'
          : 'task_not_runnable';
    throw new RunnerError(code, check.message);
  }

  private async selectAndRun(taskId?: string): Promise<RunOnceResult> {
    await this.transition('selecting', {});
    const graph = await this.brain.readGraph();
    let task = nextTask(graph);
    if (taskId !== undefined) {
      const check = checkRunnable(graph, taskId);
      if (check.ok) {
        task = check.task;
      } else {
        // Changed between the up-front check and now (e.g. edited from the dashboard).
        this.log('warn', `requested task is no longer runnable: ${check.message}`, taskId);
      }
    }
    if (!task) {
      this.setState('idle', {});
      return { outcome: 'idle', repairCycles: 0 };
    }
    const result = await this.runTask(task);
    this.last = result;
    return result;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.stopRequested) throw new StopSignal();
    const controller = new AbortController();
    this.idleSleep = controller;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    this.idleSleep = undefined;
    if (this.stopRequested) throw new StopSignal();
  }

  // -- preconditions ----------------------------------------------------------

  private async preflightChecks(): Promise<void> {
    try {
      if (!(await this.git.isRepo())) {
        throw new RunnerError('not_a_repo', `${this.root} is not inside a git repository`);
      }
      if (!(await this.brain.isInitialised())) {
        throw new RunnerError('no_brain', `no project brain in ${this.root} (run davecode init)`);
      }
      const base = this.config.baseBranch;
      if (!(await this.git.branchExists(base))) {
        throw new RunnerError('no_base_branch', `base branch "${base}" does not exist`);
      }
      const dirty = await this.git.status({ ignoreBrain: true });
      if (dirty.length > 0) {
        const files = dirty.slice(0, 10).map((l) => l.slice(3));
        throw new RunnerError(
          'dirty_worktree',
          `refusing to start: the working tree has uncommitted changes (${files.join(', ')}${dirty.length > 10 ? ', …' : ''}). Commit or stash them first.`,
        );
      }
      let graph: Awaited<ReturnType<ProjectBrain['readGraph']>>;
      try {
        graph = await this.brain.readGraph();
      } catch (err) {
        throw new RunnerError('invalid_graph', err instanceof Error ? err.message : String(err));
      }
      for (const stale of graph.tasks.filter((t) => t.status === 'IN_PROGRESS')) {
        this.log(
          'warn',
          `task ${stale.id} is IN_PROGRESS from an earlier run; set it back to PENDING to retry it`,
          stale.id,
        );
      }
      if ((await this.git.currentBranch()) !== base) {
        this.log('info', `checking out base branch ${base}`);
        await this.git.checkout(base);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState('error', { lastError: message });
      this.log('error', message);
      throw err;
    }
  }

  // -- one task ---------------------------------------------------------------

  private async runTask(selected: TaskNode): Promise<RunOnceResult> {
    const cfg = this.config;
    const id = selected.id;
    const branch = `${cfg.branchPrefix}${id}`;
    const signal = this.controller?.signal ?? new AbortController().signal;
    let task = await this.brain.updateTask(id, { status: 'IN_PROGRESS', branch });
    await this.brain.appendStateLog(
      `Started task \`${id}\` (${task.title}), attempt ${task.attempts ?? 1}, on \`${branch}\`.`,
    );
    this.log('info', `task ${id}: ${task.title} (attempt ${task.attempts ?? 1})`, id);

    let cycle = 0;
    let summary = '';
    let validation: ValidationReport | undefined;
    let verdict: JudgeVerdict | undefined;
    const partial = (): Omit<RunOnceResult, 'outcome'> => ({
      task,
      repairCycles: cycle,
      branch,
      ...(summary ? { summary } : {}),
      ...(validation ? { validation } : {}),
      ...(verdict ? { verdict } : {}),
    });

    try {
      await this.transition('preparing', { taskId: id, repairCycle: 0 });
      await this.prepareBranch(branch);
      const context = await buildTaskContext({
        project: this.brain,
        task,
        ...(this.global ? { global: this.global } : {}),
        ...(this.contextBudgetChars ? { budgetChars: this.contextBudgetChars } : {}),
      });
      const session = this.executor.createSession({
        task,
        context,
        root: this.root,
        log: (level, message) => this.log(level, message, id),
      });

      let failureReport: string | undefined;
      for (;;) {
        await this.transition('implementing', { taskId: id, repairCycle: cycle });
        const result = await session.run({
          cycle,
          signal,
          ...(failureReport ? { failureReport } : {}),
        });
        summary = result.summary;
        this.log(
          'info',
          `implementation pass ${cycle} ended (${result.stopReason}, ${result.iterations} iteration(s), ${result.totalTokens} tokens so far)`,
          id,
        );

        await this.transition('validating', { taskId: id, repairCycle: cycle });
        validation = await this.validator.validate(signal);
        if (signal.aborted) throw new StopSignal();
        this.log(validation.ok ? 'info' : 'warn', validation.summary.split('\n')[0] ?? '', id);

        let failure: string | undefined;
        if (!validation.ok) {
          failure = validation.summary;
        } else {
          await this.git.stageAll();
          const diffStat = await this.git.diffStat(undefined, { cached: true });
          if (!diffStat) {
            failure =
              'The quality gates passed but the task produced no file changes. Implement the task: the change must modify the repository.';
          } else {
            verdict = await this.judge.judge({
              task,
              diffStat,
              diff: await this.git.diff(undefined, { cached: true }),
              validation,
              signal,
            });
            this.log(
              verdict.pass ? 'info' : 'warn',
              `judge (${verdict.kind}): ${verdict.pass ? 'pass' : 'reject'}${verdict.confidence !== undefined ? ` at ${verdict.confidence.toFixed(2)}` : ''}`,
              id,
            );
            if (!verdict.pass) {
              failure = [
                `The acceptance judge (${verdict.kind}) rejected the change even though the checks passed.`,
                ...verdict.reasons.map((r) => `- ${r}`),
                '',
                'Acceptance criteria:',
                ...(task.acceptance ?? [task.title]).map((c) => `- ${c}`),
              ].join('\n');
            }
          }
        }
        if (failure === undefined) break;
        if (cycle >= cfg.maxRepairCycles) {
          return await this.failTask(
            task,
            branch,
            `quality gates still failing after ${cycle} repair cycle(s)`,
            failure,
            partial,
          );
        }
        cycle++;
        await this.transition('repairing', { taskId: id, repairCycle: cycle });
        this.log('warn', `repair cycle ${cycle}/${cfg.maxRepairCycles}`, id);
        failureReport = failure;
      }

      await this.transition('merging', { taskId: id, repairCycle: cycle });
      const delivery = await this.deliver(task, branch, summary);
      task = await this.brain.setTaskStatus(id, 'SUCCESS', {
        notes: truncateHead(
          `${summary}${delivery.url ? `\n\nPull request: ${delivery.url}` : ''}`.trim(),
          1_000,
        ),
      });
      await this.brain.appendStateLog(
        `Task \`${id}\` SUCCESS after ${cycle} repair cycle(s); ${
          delivery.mode === 'pr'
            ? `pull request ${delivery.url}`
            : `merged into \`${cfg.baseBranch}\``
        }.`,
      );
      await this.commitBrain(`chore(davecode): mark task ${id} as SUCCESS`);
      this.log('info', `task ${id} SUCCESS`, id);
      return { outcome: 'success', ...partial(), task, delivery };
    } catch (err) {
      if (err instanceof StopSignal || err instanceof ExecutorAbortedError || signal.aborted) {
        return await this.interruptTask(task, branch, partial);
      }
      if (err instanceof JudgeError || err instanceof ExecutorError || err instanceof GitError) {
        const message = err.message;
        return await this.failTask(task, branch, message, message, partial);
      }
      // Unexpected: clean up as well as possible, mark the task FAILED and surface the error.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.failTask(task, branch, `unexpected error: ${message}`, message, partial);
      } catch {
        // the brain or git may be the problem; the error state below says why
      }
      this.fail(err);
      return { outcome: 'error', ...partial(), error: message };
    }
  }

  /** Checks out the base branch and creates a fresh task branch (archiving a stale one). */
  private async prepareBranch(branch: string): Promise<void> {
    const base = this.config.baseBranch;
    if ((await this.git.currentBranch()) !== base) await this.git.checkout(base);
    if (await this.git.branchExists(branch)) {
      let n = 1;
      while (await this.git.branchExists(`${branch}-attempt-${n}`)) n++;
      await this.git.renameBranch(branch, `${branch}-attempt-${n}`);
      this.log('info', `kept the previous attempt as ${branch}-attempt-${n}`);
    }
    await this.git.createBranch(branch, base);
  }

  /** Commits the change on the task branch, then merges it (or opens a PR). */
  private async deliver(
    task: TaskNode,
    branch: string,
    summary: string,
  ): Promise<{ mode: 'merge' | 'pr'; url?: string }> {
    const base = this.config.baseBranch;
    const message = commitMessage(task, summary);
    await this.git.commitAll(message);

    if (this.config.pullRequests) {
      try {
        const pr = await this.git.openPullRequest({
          branch,
          base,
          title: message.split('\n')[0] ?? task.title,
          body: message,
        });
        if (pr.outcome === 'pr') {
          await this.git.checkout(base);
          this.log('info', `opened pull request ${pr.url ?? ''}`.trim(), task.id);
          return { mode: 'pr', ...(pr.url ? { url: pr.url } : {}) };
        }
        this.log('warn', `pull request mode unavailable (${pr.reason}); merging locally`, task.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log('warn', `could not open a pull request (${reason}); merging locally`, task.id);
      }
    }

    await this.git.checkout(base);
    await this.git.mergeNoFf(branch, `Merge ${branch}: ${task.title}`);
    await this.git.deleteBranch(branch);
    return { mode: 'merge' };
  }

  /** Leaves the work on the task branch and returns to the base branch. */
  private async parkWork(branch: string, message: string): Promise<void> {
    const base = this.config.baseBranch;
    await this.git.abortMerge();
    if ((await this.git.currentBranch()) === branch) {
      try {
        await this.git.commitAll(message, { noVerify: true });
      } catch (err) {
        this.log('warn', `could not snapshot the attempt (${(err as Error).message}); discarding`);
        await this.git.discardChanges();
      }
    }
    await this.git.restore(base);
  }

  private async failTask(
    task: TaskNode,
    branch: string,
    reason: string,
    report: string,
    partial: () => Omit<RunOnceResult, 'outcome'>,
  ): Promise<RunOnceResult> {
    await this.parkWork(branch, `wip(davecode): failed attempt for task ${task.id}`);
    const failed = await this.brain.setTaskStatus(task.id, 'FAILED', {
      notes: truncateHead(`FAILED: ${reason}\n\n${report}`, 4_000),
    });
    await this.brain.appendStateLog(
      `Task \`${task.id}\` FAILED: ${reason}. Work kept on \`${branch}\`.`,
    );
    await this.commitBrain(`chore(davecode): mark task ${task.id} as FAILED`);
    this.log('error', `task ${task.id} FAILED: ${reason}`, task.id);
    return { outcome: 'failed', ...partial(), task: failed, error: reason };
  }

  private async interruptTask(
    task: TaskNode,
    branch: string,
    partial: () => Omit<RunOnceResult, 'outcome'>,
  ): Promise<RunOnceResult> {
    await this.parkWork(branch, `wip(davecode): interrupted attempt for task ${task.id}`);
    const pending = await this.brain.setTaskStatus(task.id, 'PENDING', {
      notes: `Interrupted by stop; partial work kept on ${branch}.`,
    });
    await this.brain.appendStateLog(
      `Task \`${task.id}\` interrupted by stop; partial work kept on \`${branch}\`.`,
    );
    await this.commitBrain(`chore(davecode): task ${task.id} interrupted`);
    this.log('warn', `task ${task.id} interrupted; back to PENDING`, task.id);
    return { outcome: 'stopped', ...partial(), task: pending };
  }

  private async commitBrain(message: string): Promise<void> {
    if (!this.config.commitBrain) return;
    try {
      await this.git.commitBrain(message);
    } catch (err) {
      this.log('warn', `could not commit the project brain: ${(err as Error).message}`);
    }
  }

  // -- state & events ---------------------------------------------------------

  /** Waits at a step boundary (pause), aborts on stop, then enters `state`. */
  private async transition(state: RunnerState, patch: Partial<RunnerStatus>): Promise<void> {
    await this.checkpoint();
    this.setState(state, patch);
  }

  private async checkpoint(): Promise<void> {
    if (this.stopRequested) throw new StopSignal();
    while (this.pauseRequested) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
      if (this.stopRequested) throw new StopSignal();
    }
  }

  private setState(state: RunnerState, patch: Partial<RunnerStatus>): void {
    const next: RunnerStatus = { state };
    const keepTask = state !== 'idle' && state !== 'selecting' && state !== 'stopped';
    const taskId = 'taskId' in patch ? patch.taskId : keepTask ? this.current.taskId : undefined;
    const repairCycle =
      'repairCycle' in patch ? patch.repairCycle : keepTask ? this.current.repairCycle : undefined;
    if (taskId !== undefined) next.taskId = taskId;
    if (repairCycle !== undefined) next.repairCycle = repairCycle;
    if (this.current.startedAt) next.startedAt = this.current.startedAt;
    const lastError = 'lastError' in patch ? patch.lastError : this.current.lastError;
    if (lastError !== undefined) next.lastError = lastError;
    this.current = next;
    this.events.emit({ type: 'runner.status', status: { ...next } });
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.setState('error', { lastError: message });
    this.log('error', message);
  }

  private log(level: LogLevel, message: string, taskId?: string): void {
    this.events.emit({
      type: 'runner.log',
      level,
      message,
      ...(taskId !== undefined ? { taskId } : {}),
    });
  }
}
