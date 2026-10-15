/**
 * Bridges goal `code` tasks to the autonomous runner: each one is mirrored into the project's
 * TASK_GRAPH.json and run with `runOnce({ taskId })`, so it gets the usual branch, quality gates,
 * judge and merge. Tokens are metered per task and capped by the goal's remaining budget.
 */

import { createExecutor, createRunner } from '../autonomous/create';
import type {
  Executor,
  ExecutorResult,
  ExecutorSession,
  ExecutorTask,
} from '../autonomous/executor';
import { Git } from '../autonomous/git';
import { type AutonomousRunner, type RunnerConfig, RunnerError } from '../autonomous/runner';
import type { WorkspaceLock } from '../autonomous/workspace-lock';
import type { ProjectBrain } from '../brain/project';
import type { Engine } from '../engine';
import type { Goal, GoalTask } from '../types';
import type { CodeTaskResult, CodeTaskRunner } from './orchestrator';
import { sanitizeTaskId } from './plan';

type EngineDeps = Pick<Engine, 'config' | 'router' | 'accounts' | 'sandboxes' | 'events' | 'paths'>;

/** Sums the tokens of every pass of every session it creates. */
export class MeteredExecutor implements Executor {
  tokens = 0;

  constructor(private readonly inner: Executor) {}

  get name(): string {
    return this.inner.name;
  }

  createSession(task: ExecutorTask): ExecutorSession {
    const session = this.inner.createSession(task);
    return {
      run: async (opts): Promise<ExecutorResult> => {
        const result = await session.run(opts);
        this.tokens += Math.max(0, result.tokens);
        return result;
      },
    };
  }
}

/** Runner-shaped dependency, so tests can swap the real runner. */
export type GoalTaskRunner = Pick<AutonomousRunner, 'runOnce' | 'stop'>;

export interface RunnerCodeTasksOptions {
  engine: EngineDeps;
  brain: ProjectBrain;
  /** Shared with the main runner; goal mode holds it as `owner` for the whole goal. */
  lock: WorkspaceLock;
  owner?: string;
  contextExtras?: () => string | Promise<string>;
  /** Override the executor chosen by `runner.executor` (tests). */
  executor?: Executor;
  /** Override how the per-task runner is built (tests). */
  makeRunner?: (config: RunnerConfig, executor: Executor) => GoalTaskRunner;
}

/** Floor for a task's token cap so a nearly spent goal still gets a meaningful attempt. */
const MIN_TASK_TOKENS = 10_000;

export class RunnerCodeTasks implements CodeTaskRunner {
  private readonly owner: string;

  constructor(private readonly options: RunnerCodeTasksOptions) {
    this.owner = options.owner ?? 'goal';
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { brain, engine } = this.options;
    const git = new Git(brain.root);
    if (!(await git.isRepo()))
      return { ok: false, reason: `${brain.root} is not a git repository` };
    if (!(await brain.isInitialised())) {
      return { ok: false, reason: 'the project brain is missing (run davecode init)' };
    }
    const base = engine.config.runner.baseBranch;
    if (!(await git.branchExists(base))) {
      return { ok: false, reason: `base branch "${base}" does not exist` };
    }
    if ((await git.status({ ignoreBrain: true })).length > 0) {
      return { ok: false, reason: 'the working tree has uncommitted changes' };
    }
    return { ok: true };
  }

  async run(
    task: GoalTask,
    opts: { goal: Goal; maxTokens: number; signal: AbortSignal },
  ): Promise<CodeTaskResult> {
    const { brain, engine } = this.options;
    const runnerTaskId = sanitizeTaskId(`goal-${opts.goal.id.slice(-6)}-${task.id}`);
    const graph = await brain.readGraph();
    const existing = graph.tasks.find((t) => t.id === runnerTaskId);
    if (existing?.status === 'SUCCESS') {
      return { ok: true, summary: existing.notes ?? 'already done', tokens: 0, runnerTaskId };
    }
    if (!existing) {
      await brain.createTask({
        id: runnerTaskId,
        title: task.title,
        description: [
          task.description,
          `Part of DaveCode goal ${opts.goal.id}: ${opts.goal.objective}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        ...(task.acceptance?.length ? { acceptance: task.acceptance } : {}),
      });
    } else if (existing.status !== 'PENDING') {
      await brain.setTaskStatus(runnerTaskId, 'PENDING', { notes: 'retried by goal mode' });
    }

    const base = engine.config.runner;
    const config: RunnerConfig = {
      ...base,
      maxTaskTokens: Math.max(MIN_TASK_TOKENS, Math.min(base.maxTaskTokens, opts.maxTokens)),
    };
    const metered = new MeteredExecutor(this.options.executor ?? createExecutor(engine, config));
    const runner =
      this.options.makeRunner?.(config, metered) ??
      createRunner(engine, {
        brain,
        config,
        executor: metered,
        lock: { lock: this.options.lock, owner: this.owner },
        ...(this.options.contextExtras ? { contextExtras: this.options.contextExtras } : {}),
      });

    const onAbort = () => void runner.stop();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await runner.runOnce({ taskId: runnerTaskId });
      return {
        ok: result.outcome === 'success',
        summary: result.summary ?? result.error ?? result.outcome,
        tokens: metered.tokens,
        runnerTaskId,
        ...(result.outcome === 'stopped' ? { stopped: true } : {}),
      };
    } catch (err) {
      if (!(err instanceof RunnerError)) throw err;
      return { ok: false, summary: err.message, tokens: metered.tokens, runnerTaskId };
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}
