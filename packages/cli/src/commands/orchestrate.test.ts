import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type EventBus,
  OrchestratorError,
  type OrchestratorRun,
  type OrchestratorService,
  type OrchestratorTask,
} from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../context';
import { CliError } from '../errors';
import { cli, plain, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import {
  createProgress,
  describeRun,
  type OrchestrateDeps,
  oneLine,
  orchestrateCommand,
  parseAgents,
  runExitCode,
  runListLine,
  startInput,
} from './orchestrate';

function task(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: 't1',
    title: 'Add the route',
    agent: 'claude',
    prompt: 'Add GET /health',
    dependsOn: [],
    status: 'pending',
    ...overrides,
  };
}

function run(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: 'r1',
    objective: 'Add a health endpoint',
    status: 'planning',
    agents: ['claude', 'codex'],
    tasks: [],
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

const TS = new Date(2026, 10, 7, 10, 0, 0).getTime();
const at = (r: OrchestratorRun) => ({ type: 'orchestrator.run' as const, run: r, ts: TS });

describe('parseAgents', () => {
  it('accepts ids and aliases, trims, lower-cases and deduplicates', () => {
    expect(parseAgents('claude')).toEqual(['claude']);
    expect(parseAgents(' Codex , agy,claude ')).toEqual(['codex', 'agy', 'claude']);
    expect(parseAgents('antigravity,agy,claude-code')).toEqual(['agy', 'claude']);
  });

  it('refuses unknown or empty lists', () => {
    expect(() => parseAgents('claude,gemini')).toThrow(/Unknown agent "gemini"/);
    expect(() => parseAgents(' , ')).toThrow(CliError);
  });
});

describe('startInput', () => {
  it('joins the words and passes the limits through', () => {
    expect(startInput(['Add', 'a', 'health', 'endpoint'], {})).toEqual({
      objective: 'Add a health endpoint',
    });
    expect(startInput(['x'], { agents: 'codex,agy', maxTasks: 3 })).toEqual({
      objective: 'x',
      agents: ['codex', 'agy'],
      maxTasks: 3,
    });
  });

  it('refuses an empty objective and out-of-range limits', () => {
    expect(() => startInput([' '], {})).toThrow(/Describe the objective/);
    expect(() => startInput(['x'], { maxTasks: 9 })).toThrow(/between 1 and 8/);
    expect(() => startInput(['x'.repeat(4001)], {})).toThrow(/too long/);
  });
});

describe('formatting', () => {
  it('flattens agent output to one clean line', () => {
    expect(oneLine('\u001b[31mred\u001b[0m\n  text\tthere\r\n')).toBe('red text there');
    expect(oneLine('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('prints the plan once, task transitions, tools and errors, nothing else', () => {
    const progress = createProgress(plain, 'r1');
    const tasks = [
      task(),
      task({ id: 't2', agent: 'codex', title: 'Write tests', dependsOn: ['t1'] }),
    ];
    const lines = [
      ...progress(at(run({ planner: 'claude' }))),
      ...progress(at(run({ status: 'running', planner: 'claude', tasks }))),
      ...progress(
        at(run({ status: 'running', tasks: [{ ...tasks[0]!, status: 'running' }, tasks[1]!] })),
      ),
      // The same snapshot again prints nothing.
      ...progress(
        at(run({ status: 'running', tasks: [{ ...tasks[0]!, status: 'running' }, tasks[1]!] })),
      ),
      ...progress({
        type: 'orchestrator.output',
        runId: 'r1',
        taskId: 't1',
        output: { kind: 'tool', text: 'Edit src/server.ts\n' },
        ts: TS,
      }),
      ...progress({
        type: 'orchestrator.output',
        runId: 'r1',
        taskId: 't1',
        output: { kind: 'text', text: 'Thinking about it' },
        ts: TS,
      }),
      ...progress({
        type: 'orchestrator.output',
        runId: 'other',
        taskId: 't1',
        output: { kind: 'error', text: 'not ours' },
        ts: TS,
      }),
      ...progress(
        at(
          run({
            status: 'running',
            tasks: [
              { ...tasks[0]!, status: 'done', changedFiles: ['src/server.ts', 'README.md'] },
              { ...tasks[1]!, status: 'failed', error: 'codex is not signed in' },
            ],
          }),
        ),
      ),
      ...progress({ type: 'log', level: 'info', scope: 'x', message: 'noise', ts: TS }),
    ];
    expect(lines).toEqual([
      '10:00:00 ◐ Planning with claude…',
      '10:00:00 Plan 2 tasks',
      '10:00:00   t1 claude Add the route',
      '10:00:00   t2 codex  Write tests after t1',
      '10:00:00 ◐ t1 claude started',
      '10:00:00   t1 claude Edit src/server.ts',
      '10:00:00 ● t1 claude done  2 files changed',
      '10:00:00 ✗ t2 codex  failed  codex is not signed in',
    ]);
  });

  it('describes a finished run with the branch and how to apply it', () => {
    const lines = describeRun(
      plain,
      run({
        status: 'done',
        planner: 'claude',
        baseBranch: 'main',
        integrationBranch: 'davecode/run-r1',
        summary: 'Health endpoint added with tests.',
        tasks: [
          task({ status: 'done', summary: 'Added GET /health.\nAll good.', changedFiles: ['a'] }),
          task({ id: 't2', agent: 'agy', status: 'conflict', error: 'conflicts in a.ts' }),
        ],
      }),
    );
    expect(lines).toEqual([
      'r1 done planned by claude',
      '  Add a health endpoint',
      '',
      '● t1 claude Add the route  1 file changed',
      '    Added GET /health. All good.',
      '! t2 agy    Add the route (conflict)  conflicts in a.ts',
      '',
      'Health endpoint added with tests.',
      '',
      '  results on davecode/run-r1, nothing changed in your tree',
      '  apply with: davecode orchestrate --apply-run r1',
    ]);
    const applied = describeRun(
      plain,
      run({
        status: 'done',
        baseBranch: 'main',
        integrationBranch: 'davecode/run-r1',
        appliedAt: '2026-11-07T11:00:00.000Z',
      }),
    );
    expect(applied.at(-1)).toBe('  davecode/run-r1 applied to main');
  });

  it('lists runs on one line each', () => {
    expect(
      runListLine(
        plain,
        run({ status: 'done', appliedAt: 'x', tasks: [task({ status: 'done' }), task()] }),
      ),
    ).toBe('r1 done      1/2 tasks · 2026-11-07 10:00 · applied  Add a health endpoint');
  });

  it('exits 0 only for a done run', () => {
    expect(runExitCode(run({ status: 'done' }))).toBe(0);
    for (const status of ['failed', 'cancelled', 'running'] as const) {
      expect(runExitCode(run({ status }))).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The command, against a fake service
// ---------------------------------------------------------------------------

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

function context(json = false) {
  const io = testIO();
  return { io, ctx: createContext({ json }, io, { env: testEnv(home), cwd: repo }) };
}

/** A service whose run walks planning → running → `final` on the bus. */
function fakeService(events: EventBus, final: OrchestratorRun['status'] = 'done') {
  const runs = new Map<string, OrchestratorRun>();
  const publish = (r: OrchestratorRun) => {
    runs.set(r.id, r);
    events.emit({ type: 'orchestrator.run', run: r });
  };
  let cancelled = false;
  const service: OrchestratorService = {
    agents: vi.fn(async () => []),
    start: vi.fn(async (input) => {
      const created = run({ objective: input.objective, agents: input.agents ?? ['claude'] });
      runs.set(created.id, created);
      setTimeout(() => {
        const t = task({ status: 'running' });
        publish({ ...created, status: 'running', planner: 'claude', tasks: [t] });
        if (final === 'cancelled') return; // waits for cancel()
        publish({
          ...created,
          status: final,
          integrationBranch: 'davecode/run-r1',
          baseBranch: 'main',
          tasks: [{ ...t, status: final === 'done' ? 'done' : 'failed' }],
        });
      }, 5);
      return created;
    }),
    get: vi.fn((id: string) => runs.get(id)),
    list: vi.fn(() => [...runs.values()]),
    cancel: vi.fn((id: string) => {
      const current = runs.get(id);
      if (!current || cancelled) return false;
      cancelled = true;
      setTimeout(() => publish({ ...current, status: 'cancelled' }), 5);
      return true;
    }),
    apply: vi.fn(async (id: string) => {
      const current = runs.get(id);
      if (!current) throw new OrchestratorError('not_found', `unknown run "${id}"`);
      return { ...current, appliedAt: '2026-11-07T11:00:00.000Z' };
    }),
    close: vi.fn(async () => {}),
  };
  return service;
}

function deps(
  final: OrchestratorRun['status'] = 'done',
  interrupt: () => Promise<void> = () => new Promise(() => {}),
) {
  let service: OrchestratorService | undefined;
  const value: OrchestrateDeps = {
    service: (events, projectDir) => {
      expect(projectDir).toBe(repo);
      service = fakeService(events, final);
      return service;
    },
    interrupt,
  };
  return { deps: value, service: () => service! };
}

describe('davecode orchestrate', () => {
  it('runs to the end, prints progress on stderr and the result on stdout', async () => {
    const { io, ctx } = context();
    const fake = deps();
    const code = await orchestrateCommand(ctx, ['Add', 'health'], { agents: 'claude' }, fake.deps);
    expect(code).toBe(0);
    expect(fake.service().start).toHaveBeenCalledWith({
      objective: 'Add health',
      agents: ['claude'],
    });
    const err = io.stderr.text();
    expect(err).toContain('Run r1 started with claude. Ctrl+C cancels.');
    expect(err).toContain('t1 claude started');
    expect(err).toContain('t1 claude done');
    expect(err).not.toMatch(/https?:\/\//);
    const out = io.stdout.text();
    expect(out).toContain('r1 done');
    expect(out).toContain('davecode orchestrate --apply-run r1');
    expect(fake.service().apply).not.toHaveBeenCalled();
    expect(fake.service().close).toHaveBeenCalledOnce();
  });

  it('applies when asked and the run is done', async () => {
    const { io, ctx } = context();
    const fake = deps();
    const code = await orchestrateCommand(ctx, ['x'], { apply: true }, fake.deps);
    expect(code).toBe(0);
    expect(fake.service().apply).toHaveBeenCalledWith('r1');
    expect(io.stdout.text()).toContain('davecode/run-r1 applied to main');
  });

  it('exits 1 when the run fails', async () => {
    const { ctx } = context();
    const fake = deps('failed');
    expect(await orchestrateCommand(ctx, ['x'], { apply: true }, fake.deps)).toBe(1);
    expect(fake.service().apply).not.toHaveBeenCalled();
  });

  it('cancels on Ctrl+C, waits for the run to stop and exits 1', async () => {
    const { io, ctx } = context();
    let interrupt = () => {};
    const fake = deps('cancelled', () => new Promise((done) => (interrupt = done)));
    const pending = orchestrateCommand(ctx, ['x'], {}, fake.deps);
    await vi.waitFor(() => expect(io.stderr.text()).toContain('t1 claude started'));
    interrupt();
    expect(await pending).toBe(1);
    expect(fake.service().cancel).toHaveBeenCalledWith('r1');
    expect(io.stderr.text()).toContain('Cancelling…');
    expect(io.stdout.text()).toContain('r1 cancelled');
  });

  it('prints JSON without progress', async () => {
    const { io, ctx } = context(true);
    expect(await orchestrateCommand(ctx, ['x'], {}, deps().deps)).toBe(0);
    expect(io.stderr.text()).toBe('');
    expect(JSON.parse(io.stdout.text()).run).toMatchObject({ id: 'r1', status: 'done' });
  });

  it('explains refusals from the service', async () => {
    const { ctx } = context();
    const value: OrchestrateDeps = {
      service: (events) => {
        const service = fakeService(events);
        service.start = vi.fn(async () => {
          throw new OrchestratorError('no_agents', 'No agent CLI is installed');
        });
        return service;
      },
    };
    await expect(orchestrateCommand(ctx, ['x'], {}, value)).rejects.toMatchObject({
      name: 'CliError',
      message: 'No agent CLI is installed',
      hint: expect.stringContaining('--agents'),
    });
  });

  it('lists runs and applies one by id', async () => {
    const { io, ctx } = context();
    const fake = deps();
    await orchestrateCommand(ctx, [], { list: true }, fake.deps);
    expect(io.stdout.text()).toContain('No runs yet');

    await expect(
      orchestrateCommand(ctx, [], { applyRun: 'nope' }, deps().deps),
    ).rejects.toMatchObject({ name: 'CliError', hint: expect.stringContaining('--list') });
  });

  it('is wired into the CLI and validates its flags', async () => {
    const help = await cli(['orchestrate', '--help'], { home });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--agents <list>');
    expect(help.stdout).toContain('--apply-run <id>');
    const badAgent = await cli(['orchestrate', 'x', '--agents', 'gemini'], { home, cwd: repo });
    expect(badAgent.code).toBe(1);
    expect(badAgent.stderr).toContain('Unknown agent "gemini"');
    const badLimit = await cli(['orchestrate', 'x', '--max-tasks', '0'], { home, cwd: repo });
    expect(badLimit.code).not.toBe(0);
  });
});
