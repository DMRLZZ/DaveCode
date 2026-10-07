import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskGraph } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ascii, plain, type TempDir, tempDir } from '../test-utils';
import { getPath, REDACTED, redact, redactUrlCredentials } from './redact';
import { formatTaskDetail, formatTaskTree, summaryLine } from './task-tree';
import { detectPackageManager, detectValidateCommands, runScript } from './validate-detect';

describe('redact', () => {
  it('hides credentials but keeps counters and empty values', () => {
    const config = {
      server: { host: '127.0.0.1', port: 4040, authToken: 'super-secret' },
      runner: {
        judge: { baseUrl: 'https://user:hunter2@judge.example/v1', apiKey: 'k', threshold: 0.7 },
      },
      provider: { maxTokens: 1000, tokens5h: 5, password: '', secret: undefined },
      list: [{ token: 'x' }],
    };
    const out = redact(config);
    expect(out.server).toEqual({ host: '127.0.0.1', port: 4040, authToken: REDACTED });
    expect(out.runner.judge.baseUrl).toBe(`https://user:${REDACTED}@judge.example/v1`);
    expect(out.runner.judge.apiKey).toBe(REDACTED);
    expect(out.provider).toEqual({ maxTokens: 1000, tokens5h: 5, password: '', secret: undefined });
    expect(out.list[0]?.token).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toMatch(/super-secret|hunter2/);
    // The input is not mutated.
    expect(config.server.authToken).toBe('super-secret');
  });

  it('leaves URLs without credentials alone', () => {
    expect(redactUrlCredentials('http://localhost:4040/v1')).toBe('http://localhost:4040/v1');
  });

  it('reads dotted paths', () => {
    const value = { a: { b: [{ c: 1 }] }, z: 0 };
    expect(getPath(value, 'a.b.0.c')).toEqual({ found: true, value: 1 });
    expect(getPath(value, 'z')).toEqual({ found: true, value: 0 });
    expect(getPath(value, 'a.x')).toEqual({ found: false });
    expect(getPath(value, 'a.b.c')).toEqual({ found: false });
  });
});

const graph: TaskGraph = {
  version: 1,
  tasks: [
    { id: 'setup', title: 'Set up the repo', status: 'SUCCESS', dependsOn: [] },
    { id: 'storage', title: 'SQLite storage', status: 'SUCCESS', dependsOn: ['setup'] },
    { id: 'brain', title: 'Project brain', status: 'FAILED', dependsOn: ['setup'], attempts: 3 },
    {
      id: 'router',
      title: 'Quota-aware router',
      status: 'IN_PROGRESS',
      dependsOn: ['storage'],
      attempts: 2,
    },
    { id: 'gateway', title: 'Gateway', status: 'PENDING', dependsOn: ['router', 'storage'] },
    { id: 'tui', title: 'Terminal UI', status: 'PENDING', dependsOn: ['brain'] },
    { id: 'docs', title: 'Write docs', status: 'PENDING', dependsOn: [], priority: 5 },
  ],
};

describe('formatTaskTree', () => {
  it('draws the DAG with glyphs, secondary dependencies and blocked reasons', () => {
    expect(formatTaskTree(plain, graph)).toEqual([
      '● setup    Set up the repo',
      '├─● storage  SQLite storage',
      '│ └─◐ router   Quota-aware router  attempt 2',
      '│   └─◌ gateway  Gateway  + needs storage · waiting on router',
      '└─✗ brain    Project brain  failed after 3 attempt(s)',
      '  └─◌ tui      Terminal UI  blocked: brain failed',
      '○ docs     Write docs  p5 · → next',
    ]);
  });

  it('falls back to ASCII connectors', () => {
    const lines = formatTaskTree(ascii, graph);
    expect(lines[1]).toBe('|-* storage  SQLite storage');
    expect(lines[2]).toBe('| `-~ router   Quota-aware router  attempt 2');
  });

  it('truncates titles to the terminal width', () => {
    const wide: TaskGraph = {
      version: 1,
      tasks: [{ id: 'a', title: 'x'.repeat(200), status: 'PENDING', dependsOn: [] }],
    };
    const [line] = formatTaskTree(plain, wide, { width: 40 });
    expect(line!.length).toBeLessThanOrEqual(40);
    expect(line).toContain('…');
  });

  it('summarises progress and shows task details', () => {
    expect(summaryLine(plain, graph)).toBe(
      '2/7 done (28.6%)  ·  ● 2 done  ◐ 1 running  ○ 3 pending  ✗ 1 failed',
    );
    expect(formatTaskTree(plain, { version: 1, tasks: [] })).toEqual(['No tasks yet.']);
    const detail = formatTaskDetail(plain, {
      id: 'x',
      title: 'Do it',
      status: 'PENDING',
      dependsOn: ['a'],
      acceptance: ['tests pass'],
    });
    expect(detail.join('\n')).toContain('depends on  a');
    expect(detail.join('\n')).toContain('• tests pass');
  });
});

describe('validate detection', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it('maps package.json scripts to runner.validate commands', () => {
    const pkg = {
      scripts: { lint: 'biome check .', 'type-check': 'tsc --noEmit', test: 'vitest run' },
    };
    expect(detectValidateCommands(pkg, 'pnpm')).toEqual({
      lint: 'pnpm lint',
      typecheck: 'pnpm type-check',
      test: 'pnpm test',
    });
    expect(detectValidateCommands(pkg, 'npm')).toEqual({
      lint: 'npm run lint',
      typecheck: 'npm run type-check',
      test: 'npm test',
    });
    expect(runScript('bun', 'lint')).toBe('bun run lint');
  });

  it('ignores the npm placeholder test script', () => {
    const pkg = { scripts: { test: 'echo "Error: no test specified" && exit 1' } };
    expect(detectValidateCommands(pkg, 'npm')).toEqual({});
  });

  it('detects the package manager from packageManager and lockfiles', () => {
    expect(detectPackageManager(tmp.path, { packageManager: 'yarn@4.0.0' })).toBe('yarn');
    expect(detectPackageManager(tmp.path)).toBe('npm');
    mkdirSync(join(tmp.path, 'x'));
    writeFileSync(join(tmp.path, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(tmp.path)).toBe('pnpm');
  });
});
