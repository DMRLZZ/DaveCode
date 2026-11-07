import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DaveEvent, EventBus } from '../events';
import {
  type AgentAvailability,
  type AgentRunner,
  type AgentRunRequest,
  type AgentRunResult,
  ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_LIMITS,
  type OrchestratorAgent,
  OrchestratorError,
  type OrchestratorRun,
  type OrchestratorService,
  type OrchestratorWorkspace,
  type TaskWorkspace,
  type WorkspaceResult,
} from './contract';
import { createOrchestratorService, INTERRUPTED_ERROR } from './service';
import { orchestratorRunsPath } from './store';

// --- Fakes -------------------------------------------------------------------------------------

interface Call {
  request: AgentRunRequest;
  resolve(result: AgentRunResult): void;
}

/** Every `run` stays pending until the test resolves it (or the signal aborts it). */
class FakeRunner implements AgentRunner {
  available: OrchestratorAgent[] = [...ORCHESTRATOR_AGENTS];
  readonly calls: Call[] = [];
  private waiters: Array<{ match: (call: Call) => boolean; resolve: (call: Call) => void }> = [];
  private claimed = new Set<Call>();

  async availability(): Promise<AgentAvailability[]> {
    return ORCHESTRATOR_AGENTS.map((agent) => ({
      agent,
      available: this.available.includes(agent),
    }));
  }

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      const call: Call = { request, resolve };
      request.signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
      this.calls.push(call);
      for (const waiter of [...this.waiters]) {
        if (!this.claimed.has(call) && waiter.match(call)) {
          this.claimed.add(call);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          waiter.resolve(call);
        }
      }
    });
  }

  /** The next not-yet-awaited call matching `match` (one already made, or the next one). */
  next(match: (call: Call) => boolean = () => true): Promise<Call> {
    const existing = this.calls.find((call) => !this.claimed.has(call) && match(call));
    if (existing) {
      this.claimed.add(existing);
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  /** The next edit call for the task whose worktree ends with `taskId`. */
  task(taskId: string): Promise<Call> {
    return this.next((c) => c.request.mode === 'edit' && c.request.cwd.endsWith(`/${taskId}`));
  }

  plan(): Promise<Call> {
    return this.next((c) => c.request.mode === 'plan');
  }

  editCalls(): Call[] {
    return this.calls.filter((c) => c.request.mode === 'edit');
  }
}

class FakeWorkspace implements OrchestratorWorkspace {
  readonly log: string[] = [];
  checkResult: Awaited<ReturnType<OrchestratorWorkspace['check']>> = {
    ok: true,
    branch: 'main',
    commit: 'abc123',
  };
  files = new Map<string, string[]>();
  merges = new Map<string, WorkspaceResult>();
  applyResult: WorkspaceResult = { ok: true };
  cleanupError = false;

  async check() {
    this.log.push('check');
    return this.checkResult;
  }

  async createIntegration(runId: string, baseCommit: string): Promise<string> {
    this.log.push(`integration ${runId} ${baseCommit}`);
    return `davecode/run-${runId}`;
  }

  async createTask(runId: string, taskId: string, base: string): Promise<TaskWorkspace> {
    this.log.push(`create ${taskId} from ${base}`);
    return { path: `/worktrees/${runId}/${taskId}`, branch: `davecode/run-${runId}-${taskId}` };
  }

  async commitTask(workspace: TaskWorkspace, message: string): Promise<string[]> {
    const taskId = workspace.branch.split('-').at(-1)!;
    this.log.push(`commit ${taskId} ${message}`);
    return this.files.get(taskId) ?? [`src/${taskId}.ts`];
  }

  async mergeIntoIntegration(runId: string, branch: string): Promise<WorkspaceResult> {
    const taskId = branch.split('-').at(-1)!;
    this.log.push(`merge ${taskId} into davecode/run-${runId}`);
    return this.merges.get(taskId) ?? { ok: true };
  }

  async apply(runId: string, baseBranch: string): Promise<WorkspaceResult> {
    this.log.push(`apply ${runId} to ${baseBranch}`);
    return this.applyResult;
  }

  async cleanup(runId: string): Promise<void> {
    this.log.push(`cleanup ${runId}`);
    if (this.cleanupError) throw new Error('worktree busy');
  }
}

// --- Harness -----------------------------------------------------------------------------------

const PROJECT = '/projects/app';
let home: string;
let events: EventBus;
let runner: FakeRunner;
let workspace: FakeWorkspace;
let services: OrchestratorService[];
let clock: number;
let ids: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'davecode-orch-'));
  events = new EventBus(5000);
  runner = new FakeRunner();
  workspace = new FakeWorkspace();
  services = [];
  clock = Date.UTC(2026, 10, 7, 12, 0, 0);
  ids = 0;
});

