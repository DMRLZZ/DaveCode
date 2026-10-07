import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectBrain, serializeGraph } from '../brain/project';
import { configSchema } from '../config/schema';
import { type DaveEvent, EventBus } from '../events';
import type { RunnerState, TaskNode } from '../types';
import type {
  Executor,
  ExecutorResult,
  ExecutorRunOptions,
  ExecutorSession,
  ExecutorTask,
} from './executor';
import { ExecutorAbortedError } from './executor';
import { type Judge, JudgeError, type JudgeVerdict } from './judge';
import { AutonomousRunner, commitMessage, RunnerError } from './runner';
import { createTempRepo, git, writeFiles } from './test-helpers';
import type { ValidationReport } from './validator';

type Step = (task: ExecutorTask, opts: ExecutorRunOptions) => Promise<Partial<ExecutorResult>>;

/** Executor double: each pass runs the next scripted step (writes files directly). */
class ScriptedExecutor implements Executor {
  readonly name = 'scripted';
  readonly runs: ExecutorRunOptions[] = [];
  constructor(private readonly steps: Step[]) {}
  createSession(task: ExecutorTask): ExecutorSession {
    return {
      run: async (opts) => {
        this.runs.push(opts);
        const step = this.steps.shift();
        const partial = step ? await step(task, opts) : {};
        return {
          summary: 'did it',
          stopReason: 'finished',
          iterations: 1,
          tokens: 1,
          totalTokens: 1,
          changedFiles: [],
          ...partial,
        };
      },
    };
  }
}

const write =
  (files: Record<string, string>): Step =>
  async (task) => {
    writeFiles(task.root, files);
    return {};
  };

function report(
  ok: boolean,
  text = ok ? 'Validation PASSED.' : 'Validation FAILED (test).',
): ValidationReport {
  return { ok, steps: [], durationMs: 1, summary: text };
}

class ScriptedValidator {
  calls = 0;
  constructor(private readonly results: boolean[]) {}
  async validate(): Promise<ValidationReport> {
    this.calls++;
    const ok = this.results.shift() ?? true;
    return report(ok, ok ? 'Validation PASSED.' : `Validation FAILED (test).\nboom #${this.calls}`);
  }
}

