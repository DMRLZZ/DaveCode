import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngine, ProjectBrain } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCommand } from './commands/start';
import { createContext } from './context';
import { detectProjectRoot, resolveDashboardDir, startRuntime, wireProject } from './runtime';
import { type TempDir, tempDir, testEnv, testIO } from './test-utils';

let tmp: TempDir;
let home: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  mkdirSync(home);
});
afterEach(() => tmp.cleanup());

describe('detectProjectRoot', () => {
  it('finds the nearest git repository', async () => {
    const repo = join(tmp.path, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(await detectProjectRoot(join(repo, 'src', 'deep'), home)).toBe(repo);
  });

  it('never treats the DaveCode home as a project brain', async () => {
    // tmp/.davecode is the home; tmp/work has no repo marker of its own.
    const davecodeHome = join(tmp.path, '.davecode');
    mkdirSync(davecodeHome);
    mkdirSync(join(tmp.path, 'work'));
    const found = await detectProjectRoot(join(tmp.path, 'work'), davecodeHome);
    expect(found).not.toBe(tmp.path);
  });

  it('accepts a project .davecode directory without git', async () => {
    const repo = join(tmp.path, 'plain');
    mkdirSync(join(repo, '.davecode'), { recursive: true });
    expect(await detectProjectRoot(repo, home)).toBe(repo);
  });
});

describe('wireProject', () => {
  it('serves an uninitialised repository as empty and still builds a runner', async () => {
    const engine = createEngine({ home, env: testEnv(home), databasePath: ':memory:' });
    try {
      const { source, runner, brain } = wireProject(engine, tmp.path, { name: 'demo' });
      expect(brain.root).toBe(tmp.path);
      expect(source.project()).toEqual({ root: tmp.path, name: 'demo' });
      expect(await source.graph()).toEqual({ version: 1, tasks: [] });
      expect(await source.state()).toBe('');
      expect(runner.status().state).toBe('idle');
      await expect(runner.runOnce()).rejects.toMatchObject({ name: 'RunnerError' });
    } finally {
      engine.close();
    }
  });

  it('reads the brain files once initialised', async () => {
    const brain = await ProjectBrain.init(tmp.path, { name: 'demo' });
    await brain.writeGraph({
      version: 1,
      tasks: [{ id: 'a', title: 'First', status: 'PENDING', dependsOn: [] }],
    });
    const engine = createEngine({ home, env: testEnv(home), databasePath: ':memory:' });
    try {
      const { source } = wireProject(engine, tmp.path);
      expect((await source.graph()).tasks.map((t) => t.id)).toEqual(['a']);
      expect(await source.state()).toContain('# demo: project state');
    } finally {
      engine.close();
    }
  });
});

describe('resolveDashboardDir', () => {
  it('prefers DAVECODE_DASHBOARD_DIR when it contains index.html', () => {
    const dir = join(tmp.path, 'ui');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    expect(resolveDashboardDir({ DAVECODE_DASHBOARD_DIR: dir })).toBe(dir);
  });

  it('returns undefined when no build exists', () => {
    const fakeModule = pathToFileURL(join(tmp.path, 'a', 'b', 'index.js')).href;
    expect(resolveDashboardDir({}, fakeModule, false)).toBeUndefined();
  });

  it('finds the monorepo layout relative to the bundle', () => {
    const ui = join(tmp.path, 'packages', 'ui', 'dist');
    mkdirSync(ui, { recursive: true });
    writeFileSync(join(ui, 'index.html'), '<!doctype html>');
    const bundle = pathToFileURL(join(tmp.path, 'packages', 'cli', 'dist', 'index.js')).href;
    expect(resolveDashboardDir({}, bundle, false)).toBe(ui);
  });
});

describe('startRuntime', () => {
  it('serves health, accounts and the project brain on an ephemeral port', async () => {
    const repo = join(tmp.path, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    await ProjectBrain.init(repo, { name: 'repo' });
    const runtime = await startRuntime({
      home,
      env: testEnv(home),
      cwd: repo,
      host: '127.0.0.1',
      port: 0,
      dashboard: false,
    });
    try {
      expect(runtime.port).toBeGreaterThan(0);
      expect(runtime.runner?.status().state).toBe('idle');
      const health = (await fetch(`${runtime.url}/api/health`).then((r) => r.json())) as {
        status: string;
      };
      expect(health.status).toBe('ok');
      const tasks = (await fetch(`${runtime.url}/api/tasks`).then((r) => r.json())) as {
        project: unknown;
      };
      expect(tasks.project).toEqual({ root: repo, name: 'repo' });
      // The fake .git directory is not a real repository: the runner refuses to start.
      const runner = await fetch(`${runtime.url}/api/runner/start`, { method: 'POST' });
      expect(runner.status).toBe(409);
    } finally {
      await runtime.close();
    }
  });
});

describe('startCommand', () => {
  it('prints a banner with URLs and accounts, then shuts down cleanly', async () => {
    const io = testIO();
    const ctx = createContext({}, io, { env: testEnv(home), cwd: tmp.path });
    let url = '';
    const code = await startCommand(
      ctx,
      { port: 0, host: '127.0.0.1', dashboard: false },
      {
        until: async (runtime) => {
          url = runtime.url;
          const res = await fetch(`${runtime.url}/api/health`);
          expect(res.ok).toBe(true);
        },
      },
    );
    expect(code).toBe(0);
    const out = io.stdout.text();
    expect(out).toContain('DaveCode');
    expect(out).toContain(`${url}/v1`);
    expect(out).toContain('Dashboard  disabled');
    expect(out).toContain('none yet: run `davecode accounts add`');
    expect(out).toContain('Stopping DaveCode');
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  });

  it('emits a JSON ready line and warns about experimental flags', async () => {
    const io = testIO();
    const env = testEnv(home, { DAVECODE_EXPERIMENTAL_GEMINI_WEB: '1' });
    const ctx = createContext({ json: true }, io, { env, cwd: tmp.path });
    await startCommand(ctx, { port: 0, host: '127.0.0.1' }, { until: async () => {} });
    const ready = JSON.parse(io.stdout.text());
    expect(ready.status).toBe('running');
    expect(ready.api).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(ready.warnings.join('\n')).toContain('geminiWeb');
  });
});