afterEach(async () => {
  for (const service of services) await service.close();
  await rm(home, { recursive: true, force: true });
});

function makeService(): OrchestratorService {
  const service = createOrchestratorService({
    projectDir: PROJECT,
    home,
    events,
    runner,
    workspace,
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    newId: () => `r${++ids}`,
  });
  services.push(service);
  return service;
}

const ok = (text = 'Changed things.'): AgentRunResult => ({ ok: true, text });

const plan = (
  tasks: Array<{ title: string; agent?: string; dependsOn?: number[]; prompt?: string }>,
): AgentRunResult =>
  ok(
    JSON.stringify({
      tasks: tasks.map((t) => ({ prompt: `Please do ${t.title}.`, dependsOn: [], ...t })),
    }),
  );

/** Resolves once the run matches `predicate` (checked now and after every event). */
function waitForRun(
  service: OrchestratorService,
  id: string,
  predicate: (run: OrchestratorRun) => boolean,
): Promise<OrchestratorRun> {
  return new Promise((resolve) => {
    const check = () => {
      const run = service.get(id);
      if (run && predicate(run)) {
        unsubscribe();
        resolve(run);
        return true;
      }
      return false;
    };
    const unsubscribe = events.subscribe(() => {
      check();
    });
    check();
  });
}

const ended = (run: OrchestratorRun) => !['planning', 'running'].includes(run.status);

/** Waits for the run to end and for its cleanup to finish. */
async function settle(service: OrchestratorService, id: string): Promise<OrchestratorRun> {
  await waitForRun(service, id, ended);
  await service.close();
  return service.get(id)!;
}

const taskStatus = (run: OrchestratorRun) =>
  Object.fromEntries(run.tasks.map((t) => [t.id, t.status]));

function runEvents(): OrchestratorRun[] {
  return events
    .recent()
    .filter(
      (e): e is Extract<DaveEvent, { type: 'orchestrator.run' }> => e.type === 'orchestrator.run',
    )
    .map((e) => e.run);
}

function outputEvents() {
  return events
    .recent()
    .filter(
      (e): e is Extract<DaveEvent, { type: 'orchestrator.output' }> =>
        e.type === 'orchestrator.output',
    );
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<OrchestratorError> {
  const err = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OrchestratorError);
  expect((err as OrchestratorError).code).toBe(code);
  return err as OrchestratorError;
}

// --- Tests -------------------------------------------------------------------------------------