const tasks = (...nodes: Array<Partial<TaskNode> & { id: string }>): TaskNode[] =>
  nodes.map((n) => ({ title: `Task ${n.id}`, status: 'PENDING', dependsOn: [], ...n }));

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function setup(
  graphTasks: TaskNode[],
  opts: {
    executor: Executor;
    validator?: { validate(): Promise<ValidationReport> };
    judge?: Judge;
    runner?: Record<string, unknown>;
  },
) {
  const repo = createTempRepo({ '.gitignore': '.davecode/.lock\n' });
  cleanup = repo.cleanup;
  const events = new EventBus(5_000);
  const brain = await ProjectBrain.init(repo.root, { events });
  writeFileSync(brain.paths.taskGraph, serializeGraph({ version: 1, tasks: graphTasks }));
  git(repo.root, 'add', '--all');
  git(repo.root, 'commit', '--quiet', '-m', 'chore: add brain');
  const config = configSchema.parse({ runner: { idlePollMs: 100, ...opts.runner } }).runner;
  const runner = new AutonomousRunner({
    brain,
    config,
    executor: opts.executor,
    validator: opts.validator ?? new ScriptedValidator([]),
    events,
    ...(opts.judge ? { judge: opts.judge } : {}),
  });
  const states = (): RunnerState[] =>
    events
      .recent()
      .filter((e): e is Extract<DaveEvent, { type: 'runner.status' }> => e.type === 'runner.status')
      .map((e) => e.status.state);
  return { root: repo.root, brain, runner, events, states };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const graphOf = async (brain: ProjectBrain) =>
  Object.fromEntries((await brain.readGraph()).tasks.map((t) => [t.id, t]));

describe('commitMessage', () => {
  it('builds a Conventional Commit with the task trailer', () => {
    const task = tasks({ id: 'x', title: 'Add login page' })[0]!;
    expect(commitMessage(task, 'Adds a page.')).toBe(
      'feat: Add login page\n\nAdds a page.\n\nDaveCode-Task: x',
    );
    expect(commitMessage({ ...task, title: 'fix(api): handle 404' }, '').split('\n')[0]).toBe(
      'fix(api): handle 404',
    );
  });
});

// Each test drives real git in a temp repo, which is slow on Windows CI runners.
describe('AutonomousRunner', { timeout: 60_000 }, () => {
  it('runOnce implements, validates, merges and records SUCCESS', async () => {
    const executor = new ScriptedExecutor([write({ 'src/a.txt': 'a\n' })]);
    const { root, brain, runner, states } = await setup(tasks({ id: 'a' }), { executor });
    const result = await runner.runOnce();
    expect(result).toMatchObject({
      outcome: 'success',
      repairCycles: 0,
      delivery: { mode: 'merge' },
    });
    expect((await graphOf(brain)).a).toMatchObject({ status: 'SUCCESS', attempts: 1 });
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(root, 'branch', '--list', 'davecode/task-a')).toBe('');
    expect(git(root, 'log', '--format=%s')).toContain('feat: Task a');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(states()).toEqual([
      'selecting',
      'preparing',
      'implementing',
      'validating',
      'merging',
      'idle',
    ]);
    expect(runner.status()).toMatchObject({ state: 'idle' });
    expect(readFileSync(brain.paths.state, 'utf8')).toMatch(/Task `a` SUCCESS/);
  });

  it('runOnce({ taskId }) runs that task instead of the highest priority one', async () => {
    const executor = new ScriptedExecutor([write({ 'b.txt': 'b\n' })]);
    const { brain, runner } = await setup(tasks({ id: 'a', priority: 10 }, { id: 'b' }), {
      executor,
    });
    const result = await runner.runOnce({ taskId: 'b' });
    expect(result).toMatchObject({ outcome: 'success', task: { id: 'b' } });
    const graph = await graphOf(brain);
    expect(graph.b?.status).toBe('SUCCESS');
    expect(graph.a?.status).toBe('PENDING');
  });

  it('runOnce({ taskId }) explains why a task is not runnable', async () => {
    const { brain, runner } = await setup(
      tasks(
        { id: 'a', status: 'FAILED' },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', status: 'SUCCESS' },
        { id: 'd', dependsOn: ['b', 'c'] },
      ),
      { executor: new ScriptedExecutor([]) },
    );
    await expect(runner.runOnce({ taskId: 'nope' })).rejects.toMatchObject({
      code: 'task_not_found',
      statusCode: 404,
    });
    await expect(runner.runOnce({ taskId: 'c' })).rejects.toMatchObject({
      code: 'task_not_runnable',
      statusCode: 409,
      message: expect.stringContaining('SUCCESS'),
    });
    const blocked = await runner.runOnce({ taskId: 'd' }).catch((e: unknown) => e);
    expect(blocked).toMatchObject({ code: 'task_blocked' });
    expect((blocked as Error).message).toContain('"b" (PENDING)');
    expect((blocked as Error).message).not.toContain('"c"');
    // A refusal does not leave the runner in an error state or mutate the graph.
    expect(runner.status().state).not.toBe('error');
    expect(runner.running).toBe(false);
    expect((await graphOf(brain)).a?.status).toBe('FAILED');
  });

  it('start({ taskId }) refuses an unrunnable task and otherwise runs it first', async () => {
    const executor = new ScriptedExecutor([write({ 'b.txt': 'b\n' }), write({ 'a.txt': 'a\n' })]);
    const { brain, runner, events } = await setup(tasks({ id: 'a', priority: 10 }, { id: 'b' }), {
      executor,
    });
    await expect(runner.start({ taskId: 'zzz' })).rejects.toMatchObject({
      code: 'task_not_found',
    });
    expect(runner.running).toBe(false);
    await runner.start({ taskId: 'b' });
    await waitFor(async () => {
      const g = await graphOf(brain);
      return g.a?.status === 'SUCCESS' && g.b?.status === 'SUCCESS';
    }, 40_000);
    await runner.stop();
    const started = events
      .recent()
      .flatMap((e) => (e.type === 'runner.log' && /^task \S+: /.test(e.message) ? [e.taskId] : []));
    expect(started.slice(0, 2)).toEqual(['b', 'a']);
  });

  it('returns idle when no task is ready', async () => {
    const { runner } = await setup(tasks({ id: 'a', status: 'SUCCESS' }), {
      executor: new ScriptedExecutor([]),
    });
    expect(await runner.runOnce()).toMatchObject({ outcome: 'idle' });
  });

  it('refuses to start on a dirty working tree (brain changes are ignored)', async () => {
    const { root, runner } = await setup(tasks({ id: 'a' }), {
      executor: new ScriptedExecutor([]),
    });
    writeFileSync(join(root, '.davecode', 'STATE.md'), '# edited from the dashboard\n');
    writeFiles(root, { 'stray.txt': 'x' });
    const err = await runner.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerError);
    expect((err as RunnerError).code).toBe('dirty_worktree');
    expect((err as RunnerError).message).toContain('stray.txt');
    expect(runner.status().state).toBe('error');
    expect(runner.running).toBe(false);
    await expect(runner.runOnce()).rejects.toMatchObject({ code: 'dirty_worktree' });
  });

  it('repairs with the failure report, then marks FAILED after maxRepairCycles', async () => {
    const executor = new ScriptedExecutor([
      write({ 'x.txt': '1' }),
      write({ 'x.txt': '2' }),
      write({ 'x.txt': '3' }),
    ]);
    const validator = new ScriptedValidator([false, false, false]);
    const { root, brain, runner } = await setup(tasks({ id: 'a' }, { id: 'b', dependsOn: ['a'] }), {
      executor,
      validator,
      runner: { maxRepairCycles: 2 },
    });
    const result = await runner.runOnce();
    expect(result).toMatchObject({ outcome: 'failed', repairCycles: 2 });
    expect(executor.runs.map((r) => r.cycle)).toEqual([0, 1, 2]);
    expect(executor.runs[1]?.failureReport).toContain('boom #1');
    expect(executor.runs[2]?.failureReport).toContain('boom #2');
    const graph = await graphOf(brain);
    expect(graph.a?.status).toBe('FAILED');
    expect(graph.a?.notes).toContain('boom #3');
    expect(graph.b?.status).toBe('PENDING');
    // Back on main with a clean tree; the failed attempt stays on its branch.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
    expect(git(root, 'show', 'davecode/task-a:x.txt')).toBe('3');
    expect(readFileSync(brain.paths.state, 'utf8')).toMatch(/Task `a` FAILED/);
    // b is blocked by a failed dependency, so nothing else runs.
    expect(await runner.runOnce()).toMatchObject({ outcome: 'idle' });
  });

  it('archives a previous failed branch when retrying', async () => {
    const executor = new ScriptedExecutor([write({ 'x.txt': 'bad' }), write({ 'x.txt': 'good' })]);
    const validator = new ScriptedValidator([false, true]);
    const { root, brain, runner } = await setup(tasks({ id: 'a' }), {
      executor,
      validator,
      runner: { maxRepairCycles: 0 },
    });
    expect((await runner.runOnce()).outcome).toBe('failed');
    await brain.setTaskStatus('a', 'PENDING');
    expect((await runner.runOnce()).outcome).toBe('success');
    expect(git(root, 'branch', '--list', 'davecode/task-a-attempt-1')).toContain('attempt-1');
    expect((await graphOf(brain)).a?.attempts).toBe(2);
  });

  it('treats an empty change as a failure to repair', async () => {
    const executor = new ScriptedExecutor([async () => ({}), write({ 'y.txt': 'y' })]);
    const { runner } = await setup(tasks({ id: 'a' }), { executor });
    const result = await runner.runOnce();
    expect(result).toMatchObject({ outcome: 'success', repairCycles: 1 });
    expect(executor.runs[1]?.failureReport).toMatch(/no file changes/);
  });

  it('repairs on judge rejection and fails on judge errors without merging', async () => {
    const verdicts: Array<JudgeVerdict | Error> = [
      { kind: 'llm', pass: false, confidence: 0.2, reasons: ['criterion 1 unmet'] },
      { kind: 'llm', pass: true, confidence: 0.9, reasons: [] },
    ];
    const judge: Judge = {
      kind: 'llm',
      async judge() {
        const next = verdicts.shift()!;
        if (next instanceof Error) throw next;
        return next;
      },
    };
    const executor = new ScriptedExecutor([write({ 'a.txt': '1' }), write({ 'a.txt': '2' })]);
    const first = await setup(tasks({ id: 'a', acceptance: ['must greet'] }), { executor, judge });
    const ok = await first.runner.runOnce();
    expect(ok).toMatchObject({ outcome: 'success', repairCycles: 1, verdict: { pass: true } });
    expect(executor.runs[1]?.failureReport).toContain('criterion 1 unmet');
    expect(executor.runs[1]?.failureReport).toContain('must greet');
    cleanup?.();

    verdicts.push(new JudgeError('no key', 'missing_key'));
    const second = await setup(tasks({ id: 'a' }), {
      executor: new ScriptedExecutor([write({ 'a.txt': '1' })]),
      judge,
    });
    const failed = await second.runner.runOnce();
    expect(failed).toMatchObject({ outcome: 'failed', error: 'no key' });
    expect(git(second.root, 'log', '--format=%s', 'main')).not.toContain('feat: Task a');
  });

  it('runs continuously, polls when idle, and stops cleanly', async () => {
    const executor = new ScriptedExecutor([write({ 'a.txt': 'a' }), write({ 'b.txt': 'b' })]);
    const { brain, runner, states } = await setup(
      tasks({ id: 'a' }, { id: 'b', dependsOn: ['a'] }),
      { executor },
    );
    await runner.start();
    expect(runner.running).toBe(true);
    await waitFor(async () => {
      const g = await graphOf(brain);
      return g.a?.status === 'SUCCESS' && g.b?.status === 'SUCCESS';
    });
    await waitFor(() => states().filter((s) => s === 'idle').length >= 2);
    await runner.start(); // no-op while running
    await runner.stop();
    expect(runner.status().state).toBe('stopped');
    expect(runner.running).toBe(false);
    expect(states().at(-1)).toBe('stopped');
  });

  it('stop aborts the in-flight executor call and puts the task back to PENDING', async () => {
    let seenSignal: AbortSignal | undefined;
    const hanging: Step = (task, opts) => {
      writeFiles(task.root, { 'partial.txt': 'wip' });
      seenSignal = opts.signal;
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new ExecutorAbortedError()));
      });
    };
    const { root, brain, runner } = await setup(tasks({ id: 'a' }), {
      executor: new ScriptedExecutor([hanging]),
    });
    await runner.start();
    await waitFor(() => runner.status().state === 'implementing' && seenSignal !== undefined);
    await runner.stop();
    expect(seenSignal?.aborted).toBe(true);
    expect(runner.status().state).toBe('stopped');
    const task = (await graphOf(brain)).a;
    expect(task?.status).toBe('PENDING');
    expect(task?.notes).toMatch(/Interrupted/);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'show', 'davecode/task-a:partial.txt')).toBe('wip');
  });

  it('pauses at the next step boundary and resumes', async () => {
    let release: () => void = () => undefined;
    const gated: Step = async (task) => {
      writeFiles(task.root, { 'g.txt': 'g' });
      await new Promise<void>((r) => {
        release = r;
      });
      return {};
    };
    const validator = new ScriptedValidator([true]);
    const { brain, runner } = await setup(tasks({ id: 'a' }), {
      executor: new ScriptedExecutor([gated]),
      validator,
    });
    await runner.start();
    await waitFor(() => runner.status().state === 'implementing');
    runner.pause();
    expect(runner.status()).toMatchObject({ state: 'paused', taskId: 'a' });
    release();
    await new Promise((r) => setTimeout(r, 100));
    // The executor finished, but validation waits for resume.
    expect(validator.calls).toBe(0);
    expect(runner.status().state).toBe('paused');
    await runner.start(); // start() resumes a paused runner
    await waitFor(async () => (await graphOf(brain)).a?.status === 'SUCCESS');
    expect(validator.calls).toBe(1);
    await runner.stop();
  });

  it('can be stopped while paused', async () => {
    let release: () => void = () => undefined;
    const gated: Step = async (task) => {
      writeFiles(task.root, { 'g.txt': 'g' });
      await new Promise<void>((r) => {
        release = r;
      });
      return {};
    };
    const { brain, runner } = await setup(tasks({ id: 'a' }), {
      executor: new ScriptedExecutor([gated]),
    });
    await runner.start();
    await waitFor(() => runner.status().state === 'implementing');
    runner.pause();
    release();
    await runner.stop();
    expect(runner.status().state).toBe('stopped');
    expect((await graphOf(brain)).a?.status).toBe('PENDING');
  });

  it('rejects runOnce while running', async () => {
    const { runner } = await setup(tasks({ id: 'a', status: 'SUCCESS' }), {
      executor: new ScriptedExecutor([]),
    });
    await runner.start();
    await expect(runner.runOnce()).rejects.toMatchObject({ code: 'busy' });
    await runner.stop();
  });
});
