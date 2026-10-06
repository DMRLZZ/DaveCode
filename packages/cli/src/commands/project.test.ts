import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context';
import { scriptedPrompter } from '../lib/prompter';
import { cli, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import { initCommand } from './init';
import { parseStatus } from './tasks';

let tmp: TempDir;
let home: string;
let repo: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  repo = join(tmp.path, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'demo-app', scripts: { lint: 'biome check .', test: 'vitest run' } }),
  );
  writeFileSync(join(repo, 'pnpm-lock.yaml'), '');
});
afterEach(() => tmp.cleanup());

describe('davecode init', () => {
  it('scaffolds the brain, writes a starter config with --config and ignores the lock', async () => {
    const res = await cli(['init', '--config'], { home, cwd: join(repo) });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Project brain ready for demo-app');
    for (const file of ['STATE.md', 'ARCHITECTURE.md', 'TASK_GRAPH.json', 'config.json']) {
      expect(existsSync(join(repo, '.davecode', file))).toBe(true);
    }
    const config = JSON.parse(readFileSync(join(repo, '.davecode', 'config.json'), 'utf8'));
    expect(config.runner.validate).toEqual({ lint: 'pnpm lint', test: 'pnpm test' });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.davecode/.lock');

    const again = await cli(['init', '--json'], { home, cwd: repo });
    const report = JSON.parse(again.stdout);
    expect(report.created).toEqual([]);
    expect(report.config).toBeNull();
  });

  it('skips the config without a terminal unless asked, and asks in one', async () => {
    const res = await cli(['init', '--name', 'Custom'], { home, cwd: repo });
    expect(res.stdout).toContain('pass --config');
    expect(existsSync(join(repo, '.davecode', 'config.json'))).toBe(false);
    expect(readFileSync(join(repo, '.davecode', 'STATE.md'), 'utf8')).toContain('# Custom');

    const ctx = createContext({}, testIO({ tty: true }), { env: testEnv(home), cwd: repo });
    const prompter = scriptedPrompter([true]);
    await initCommand(ctx, {}, { prompter });
    expect(prompter.asked[0]).toContain('lint: pnpm lint');
    expect(existsSync(join(repo, '.davecode', 'config.json'))).toBe(true);
  });
});

describe('davecode tasks', () => {
  it('asks for init when there is no brain', async () => {
    const res = await cli(['tasks'], { home, cwd: repo });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('davecode init');
  });

  it('adds tasks, shows the tree and the next task, and updates status', async () => {
    await cli(['init', '--no-config'], { home, cwd: repo });
    expect((await cli(['tasks', 'add', 'setup', 'Set', 'up'], { home, cwd: repo })).code).toBe(0);
    const added = await cli(
      ['tasks', 'add', 'api', 'Build the API', '-d', 'setup', '-p', '2', '-a', 'tests pass'],
      { home, cwd: repo },
    );
    expect(added.stdout).toContain('depends on setup');

    const dup = await cli(['tasks', 'add', 'api', 'again'], { home, cwd: repo });
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain('already exists');

    const badDep = await cli(['tasks', 'add', 'x', 'X', '-d', 'missing'], { home, cwd: repo });
    expect(badDep.code).toBe(1);
    expect(badDep.stderr).toContain('missing');

    const tree = await cli(['tasks'], { home, cwd: repo });
    expect(tree.stdout).toContain('0/2 done');
    expect(tree.stdout).toContain('○ setup  Set up  → next');
    expect(tree.stdout).toContain('└─◌ api    Build the API  waiting on setup');

    const next = await cli(['tasks', 'next'], { home, cwd: repo });
    expect(next.stdout).toContain('setup  Set up');

    expect((await cli(['tasks', 'status', 'setup', 'running'], { home, cwd: repo })).code).toBe(0);
    const done = await cli(['tasks', 'status', 'setup', 'done'], { home, cwd: repo });
    expect(done.stdout).toContain('setup is now SUCCESS');

    const invalid = await cli(['tasks', 'status', 'api', 'SUCCESS'], { home, cwd: repo });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('cannot move PENDING');

    const json = JSON.parse((await cli(['tasks', '--json'], { home, cwd: repo })).stdout);
    expect(json.next).toBe('api');
    expect(json.graph.tasks[1].acceptance).toEqual(['tests pass']);
  });

  it('normalises status names', () => {
    expect(parseStatus('in-progress')).toBe('IN_PROGRESS');
    expect(parseStatus('done')).toBe('SUCCESS');
    expect(() => parseStatus('maybe')).toThrow(/Unknown status/);
  });
});

describe('davecode config', () => {
  it('redacts the auth token in show and get', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ server: { authToken: 'tok-very-secret', port: 4999 } }),
    );
    const show = await cli(['config', 'show'], { home, cwd: repo });
    expect(show.code).toBe(0);
    expect(show.stdout).not.toContain('tok-very-secret');
    expect(JSON.parse(show.stdout).server).toMatchObject({ authToken: '[redacted]', port: 4999 });

    const port = await cli(['config', 'get', 'server.port'], { home, cwd: repo });
    expect(port.stdout.trim()).toBe('4999');
    const token = await cli(['config', 'get', 'server.authToken'], { home, cwd: repo });
    expect(token.stdout.trim()).toBe('[redacted]');
    const missing = await cli(['config', 'get', 'server.nope'], { home, cwd: repo });
    expect(missing.code).toBe(1);
  });

  it('lists file locations and env overrides by name only', async () => {
    const res = await cli(['config', 'path'], {
      home,
      cwd: repo,
      env: { DAVECODE_AUTH_TOKEN: 'env-secret' },
    });
    expect(res.stdout).toContain(join(home, 'config.json'));
    expect(res.stdout).toContain(join(repo, '.davecode', 'config.json'));
    expect(res.stdout).toContain('DAVECODE_AUTH_TOKEN');
    expect(res.stdout).not.toContain('env-secret');
  });

  it('reports invalid config files with a hint', async () => {
    writeFileSync(join(home, 'config.json'), '{ nope');
    const res = await cli(['config', 'show'], { home, cwd: repo });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('malformed JSON');
    expect(res.stderr).toContain('davecode config path');
  });
});