describe('start', () => {
  it('returns the run in planning with the base and integration branch', async () => {
    const service = makeService();
    const run = await service.start({ objective: '  Add search  ' });
    expect(run).toMatchObject({
      id: 'r1',
      objective: 'Add search',
      status: 'planning',
      agents: ['claude', 'codex', 'agy'],
      planner: 'claude',
      baseBranch: 'main',
      baseCommit: 'abc123',
      integrationBranch: 'davecode/run-r1',
      tasks: [],
    });
    expect(workspace.log).toContain('integration r1 abc123');
    expect(runEvents()[0]).toMatchObject({ id: 'r1', status: 'planning' });
    expect(service.list().map((r) => r.id)).toEqual(['r1']);
  });

  it('rejects invalid input', async () => {
    const service = makeService();
    await expect(service.start({ objective: '   ' })).rejects.toThrow();
    await expect(service.start({ objective: 'x', maxTasks: 99 })).rejects.toThrow();
    expect(service.list()).toEqual([]);
  });

  it('rejects outside a git repository', async () => {
    const service = makeService();
    workspace.checkResult = { ok: false, reason: 'not a git repository' };
    const err = await expectCode(service.start({ objective: 'x' }), 'not_a_repository');
    expect(err.message).toBe('not a git repository');
    workspace.check = async () => {
      throw new Error('git not found');
    };
    await expectCode(service.start({ objective: 'x' }), 'not_a_repository');
    expect(service.list()).toEqual([]);
  });

  it('rejects when no allowed agent is available', async () => {
    const service = makeService();
    runner.available = [];
    await expectCode(service.start({ objective: 'x' }), 'no_agents');
    runner.available = ['claude'];
    await expectCode(service.start({ objective: 'x', agents: ['codex', 'agy'] }), 'no_agents');
  });

  it('uses only the allowed, available agents and picks the planner by order', async () => {
    const service = makeService();
    runner.available = ['codex', 'agy'];
    const run = await service.start({ objective: 'x', agents: ['agy', 'claude', 'codex'] });
    expect(run.agents).toEqual(['codex', 'agy']);
    expect(run.planner).toBe('codex');
    const call = await runner.plan();
    expect(call.request.agent).toBe('codex');
  });

  it('allows one active run at a time', async () => {
    const service = makeService();
    const [a, b] = await Promise.allSettled([
      service.start({ objective: 'a' }),
      service.start({ objective: 'b' }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b.status === 'rejected' && (b.reason as OrchestratorError).code).toBe('busy');
    const first = service.list()[0]!;
    await expectCode(service.start({ objective: 'second' }), 'busy');

    service.cancel(first.id);
    await waitForRun(service, first.id, ended);
    const second = await service.start({ objective: 'second' });
    expect(second.status).toBe('planning');
  });
});

describe('planning', () => {
  it('runs the planner in plan mode in the project and forwards its output', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'Add search', maxTasks: 3, agents: ['claude'] });
    const call = await runner.plan();
    expect(call.request).toMatchObject({
      agent: 'claude',
      cwd: PROJECT,
      mode: 'plan',
      timeoutMs: ORCHESTRATOR_LIMITS.planTimeoutMs,
    });
    expect(call.request.prompt).toContain('Add search');
    expect(call.request.prompt).toContain('at most 3 tasks');
    expect(call.request.prompt).not.toMatch(/- codex:/);

    call.request.onOutput({ kind: 'text', text: 'Reading the repo' });
    call.request.onOutput({ kind: 'text', text: 'x'.repeat(5000) });
    call.request.onOutput({ kind: 'error', text: '' });
    const outputs = outputEvents().filter((e) => e.taskId === 'plan' && e.runId === run.id);
    expect(outputs.map((e) => e.output.kind)).toEqual(['status', 'text', 'text', 'error']);
    expect(outputs[1]?.output.text).toBe('Reading the repo');
    expect(outputs[2]?.output.text).toHaveLength(2000);
  });

  it('uses the default task limit', async () => {
    const service = makeService();
    await service.start({ objective: 'x' });
    const call = await runner.plan();
    expect(call.request.prompt).toContain(`at most ${ORCHESTRATOR_LIMITS.defaultMaxTasks} tasks`);
  });

  it('asks the planner once to repair an invalid plan', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x', agents: ['claude'] });
    (await runner.plan()).resolve(ok('I think we should add a search box.'));
    const repair = await runner.plan();
    expect(repair.request.prompt).toContain('I think we should add a search box.');
    expect(repair.request.prompt).toMatch(/not a valid JSON object/);
    repair.resolve(plan([{ title: 'Search box' }]));
    (await runner.task('t1')).resolve(ok());
    const final = await settle(service, run.id);
    expect(final.status).toBe('done');
    expect(final.tasks.map((t) => t.title)).toEqual(['Search box']);
  });

  it('repairs a plan with zero tasks', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(ok('{"tasks":[]}'));
    const repair = await runner.plan();
    expect(repair.request.prompt).toMatch(/no tasks/);
    repair.resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok());
    expect((await settle(service, run.id)).status).toBe('done');
  });

  it('fails when the repaired plan is still invalid', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(ok('nope'));
    (await runner.plan()).resolve(ok('still nope'));
    const final = await settle(service, run.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/did not return a usable plan/);
    expect(final.error!.length).toBeLessThanOrEqual(300);
    expect(runner.calls).toHaveLength(2);
    expect(runner.editCalls()).toHaveLength(0);
    expect(workspace.log).toContain('cleanup r1');
  });

  it('fails on a dependency cycle', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    const cyclic = plan([
      { title: 'A', dependsOn: [2] },
      { title: 'B', dependsOn: [1] },
    ]);
    (await runner.plan()).resolve(cyclic);
    const repair = await runner.plan();
    expect(repair.request.prompt).toMatch(/cycle/);
    repair.resolve(cyclic);
    const final = await settle(service, run.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/cycle/);
    expect(final.tasks).toEqual([]);
  });

  it('fails when the planner agent fails', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve({ ok: false, text: '', error: 'claude is not signed in' });
    const final = await settle(service, run.id);
    expect(final.status).toBe('failed');
    expect(final.error).toBe('The planner (claude) failed: claude is not signed in');
    expect(runner.calls).toHaveLength(1);
  });

  it('reassigns disallowed agents round-robin', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x', agents: ['claude', 'agy'] });
    (await runner.plan()).resolve(
      plan([
        { title: 'A', agent: 'codex' },
        { title: 'B', agent: 'agy' },
        { title: 'C', agent: 'gemini' },
      ]),
    );
    const running = await waitForRun(service, run.id, (r) => r.status === 'running');
    expect(running.tasks.map((t) => t.agent)).toEqual(['claude', 'agy', 'agy']);
  });
});

