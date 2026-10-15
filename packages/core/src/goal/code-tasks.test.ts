import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Executor, ExecutorResult } from '../autonomous/executor';
import { createTempRepo, writeFiles } from '../autonomous/test-helpers';
import { WorkspaceLock } from '../autonomous/workspace-lock';
import { ProjectBrain } from '../brain/project';
import { createEngine, type Engine } from '../engine';
import type { Goal, GoalTask } from '../types';
import { MeteredExecutor, RunnerCodeTasks } from './code-tasks';

const pass = (tokens: number): ExecutorResult => ({
  summary: 'did it',
  stopReason: 'finished',
  iterations: 1,
  tokens,
  totalTokens: tokens,
  changedFiles: [],
});

const fakeExecutor = (tokens: number): Executor => ({
  name: 'fake',
  createSession: () => ({ run: async () => pass(tokens) }),
});

const goal = { id: 'goal_abcdef123456', objective: 'Ship it' } as Goal;
const task: GoalTask = {
  id: 'landing',
  title: 'Build the landing page',
  description: 'One HTML file',
  role: 'implementer',
  kind: 'code',
  status: 'IN_PROGRESS',
  dependsOn: [],
  round: 1,
  attempts: 1,
  acceptance: ['index.html exists'],
};

let home: string;
let engine: Engine;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-home-'));
  engine = createEngine({ home, env: { DAVECODE_HOME: home }, databasePath: ':memory:' });
});
afterEach(() => {
  engine.close();
  rmSync(home, { recursive: true, force: true });
});

describe('MeteredExecutor', () => {
  it('sums tokens across sessions and passes', async () => {
    const metered = new MeteredExecutor(fakeExecutor(70));
    const session = metered.createSession({
      task: { id: 't', title: 't', status: 'PENDING' } as never,
      context: '',
      root: '.',
    });
    await session.run({ cycle: 0 });
    await session.run({ cycle: 1 });
    expect(metered.tokens).toBe(140);
    expect(metered.name).toBe('fake');
  });
});

describe('RunnerCodeTasks', () => {
  it('reports why code tasks are unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'davecode-nogit-'));
    try {
      const brain = await ProjectBrain.init(dir);
      const tasks = new RunnerCodeTasks({ engine, brain, lock: new WorkspaceLock() });
      expect(await tasks.available()).toMatchObject({ ok: false, reason: /not a git repository/ });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is available on a clean initialised repository, not on a dirty one', async () => {
    const repo = createTempRepo();
    try {
      const brain = await ProjectBrain.init(repo.root);
      const tasks = new RunnerCodeTasks({ engine, brain, lock: new WorkspaceLock() });
      expect(await tasks.available()).toEqual({ ok: true });
      writeFiles(repo.root, { 'dirty.txt': 'x' });
      expect(await tasks.available()).toMatchObject({ ok: false, reason: /uncommitted/ });
    } finally {
      repo.cleanup();
    }
  });

  it('mirrors the task into the project graph and runs it with a capped, metered budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'davecode-brain-'));
    try {
      const brain = await ProjectBrain.init(dir);
      const runs: Array<{ taskId?: string; maxTaskTokens: number }> = [];
      const tasks = new RunnerCodeTasks({
        engine,
        brain,
        lock: new WorkspaceLock(),
        executor: fakeExecutor(1_234),
        makeRunner: (config, executor) => ({
          runOnce: async (opts = {}) => {
            runs.push({
              ...(opts.taskId ? { taskId: opts.taskId } : {}),
              maxTaskTokens: config.maxTaskTokens,
            });
            await executor
              .createSession({ task: {} as never, context: '', root: dir })
              .run({ cycle: 0 });
            return { outcome: 'success', repairCycles: 0, summary: 'merged' };
          },
          stop: async () => undefined,
        }),
      });
      const result = await tasks.run(task, {
        goal,
        maxTokens: 50_000,
        signal: new AbortController().signal,
      });
      expect(result).toEqual({
        ok: true,
        summary: 'merged',
        tokens: 1_234,
        runnerTaskId: 'goal-123456-landing',
      });
      expect(runs).toEqual([{ taskId: 'goal-123456-landing', maxTaskTokens: 50_000 }]);
      const node = (await brain.readGraph()).tasks.find((t) => t.id === 'goal-123456-landing');
      expect(node).toMatchObject({
        title: 'Build the landing page',
        status: 'PENDING',
        acceptance: ['index.html exists'],
      });
      expect(node?.description).toContain('Part of DaveCode goal goal_abcdef123456');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
