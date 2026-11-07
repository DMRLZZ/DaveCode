import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorService } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orchestratorWorktreesDir, type Runtime, startRuntime } from './runtime';
import { type TempDir, tempDir, testEnv } from './test-utils';

const core = vi.hoisted(() => ({
  createOrchestratorService: vi.fn(),
  createCliAgentRunner: vi.fn(() => ({ runner: true })),
  createGitWorkspace: vi.fn(() => ({ workspace: true })),
}));

vi.mock('@davecode/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@davecode/core')>()),
  ...core,
}));

function fakeService(): OrchestratorService {
  return {
    agents: vi.fn(async () => []),
    start: vi.fn(),
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    cancel: vi.fn(() => false),
    apply: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

let tmp: TempDir;
let home: string;
let repo: string;
let runtime: Runtime | undefined;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  repo = join(tmp.path, 'repo');
  mkdirSync(home);
  mkdirSync(join(repo, '.git'), { recursive: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  tmp.cleanup();
});

const start = (extra: Partial<Parameters<typeof startRuntime>[0]> = {}) =>
  startRuntime({
    home,
    env: testEnv(home),
    cwd: repo,
    host: '127.0.0.1',
    port: 0,
    dashboard: false,
    ...extra,
  });

describe('orchestratorWorktreesDir', () => {
  it('keys the folder by the first 16 hex digits of the project path hash', () => {
    const key = createHash('sha256').update(repo).digest('hex').slice(0, 16);
    expect(orchestratorWorktreesDir(home, repo)).toBe(join(home, 'worktrees', key));
    expect(orchestratorWorktreesDir(home, join(tmp.path, 'other'))).not.toBe(
      orchestratorWorktreesDir(home, repo),
    );
  });
});

describe('startRuntime orchestrator wiring', () => {
  it('builds the orchestrator for the project on loopback, serves it and closes it', async () => {
    const service = fakeService();
    core.createOrchestratorService.mockReturnValue(service);
    const env = testEnv(home);
    runtime = await start({ env, projectDir: repo });

    expect(runtime.orchestrator).toBe(service);
    expect(core.createCliAgentRunner).toHaveBeenCalledWith({ env });
    expect(core.createGitWorkspace).toHaveBeenCalledWith({
      projectDir: repo,
      worktreesDir: orchestratorWorktreesDir(home, repo),
    });
    expect(core.createOrchestratorService).toHaveBeenCalledWith({
      projectDir: repo,
      home,
      events: runtime.engine.events,
      runner: { runner: true },
      workspace: { workspace: true },
    });

    const response = await fetch(`${runtime.url}/api/orchestrator/runs`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [] });

    await runtime.close();
    runtime = undefined;
    expect(service.close).toHaveBeenCalledOnce();
  });

  it('keeps running without it when it cannot be built, and says so without details', async () => {
    core.createOrchestratorService.mockImplementation(() => {
      throw new Error('spawn failed: C:\\Users\\me\\secret-token');
    });
    const onWarning = vi.fn();
    runtime = await start({ projectDir: repo, onWarning });

    expect(runtime.orchestrator).toBeUndefined();
    const response = await fetch(`${runtime.url}/api/orchestrator/runs`);
    expect(response.status).toBe(404);
    const health = await fetch(`${runtime.url}/api/health`);
    expect(health.status).toBe(200);

    expect(onWarning).toHaveBeenCalledOnce();
    const warning = runtime.engine.events
      .recent()
      .find((event) => event.type === 'log' && event.scope === 'orchestrator');
    expect(warning).toMatchObject({ level: 'warn' });
    expect(JSON.stringify(warning)).not.toContain('secret-token');
    expect(String(onWarning.mock.calls[0]?.[0])).not.toContain('secret-token');
  });

  it('builds none without a project', async () => {
    runtime = await start({ noProject: true });
    expect(core.createOrchestratorService).not.toHaveBeenCalled();
    expect(runtime.orchestrator).toBeUndefined();
  });

  it('uses an injected orchestrator, or none when given false', async () => {
    const service = fakeService();
    runtime = await start({ projectDir: repo, orchestrator: service });
    expect(core.createOrchestratorService).not.toHaveBeenCalled();
    expect(runtime.orchestrator).toBe(service);
    await runtime.close();
    expect(service.close).toHaveBeenCalledOnce();

    runtime = await start({ projectDir: repo, orchestrator: false });
    expect(core.createOrchestratorService).not.toHaveBeenCalled();
    expect(runtime.orchestrator).toBeUndefined();
    expect((await fetch(`${runtime.url}/api/orchestrator/agents`)).status).toBe(404);
  });

  it('closes the orchestrator when startup fails after building it', async () => {
    const service = fakeService();
    core.createOrchestratorService.mockReturnValue(service);
    const first = await start({ projectDir: repo });
    try {
      // The same port again: the second gateway cannot listen.
      await expect(start({ projectDir: repo, port: first.port })).rejects.toThrow();
      expect(service.close).toHaveBeenCalledOnce();
    } finally {
      await first.close();
    }
  });
});