describe('execution', () => {
  it('runs independent tasks in parallel and merges them', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'Ship search' });
    (await runner.plan()).resolve(
      plan([
        { title: 'API', agent: 'claude' },
        { title: 'UI', agent: 'codex' },
        { title: 'Docs', agent: 'agy' },
      ]),
    );
    const [t1, t2, t3] = await Promise.all([
      runner.task('t1'),
      runner.task('t2'),
      runner.task('t3'),
    ]);
    expect(runner.editCalls()).toHaveLength(3);
    expect(t1.request).toMatchObject({
      agent: 'claude',
      cwd: '/worktrees/r1/t1',
      mode: 'edit',
      timeoutMs: ORCHESTRATOR_LIMITS.taskTimeoutMs,
    });
    expect(t1.request.prompt).toContain('Ship search');
    expect(t1.request.prompt).toContain('Your task: API');
    expect(t1.request.prompt).toContain('Please do API.');
    expect(t1.request.prompt).toMatch(/- UI \(codex\)/);
    expect(service.get(run.id)?.tasks.map((t) => t.status)).toEqual([
      'running',
      'running',
      'running',
    ]);

    t2.request.onOutput({ kind: 'tool', text: 'edit src/ui.tsx' });
    t2.resolve(ok('Built the UI.'));
    t1.resolve(ok('Built the API.'));
    t3.resolve(ok('x'.repeat(ORCHESTRATOR_LIMITS.summaryMaxLength + 100)));
    const final = await settle(service, run.id);

    expect(final.status).toBe('done');
    expect(final.summary).toBe(
      '3 of 3 tasks finished on davecode/run-r1. Apply it to merge into main.',
    );
    const [a, b, c] = final.tasks;
    expect(a).toMatchObject({
      status: 'done',
      branch: 'davecode/run-r1-t1',
      summary: 'Built the API.',
      changedFiles: ['src/t1.ts'],
    });
    expect(a?.startedAt).toBeDefined();
    expect(a?.finishedAt).toBeDefined();
    expect(b?.summary).toBe('Built the UI.');
    expect(c?.summary).toHaveLength(ORCHESTRATOR_LIMITS.summaryMaxLength);
    expect(workspace.log).toEqual(
      expect.arrayContaining([
        'create t1 from davecode/run-r1',
        'commit t1 davecode: API',
        'merge t1 into davecode/run-r1',
        'merge t2 into davecode/run-r1',
        'merge t3 into davecode/run-r1',
      ]),
    );
    expect(workspace.log.at(-1)).toBe('cleanup r1');
    expect(outputEvents().find((e) => e.taskId === 't2' && e.output.kind === 'tool')).toMatchObject(
      {
        runId: 'r1',
        output: { kind: 'tool', text: 'edit src/ui.tsx' },
      },
    );
  });

  it('starts a dependent task from the integration branch after its dependency merged', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(
      plan([
        { title: 'Schema', agent: 'claude' },
        { title: 'Endpoint', agent: 'codex', dependsOn: [1] },
      ]),
    );
    const t1 = await runner.task('t1');
    expect(runner.editCalls()).toHaveLength(1);
    expect(service.get(run.id)?.tasks[1]).toMatchObject({ status: 'pending', dependsOn: ['t1'] });
    t1.resolve(ok());
    const t2 = await runner.task('t2');
    expect(t2.request.prompt).toMatch(/already in your copy[\s\S]*- Schema/);
    const mergeT1 = workspace.log.indexOf('merge t1 into davecode/run-r1');
    const createT2 = workspace.log.indexOf('create t2 from davecode/run-r1');
    expect(mergeT1).toBeGreaterThan(-1);
    expect(createT2).toBeGreaterThan(mergeT1);
    t2.resolve(ok());
    expect(taskStatus(await settle(service, run.id))).toEqual({ t1: 'done', t2: 'done' });
  });

  it('runs at most one task per agent at a time', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(
      plan([
        { title: 'A', agent: 'claude' },
        { title: 'B', agent: 'claude' },
        { title: 'C', agent: 'codex' },
      ]),
    );
    const a = await runner.task('t1');
    const c = await runner.task('t3');
    expect(runner.editCalls().map((call) => call.request.cwd)).toEqual([
      '/worktrees/r1/t1',
      '/worktrees/r1/t3',
    ]);
    expect(service.get(run.id)?.tasks[1]?.status).toBe('pending');
    c.resolve(ok());
    await waitForRun(service, run.id, (r) => r.tasks[2]?.status === 'done');
    expect(runner.editCalls()).toHaveLength(2);
    a.resolve(ok());
    (await runner.task('t2')).resolve(ok());
    expect((await settle(service, run.id)).status).toBe('done');
  });

  it('skips the dependents of a failed task', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(
      plan([
        { title: 'A', agent: 'claude' },
        { title: 'B', agent: 'codex', dependsOn: [1] },
        { title: 'C', agent: 'agy', dependsOn: [2] },
        { title: 'D', agent: 'codex' },
      ]),
    );
    const d = await runner.task('t4');
    (await runner.task('t1')).resolve({ ok: false, text: 'partial', error: 'rate limited' });
    d.resolve(ok());
    const final = await settle(service, run.id);
    expect(taskStatus(final)).toEqual({ t1: 'failed', t2: 'skipped', t3: 'skipped', t4: 'done' });
    expect(final.tasks[0]).toMatchObject({ error: 'rate limited', summary: 'partial' });
    expect(final.tasks[1]?.error).toBe('Depends on t1 (A), which ended failed.');
    expect(final.tasks[2]?.error).toBe('Depends on t2 (B), which ended skipped.');
    expect(final.status).toBe('done');
    expect(final.summary).toMatch(
      /^1 of 4 tasks finished on davecode\/run-r1\. t1 failed: rate limited; t2 was skipped/,
    );
    expect(workspace.log.some((l) => l.startsWith('commit t1'))).toBe(false);
  });

  it('fails the run when no task finished', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    workspace.createTask = async () => {
      throw new Error('worktree add failed');
    };
    const final = await settle(service, run.id);
    expect(final.status).toBe('failed');
    expect(final.error).toBe('No task finished.');
    expect(final.tasks[0]).toMatchObject({ status: 'failed', error: 'worktree add failed' });
    expect(final.summary).toMatch(/None of the 1 tasks finished/);
  });

  it('marks a task whose merge conflicts', async () => {
    const service = makeService();
    workspace.merges.set('t2', { ok: false, reason: 'conflict in src/app.ts' });
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(
      plan([
        { title: 'A', agent: 'claude' },
        { title: 'B', agent: 'codex' },
      ]),
    );
    (await runner.task('t1')).resolve(ok());
    (await runner.task('t2')).resolve(ok());
    const final = await settle(service, run.id);
    expect(final.tasks[1]).toMatchObject({
      status: 'conflict',
      error: 'conflict in src/app.ts',
      branch: 'davecode/run-r1-t2',
      changedFiles: ['src/t2.ts'],
    });
    expect(final.status).toBe('done');
    expect(final.summary).toContain(
      't2 conflicts with the integration branch: conflict in src/app.ts',
    );
  });

  it('does not merge a task that changed nothing', async () => {
    const service = makeService();
    workspace.files.set('t1', []);
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok('Nothing to change.'));
    const final = await settle(service, run.id);
    expect(final.tasks[0]).toMatchObject({ status: 'done', changedFiles: [] });
    expect(workspace.log.some((l) => l.startsWith('merge'))).toBe(false);
  });

  it('swallows cleanup errors', async () => {
    const service = makeService();
    workspace.cleanupError = true;
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok());
    expect((await settle(service, run.id)).status).toBe('done');
    expect(workspace.log).toContain('cleanup r1');
  });
});

