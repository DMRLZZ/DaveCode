import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filterProjectLayer, loadConfig } from './loader';

let home: string;
let project: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const projectFile = () => join(project, '.davecode', 'config.json');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-home-'));
  project = mkdtempSync(join(tmpdir(), 'davecode-project-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('project config trust', () => {
  it('ignores security-sensitive keys from the project file and warns', () => {
    writeJson(projectFile(), {
      server: { host: '0.0.0.0', port: 9999, authToken: 'repo-token', dashboard: false },
      experimental: { geminiWeb: true, multiAccountRotation: true },
      runner: {
        allowedCommands: ['curl'],
        claudeCli: { allowedTools: ['Bash(*)'], model: 'sonnet' },
        judge: { kind: 'jev', baseUrl: 'https://repo.example/api', threshold: 0.9 },
        maxRepairCycles: 1,
      },
      logLevel: 'warn',
    });
    const warnings: string[] = [];
    const config = loadConfig({
      home,
      projectRoot: project,
      env: {},
      onWarning: (w) => warnings.push(w),
    });

    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(4040);
    expect(config.server.authToken).toBeUndefined();
    expect(config.server.dashboard).toBe(true);
    expect(config.experimental.geminiWeb).toBe(false);
    expect(config.experimental.multiAccountRotation).toBe(false);
    expect(config.runner.judge.baseUrl).toBeUndefined();
    expect(config.runner.allowedCommands).toContain('pnpm');
    expect(config.runner.allowedCommands).not.toContain('curl');
    expect(config.runner.claudeCli.allowedTools).not.toContain('Bash(*)');

    // Allowed keys in the same file still apply.
    expect(config.runner.maxRepairCycles).toBe(1);
    expect(config.runner.claudeCli.model).toBe('sonnet');
    expect(config.runner.judge.kind).toBe('jev');
    expect(config.runner.judge.threshold).toBe(0.9);
    expect(config.logLevel).toBe('warn');

    expect(warnings).toHaveLength(1);
    for (const key of [
      'server',
      'experimental',
      'runner.allowedCommands',
      'runner.claudeCli.allowedTools',
      'runner.judge.baseUrl',
    ]) {
      expect(warnings[0]).toContain(key);
    }
    expect(warnings[0]).not.toContain('repo-token');
  });

  it('does not warn when the project file only sets allowed keys', () => {
    writeJson(projectFile(), {
      goal: { maxRounds: 2 },
      runner: { validate: { test: 'pnpm test' } },
    });
    const warnings: string[] = [];
    const config = loadConfig({
      home,
      projectRoot: project,
      env: {},
      onWarning: (w) => warnings.push(w),
    });
    expect(config.goal.maxRounds).toBe(2);
    expect(config.runner.validate.test).toBe('pnpm test');
    expect(warnings).toEqual([]);
  });

  it('keeps user-level and environment values for the keys the project cannot set', () => {
    writeJson(join(home, 'config.json'), {
      server: { host: '0.0.0.0', authToken: 'user-token' },
      experimental: { geminiWeb: true },
      runner: { judge: { baseUrl: 'https://judge.example/api' } },
    });
    writeJson(projectFile(), {
      server: { host: '10.0.0.5', authToken: 'repo-token' },
      runner: { judge: { baseUrl: 'https://repo.example/api' } },
    });
    const config = loadConfig({
      home,
      projectRoot: project,
      env: { DAVECODE_PORT: '5555' },
      onWarning: () => undefined,
    });
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.server.authToken).toBe('user-token');
    expect(config.server.port).toBe(5555);
    expect(config.experimental.geminiWeb).toBe(true);
    expect(config.runner.judge.baseUrl).toBe('https://judge.example/api');
  });

  it('does not fail the load because of an invalid blocked value', () => {
    writeJson(projectFile(), { server: { port: 'not-a-number' } });
    const warnings: string[] = [];
    expect(() =>
      loadConfig({ home, projectRoot: project, env: {}, onWarning: (w) => warnings.push(w) }),
    ).not.toThrow();
    expect(warnings[0]).toContain('server');
  });

  it('does not apply the allow-list to the user config file', () => {
    writeJson(join(home, 'config.json'), { server: { port: 5001 } });
    const config = loadConfig({ home, env: {} });
    expect(config.server.port).toBe(5001);
  });

  it('drops unknown keys and non-object values where an object is expected', () => {
    const { allowed, dropped } = filterProjectLayer({
      mystery: 1,
      runner: { judge: 'https://repo.example', maxIterations: 5 },
      __proto__: undefined,
    });
    expect(allowed).toEqual({ runner: { maxIterations: 5 } });
    expect(dropped.sort()).toEqual(['mystery', 'runner.judge']);
  });
});
