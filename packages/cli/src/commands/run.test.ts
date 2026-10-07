import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  configSchema,
  createEngine,
  type Engine,
  ProjectBrain,
  RunnerError,
  type RunnerStatus,
  type RunOnceResult,
} from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../client';
import { createContext } from '../context';
import { CliError } from '../errors';
import { cli, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import { exitCodeFor, explainRunnerError, type RunDeps, runCommand } from './run';

let tmp: TempDir;
let home: string;
let repo: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  repo = join(tmp.path, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.git'), { recursive: true });
});
afterEach(() => tmp.cleanup());

const config = configSchema.parse({});

function fakeRunner(result: RunOnceResult | Error, engine?: Engine) {
  let status: RunnerStatus = { state: 'idle' };
  let running = false;
  const runner = {
    runOnce: vi.fn(async () => {
      if (result instanceof Error) throw result;
      engine?.events.emit({ type: 'runner.log', level: 'info', message: 'working on api' });
      return result;
    }),
    start: vi.fn(async () => {
      if (result instanceof Error) throw result;
      running = true;
      status = { state: 'selecting' };
      engine?.events.emit({ type: 'runner.status', status });
    }),
    stop: vi.fn(async () => {
      running = false;
      status = { state: 'stopped' };
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    status: () => status,
    get running() {
      return running;
    },
  };
  return runner;
}

function setup(result: RunOnceResult | Error) {
  const engine = createEngine({ home, env: testEnv(home), databasePath: ':memory:' });
  const runner = fakeRunner(result, engine);
  const deps: RunDeps = {
    engine,
    noGateway: true,
    wire: () => ({ runner }),
    interrupt: () => new Promise(() => {}),
  };
  return { engine, runner, deps };
}

describe('davecode run --once', () => {
  it('prints a successful result and exits 0', async () => {
    const { engine, deps } = setup({
      outcome: 'success',
      repairCycles: 1,
      task: { id: 'api', title: 'Build the API', status: 'SUCCESS', dependsOn: [] },
      delivery: { mode: 'merge' },
      summary: 'Added the endpoint.',
    });
    const io = testIO();
    const ctx = createContext({}, io, { env: testEnv(home), cwd: repo });
    const code = await runCommand(ctx, { once: true }, deps);
    engine.close();
    expect(code).toBe(0);
    const out = io.stdout.text();
    expect(out).toContain('working on api');
    expect(out).toContain('✓ api Build the API succeeded');
    expect(out).toContain('merged into the base branch');
    expect(out).toContain('repair cycles 1');
    expect(out).toContain('Added the endpoint.');
  });

  it('exits 1 on failure and prints JSON on request', async () => {
    const { engine, deps } = setup({
      outcome: 'failed',
      repairCycles: 3,
      branch: 'davecode/task-api',
      task: { id: 'api', title: 'Build the API', status: 'FAILED', dependsOn: [] },
    });
    const io = testIO();
    const ctx = createContext({ json: true }, io, { env: testEnv(home), cwd: repo });
    const code = await runCommand(ctx, { once: true }, deps);
    engine.close();
    expect(code).toBe(1);
    expect(JSON.parse(io.stdout.text())).toMatchObject({ outcome: 'failed', interrupted: false });
  });

  it('maps RunnerError codes to friendly messages', async () => {
    const { engine, deps } = setup(
      new RunnerError(
        'dirty_worktree',
        'refusing to start: the working tree has uncommitted changes (a.ts).',
      ),
    );
    const ctx = createContext({}, testIO(), { env: testEnv(home), cwd: repo });
    await expect(runCommand(ctx, { once: true }, deps)).rejects.toMatchObject({
      hint: expect.stringContaining('Commit or stash your changes'),
    });
    engine.close();
  });

  it('maps exit codes', () => {
    expect(exitCodeFor({ outcome: 'idle', repairCycles: 0 })).toBe(0);
    expect(exitCodeFor({ outcome: 'error', repairCycles: 0 })).toBe(1);
    expect(exitCodeFor({ outcome: 'stopped', repairCycles: 0 })).toBe(130);
  });
});

describe('davecode run (continuous, without a terminal)', () => {
  it('starts the loop, streams logs and stops safely on interrupt', async () => {
    const { engine, runner, deps } = setup({ outcome: 'idle', repairCycles: 0 });
    let interrupt: () => void = () => {};
    deps.interrupt = () =>
      new Promise<void>((resolve) => {
        interrupt = resolve;
      });
    const io = testIO();
    const ctx = createContext({}, io, { env: testEnv(home), cwd: repo });
    const done = runCommand(ctx, {}, deps);
    await new Promise((r) => setTimeout(r, 30));
    engine.events.emit({ type: 'runner.log', level: 'warn', message: 'tests failed, repairing' });
    interrupt();
    expect(await done).toBe(0);
    engine.close();
    expect(runner.start).toHaveBeenCalled();
    expect(runner.stop).toHaveBeenCalled();
    expect(io.stdout.text()).toContain('selecting');
    expect(io.stdout.text()).toContain('tests failed, repairing');
    expect(io.stdout.text()).toContain('Stopping safely');
  });
});

describe('explainRunnerError', () => {
  it('recognises the gateway 409 for a refused start', () => {
    const err = explainRunnerError(
      new GatewayError(409, 'bad_request', '/r is not inside a git repository'),
      config,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toContain('git init');
    expect(explainRunnerError(new RunnerError('no_base_branch', 'x'), config)).toMatchObject({
      message: 'The base branch "main" does not exist',
    });
    const other = new Error('boom');
    expect(explainRunnerError(other, config)).toBe(other);
  });
});

describe('--task', () => {
  const done: RunOnceResult = {
    outcome: 'success',
    repairCycles: 0,
    task: { id: 'b', title: 'B', status: 'SUCCESS', dependsOn: [] },
    delivery: { mode: 'merge' },
  };

  it('--once --task hands the task id to the runner', async () => {
    const { engine, runner, deps } = setup(done);
    const ctx = createContext({}, testIO(), { env: testEnv(home), cwd: repo });
    expect(await runCommand(ctx, { once: true, task: 'b' }, deps)).toBe(0);
    engine.close();
    expect(runner.runOnce).toHaveBeenCalledWith({ taskId: 'b' });
  });

  it('--task without --once starts the loop on that task first', async () => {
    const { engine, runner, deps } = setup(done);
    deps.interrupt = () => Promise.resolve();
    const ctx = createContext({}, testIO(), { env: testEnv(home), cwd: repo });
    await runCommand(ctx, { task: 'b' }, deps);
    engine.close();
    expect(runner.start).toHaveBeenCalledWith({ taskId: 'b' });
  });

  it('without --task the runner picks for itself', async () => {
    const { engine, runner, deps } = setup(done);
    const ctx = createContext({}, testIO(), { env: testEnv(home), cwd: repo });
    await runCommand(ctx, { once: true }, deps);
    engine.close();
    expect(runner.runOnce).toHaveBeenCalledWith({});
  });

  it('explains blocked, non-runnable and unknown tasks', async () => {
    for (const [code, hint] of [
      ['task_blocked', 'Run its dependencies first'],
      ['task_not_runnable', 'davecode tasks status <id> PENDING'],
      ['task_not_found', 'davecode tasks'],
    ] as const) {
      const { engine, deps } = setup(new RunnerError(code, 'task "b" is not runnable'));
      const ctx = createContext({}, testIO(), { env: testEnv(home), cwd: repo });
      await expect(runCommand(ctx, { once: true, task: 'b' }, deps)).rejects.toMatchObject({
        message: 'task "b" is not runnable',
        hint: expect.stringContaining(hint),
      });
      engine.close();
    }
  });
});

describe('davecode run against a real repository', () => {
  function git(...args: string[]) {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  }

  it('reports nothing to do when no task is ready', async () => {
    tmp.cleanup();
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    await ProjectBrain.init(repo, { name: 'demo' });
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const res = await cli(['run', '--once'], { home, cwd: repo, env: { DAVECODE_PORT: '1' } });
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Nothing to do');
  });

  it('refuses a dirty working tree with a hint', async () => {
    tmp.cleanup();
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await ProjectBrain.init(repo, { name: 'demo' });
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(repo, 'scratch.txt'), 'uncommitted');
    const res = await cli(['run', '--once'], { home, cwd: repo, env: { DAVECODE_PORT: '1' } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Commit or stash your changes');
  });
});