describe('cancel', () => {
  it('cancels running and pending tasks', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(
      plan([
        { title: 'A', agent: 'claude' },
        { title: 'B', agent: 'codex' },
        { title: 'C', agent: 'claude', dependsOn: [1] },
      ]),
    );
    const a = await runner.task('t1');
    (await runner.task('t2')).resolve(ok());
    await waitForRun(service, run.id, (r) => r.tasks[1]?.status === 'done');
    expect(service.cancel(run.id)).toBe(true);
    expect(a.request.signal.aborted).toBe(true);
    const final = await settle(service, run.id);
    expect(final.status).toBe('cancelled');
    expect(taskStatus(final)).toEqual({ t1: 'cancelled', t2: 'done', t3: 'cancelled' });
    expect(final.summary).toBe('Cancelled: 1 of 3 tasks had finished on davecode/run-r1.');
    expect(workspace.log).toContain('cleanup r1');
    expect(workspace.log.some((l) => l.startsWith('commit t1'))).toBe(false);
    expect(service.cancel(run.id)).toBe(false);
    expect(service.cancel('nope')).toBe(false);
  });

  it('cancels while planning', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    const call = await runner.plan();
    expect(service.cancel(run.id)).toBe(true);
    expect(call.request.signal.aborted).toBe(true);
    const final = await settle(service, run.id);
    expect(final).toMatchObject({ status: 'cancelled', tasks: [] });
    expect(runner.editCalls()).toHaveLength(0);
  });

  it('close cancels active runs and waits for them', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    await runner.task('t1');
    await service.close();
    expect(service.get(run.id)).toMatchObject({ status: 'cancelled' });
    expect(workspace.log.at(-1)).toBe('cleanup r1');
  });
});

describe('apply', () => {
  async function finishedRun(service: OrchestratorService): Promise<OrchestratorRun> {
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok());
    return waitForRun(service, run.id, ended);
  }

  it('merges the integration branch into the base branch once', async () => {
    const service = makeService();
    const run = await finishedRun(service);
    const applied = await service.apply(run.id);
    expect(applied.appliedAt).toBeDefined();
    expect(workspace.log).toContain('apply r1 to main');
    expect(runEvents().at(-1)?.appliedAt).toBe(applied.appliedAt);
    const err = await expectCode(service.apply(run.id), 'not_appliable');
    expect(err.message).toMatch(/already applied/);
  });

  it('reports a failed merge as not_appliable', async () => {
    const service = makeService();
    const run = await finishedRun(service);
    workspace.applyResult = { ok: false, reason: 'the working tree has uncommitted changes' };
    const err = await expectCode(service.apply(run.id), 'not_appliable');
    expect(err.message).toBe('the working tree has uncommitted changes');
    expect(service.get(run.id)?.appliedAt).toBeUndefined();
    workspace.apply = async () => {
      throw new Error('git crashed');
    };
    await expectCode(service.apply(run.id), 'not_appliable');
  });

  it('rejects unknown and unfinished runs', async () => {
    const service = makeService();
    await expectCode(service.apply('nope'), 'not_found');
    const run = await service.start({ objective: 'x' });
    await expectCode(service.apply(run.id), 'not_appliable');
    (await runner.plan()).resolve(ok('nope'));
    (await runner.plan()).resolve(ok('nope'));
    await waitForRun(service, run.id, ended);
    const err = await expectCode(service.apply(run.id), 'not_appliable');
    expect(err.message).toMatch(/failed/);
    expect(workspace.log.some((l) => l.startsWith('apply'))).toBe(false);
  });
});

describe('persistence and events', () => {
  it('persists runs and reloads them, newest first', async () => {
    const first = makeService();
    const a = await first.start({ objective: 'first' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok());
    await waitForRun(first, a.id, ended);
    const b = await first.start({ objective: 'second' });
    (await runner.plan()).resolve(ok('nope'));
    (await runner.plan()).resolve(ok('nope'));
    await settle(first, b.id);

    const second = makeService();
    expect(second.list().map((r) => [r.id, r.status])).toEqual([
      ['r2', 'failed'],
      ['r1', 'done'],
    ]);
    expect(second.get('r1')).toEqual(first.get('r1'));
  });

  it('marks runs interrupted by a restart as failed', async () => {
    const path = orchestratorRunsPath(home, PROJECT);
    mkdirSync(dirname(path), { recursive: true });
    const base = {
      objective: 'x',
      agents: ['claude'],
      tasks: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        runs: [
          {
            ...base,
            id: 'old',
            status: 'running',
            tasks: [
              {
                id: 't1',
                title: 'A',
                agent: 'claude',
                prompt: 'p',
                dependsOn: [],
                status: 'running',
              },
              {
                id: 't2',
                title: 'B',
                agent: 'claude',
                prompt: 'p',
                dependsOn: [],
                status: 'pending',
              },
            ],
          },
          { ...base, id: 'older', status: 'done', createdAt: '2025-01-01T00:00:00.000Z' },
        ],
      }),
    );
    const service = makeService();
    expect(service.get('old')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_ERROR,
      tasks: [{ status: 'failed', error: INTERRUPTED_ERROR }, { status: 'cancelled' }],
    });
    expect(service.get('older')?.status).toBe('done');
    await service.close();
    expect(workspace.log).toContain('cleanup old');
    const reloaded = makeService();
    expect(reloaded.get('old')?.status).toBe('failed');
  });

  it('starts empty when the runs file is corrupt', () => {
    const path = orchestratorRunsPath(home, PROJECT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{{{');
    expect(makeService().list()).toEqual([]);
  });

  it('emits a snapshot on every state change', async () => {
    const service = makeService();
    const run = await service.start({ objective: 'x' });
    (await runner.plan()).resolve(plan([{ title: 'A' }]));
    (await runner.task('t1')).resolve(ok());
    await settle(service, run.id);
    const snapshots = runEvents();
    const statuses = snapshots.map((r) => `${r.status}:${r.tasks.map((t) => t.status).join(',')}`);
    expect(statuses[0]).toBe('planning:');
    expect(statuses).toContain('running:pending');
    expect(statuses).toContain('running:running');
    expect(statuses.at(-1)).toBe('done:done');
    // Snapshots are copies, not the live run.
    snapshots[0]!.status = 'cancelled';
    expect(service.get(run.id)?.status).toBe('done');
    expect(snapshots[1]).not.toBe(snapshots[2]);
    const all = events.recent();
    expect(all.every((e) => typeof e.ts === 'number')).toBe(true);
  });
});
