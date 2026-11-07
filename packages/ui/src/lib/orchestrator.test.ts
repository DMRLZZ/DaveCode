import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  appendOutput,
  applyOrchestratorEvent,
  applyOrchestratorRun,
  availableAgents,
  canApply,
  cancelOrchestratorRun,
  defaultTaskId,
  EMPTY_ORCHESTRATOR_STATE,
  fetchOrchestratorAgents,
  getOrchestratorRun,
  hydrateRuns,
  isOrchestratorEvent,
  listOrchestratorRuns,
  MAX_OUTPUT_LINES,
  type OrchestratorState,
  OrchestratorStore,
  orchestratorOffered,
  outputLines,
  planElapsedMs,
  planStatus,
  sortedRuns,
  startOrchestratorRun,
  startRequest,
  taskElapsedMs,
  toggleAgent,
} from './orchestrator';
import type { AgentOutput, DaveEvent, OrchestratorRun, OrchestratorTask } from './types';

function task(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: 't1',
    title: 'Add the endpoint',
    agent: 'claude',
    prompt: 'Add it',
    dependsOn: [],
    status: 'pending',
    ...overrides,
  };
}

function run(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: 'r1',
    objective: 'Ship the feature',
    status: 'running',
    agents: ['claude', 'codex'],
    planner: 'claude',
    baseBranch: 'main',
    baseCommit: 'abc123',
    integrationBranch: 'davecode/run-r1',
    tasks: [task()],
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:05.000Z',
    ...overrides,
  };
}

const runEvent = (r: OrchestratorRun): DaveEvent => ({ type: 'orchestrator.run', run: r, ts: 1 });
const outputEvent = (taskId: string, output: AgentOutput, runId = 'r1'): DaveEvent => ({
  type: 'orchestrator.output',
  runId,
  taskId,
  output,
  ts: 1,
});

function feed(events: DaveEvent[], state: OrchestratorState = EMPTY_ORCHESTRATOR_STATE) {
  return events.reduce(applyOrchestratorEvent, state);
}

const texts = (state: OrchestratorState, taskId = 't1') =>
  outputLines(state, 'r1', taskId).map((l) => l.text);

afterEach(() => vi.unstubAllGlobals());

describe('orchestrator HTTP client', () => {
  it('lists agents with the token and treats 404 as no orchestrator', async () => {
    const agents = [
      { agent: 'claude', available: true },
      { agent: 'codex', available: false },
    ];
    const fetcher = vi.fn(async () => Response.json({ agents }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchOrchestratorAgents('http://gw/', 'tok')).toEqual(agents);
    expect(fetcher).toHaveBeenCalledWith('http://gw/api/orchestrator/agents', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer tok' },
      cache: 'no-store',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code: 'not_found', message: 'x' } }, { status: 404 }),
      ),
    );
    expect(await fetchOrchestratorAgents('', '')).toBeNull();
  });

  it('treats an unreachable gateway or an odd payload as no orchestrator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await fetchOrchestratorAgents('', '')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ agents: [{ agent: 'gemini', available: true }] })),
    );
    expect(await fetchOrchestratorAgents('', '')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200 })),
    );
    expect(await fetchOrchestratorAgents('', '')).toBeNull();
  });

  it('lists runs and rejects a malformed list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ runs: [run()] })),
    );
    expect(await listOrchestratorRuns('', '')).toEqual([run()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ runs: [{ id: 1 }] })),
    );
    await expect(listOrchestratorRuns('', '')).rejects.toBeInstanceOf(ApiError);
  });

  it('starts a run with a JSON body and accepts the run bare or in an envelope', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ run: run({ status: 'planning' }) }, { status: 202 }),
    );
    vi.stubGlobal('fetch', fetcher);
    const started = await startOrchestratorRun('http://gw', 'tok', {
      objective: 'Ship it',
      agents: ['claude'],
    });
    expect(started.status).toBe('planning');
    expect(fetcher).toHaveBeenCalledWith('http://gw/api/orchestrator/runs', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ objective: 'Ship it', agents: ['claude'] }),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(run({ id: 'r9' }))),
    );
    expect((await getOrchestratorRun('', '', 'r9')).id).toBe('r9');
  });

  it("surfaces the server's message on 409 and 400", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'busy', message: 'A run is already active in this project.' } },
          { status: 409 },
        ),
      ),
    );
    const err = await startOrchestratorRun('', '', { objective: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'busy',
      message: 'A run is already active in this project.',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'invalid_request', message: 'objective is required' } },
          { status: 400 },
        ),
      ),
    );
    await expect(startOrchestratorRun('', '', { objective: '' })).rejects.toThrow(
      'objective is required',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 409 })),
    );
    await expect(applyOrchestratorRun('', '', 'r1')).rejects.toMatchObject({
      status: 409,
      code: 'http_409',
    });
  });

  it('cancels with 204 and encodes the run id', async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(cancelOrchestratorRun('', '', 'a/b')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/orchestrator/runs/a%2Fb/cancel');
  });

  it('applies and returns the updated run', async () => {
    const applied = run({ status: 'done', appliedAt: '2026-11-07T11:00:00.000Z' });
    const fetcher = vi.fn(async (_url: string) => Response.json({ run: applied }));
    vi.stubGlobal('fetch', fetcher);
    expect(await applyOrchestratorRun('', '', 'r1')).toEqual(applied);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/orchestrator/runs/r1/apply');
  });
});

describe('applyOrchestratorEvent', () => {
  it('keeps runs by id and lets each snapshot replace the last', () => {
    const state = feed([
      runEvent(run({ status: 'planning', tasks: [] })),
      runEvent(run({ id: 'r2' })),
      runEvent(run({ status: 'done' })),
    ]);
    expect(Object.keys(state.runs).sort()).toEqual(['r1', 'r2']);
    expect(state.runs.r1?.status).toBe('done');
    expect(state.runs.r1?.tasks).toHaveLength(1);
  });

  it('ignores unrelated and malformed events without copying the state', () => {
    const state = feed([runEvent(run())]);
    const unrelated: DaveEvent = { type: 'log', level: 'info', scope: 'x', message: 'y', ts: 1 };
    expect(applyOrchestratorEvent(state, unrelated)).toBe(state);
    expect(
      applyOrchestratorEvent(state, { type: 'orchestrator.run', ts: 1 } as unknown as DaveEvent),
    ).toBe(state);
    expect(
      applyOrchestratorEvent(state, {
        type: 'orchestrator.output',
        runId: 'r1',
        taskId: 't1',
        ts: 1,
      } as unknown as DaveEvent),
    ).toBe(state);
    expect(isOrchestratorEvent(unrelated)).toBe(false);
    expect(isOrchestratorEvent(runEvent(run()))).toBe(true);
  });

  it('coalesces text chunks into one line until a newline', () => {
    const state = feed([
      outputEvent('t1', { kind: 'text', text: 'Hel' }),
      outputEvent('t1', { kind: 'text', text: 'lo, ' }),
      outputEvent('t1', { kind: 'text', text: 'world\nsecond' }),
      outputEvent('t1', { kind: 'text', text: ' line\n' }),
      outputEvent('t1', { kind: 'text', text: 'third' }),
    ]);
    expect(texts(state)).toEqual(['Hello, world', 'second line', 'third']);
  });

  it('keeps blank lines, normalises CRLF and ignores empty chunks', () => {
    const state = feed([
      outputEvent('t1', { kind: 'text', text: 'a\r\n\r\nb' }),
      outputEvent('t1', { kind: 'text', text: '' }),
      outputEvent('t1', { kind: 'text', text: 'c\n' }),
      outputEvent('t1', { kind: 'text', text: '\n' }),
    ]);
    expect(texts(state)).toEqual(['a', '', 'bc', '']);
  });

  it('gives tool, status and error chunks a line of their own and closes open text', () => {
    const state = feed([
      outputEvent('t1', { kind: 'text', text: 'thinking' }),
      outputEvent('t1', { kind: 'tool', text: 'edit src/a.ts\n' }),
      outputEvent('t1', { kind: 'text', text: 'done' }),
      outputEvent('t1', { kind: 'error', text: 'boom' }),
      outputEvent('t1', { kind: 'status', text: '' }),
    ]);
    expect(outputLines(state, 'r1', 't1').map((l) => [l.kind, l.text])).toEqual([
      ['text', 'thinking'],
      ['tool', 'edit src/a.ts'],
      ['text', 'done'],
      ['error', 'boom'],
    ]);
  });

  it('keeps output per run and task, the planner under "plan"', () => {
    const state = feed([
      outputEvent('plan', { kind: 'text', text: 'planning\n' }),
      outputEvent('t1', { kind: 'text', text: 'one' }),
      outputEvent('t1', { kind: 'text', text: 'other run' }, 'r2'),
      outputEvent('t2', { kind: 'text', text: 'two' }),
    ]);
    expect(texts(state, 'plan')).toEqual(['planning']);
    expect(texts(state, 't1')).toEqual(['one']);
    expect(texts(state, 't2')).toEqual(['two']);
    expect(outputLines(state, 'r2', 't1').map((l) => l.text)).toEqual(['other run']);
    expect(outputLines(state, 'nope', 't1')).toEqual([]);
  });

  it(`caps each stream at ${MAX_OUTPUT_LINES} lines with stable ids`, () => {
    const events = Array.from({ length: MAX_OUTPUT_LINES + 20 }, (_, i) =>
      outputEvent('t1', { kind: 'status', text: `line ${i}` }),
    );
    const lines = outputLines(feed(events), 'r1', 't1');
    expect(lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(lines[0]).toEqual({ id: 20, kind: 'status', text: 'line 20' });
    expect(lines.at(-1)?.text).toBe(`line ${MAX_OUTPUT_LINES + 19}`);
  });

  it('caps a single chunk with many lines', () => {
    const big = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n');
    const stream = appendOutput({ lines: [], open: false, next: 0 }, { kind: 'text', text: big });
    expect(stream.lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(stream.lines.at(-1)?.text).toBe('l599');
    expect(stream.open).toBe(true);
  });
});

describe('hydrateRuns and sortedRuns', () => {
  it('never lets an older HTTP copy replace a newer snapshot', () => {
    const fresh = feed([runEvent(run({ status: 'done', updatedAt: '2026-11-07T10:10:00.000Z' }))]);
    const hydrated = hydrateRuns(fresh, [
      run({ status: 'running', updatedAt: '2026-11-07T10:05:00.000Z' }),
      run({ id: 'r0', createdAt: '2026-11-06T09:00:00.000Z' }),
    ]);
    expect(hydrated.runs.r1?.status).toBe('done');
    expect(hydrated.runs.r0).toBeDefined();
    expect(hydrateRuns(hydrated, [])).toBe(hydrated);
  });

  it('sorts newest first', () => {
    const state = hydrateRuns(EMPTY_ORCHESTRATOR_STATE, [
      run({ id: 'old', createdAt: '2026-11-01T00:00:00.000Z' }),
      run({ id: 'new', createdAt: '2026-11-07T00:00:00.000Z' }),
      run({ id: 'mid', createdAt: '2026-11-03T00:00:00.000Z' }),
    ]);
    expect(sortedRuns(state).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('OrchestratorStore', () => {
  it('coalesces a burst of events into one notification', () => {
    vi.useFakeTimers();
    try {
      const store = new OrchestratorStore(50);
      const listener = vi.fn();
      store.subscribe(listener);
      store.ingest(runEvent(run()) as Extract<DaveEvent, { type: 'orchestrator.run' }>);
      for (let i = 0; i < 10; i += 1) {
        store.ingest(
          outputEvent('t1', { kind: 'text', text: 'x' }) as Extract<
            DaveEvent,
            { type: 'orchestrator.output' }
          >,
        );
      }
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(texts(store.getState())).toEqual(['xxxxxxxxxx']);
      store.upsert(run({ status: 'done', updatedAt: '2026-11-07T11:00:00.000Z' }));
      expect(store.getState().runs.r1?.status).toBe('done');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('view helpers', () => {
  const agents = [
    { agent: 'claude' as const, available: true },
    { agent: 'codex' as const, available: false },
    { agent: 'agy' as const, available: true },
  ];

  it('offers the orchestrator only with at least one installed agent', () => {
    expect(orchestratorOffered(null)).toBe(false);
    expect(orchestratorOffered([])).toBe(false);
    expect(orchestratorOffered([{ agent: 'codex', available: false }])).toBe(false);
    expect(orchestratorOffered(agents)).toBe(true);
    expect(availableAgents(agents)).toEqual(['claude', 'agy']);
  });

  it('toggles agents in canonical order', () => {
    expect(toggleAgent(['agy'], 'claude')).toEqual(['claude', 'agy']);
    expect(toggleAgent(['claude', 'agy'], 'claude')).toEqual(['agy']);
  });

  it('builds the start request from installed, selected agents only', () => {
    expect(startRequest('  Ship it ', ['claude', 'codex'], agents)).toEqual({
      objective: 'Ship it',
      agents: ['claude'],
    });
    expect(startRequest('   ', ['claude'], agents)).toBeNull();
    expect(startRequest('Ship it', ['codex'], agents)).toBeNull();
  });

  it('only applies finished, unapplied runs with an integration branch', () => {
    expect(canApply(run({ status: 'done' }))).toBe(true);
    expect(canApply(run({ status: 'running' }))).toBe(false);
    expect(canApply(run({ status: 'done', appliedAt: '2026-11-07T11:00:00.000Z' }))).toBe(false);
    expect(canApply(run({ status: 'done', integrationBranch: undefined }))).toBe(false);
  });

  it('derives the plan row and the default selection', () => {
    expect(planStatus(run({ status: 'planning', tasks: [] }))).toBe('running');
    expect(planStatus(run({ status: 'failed', tasks: [] }))).toBe('failed');
    expect(planStatus(run({ status: 'cancelled', tasks: [] }))).toBe('cancelled');
    expect(planStatus(run({ status: 'failed' }))).toBe('done');
    expect(defaultTaskId(run({ status: 'planning', tasks: [] }))).toBe('plan');
    expect(
      defaultTaskId(
        run({ tasks: [task(), task({ id: 't2', status: 'running' }), task({ id: 't3' })] }),
      ),
    ).toBe('t2');
    expect(defaultTaskId(run({ status: 'done', tasks: [task({ status: 'done' })] }))).toBe('t1');
  });

  it('measures elapsed time for tasks and the planner', () => {
    const now = Date.parse('2026-11-07T10:01:00.000Z');
    expect(taskElapsedMs(task(), now)).toBeUndefined();
    expect(taskElapsedMs(task({ startedAt: '2026-11-07T10:00:30.000Z' }), now)).toBe(30_000);
    expect(
      taskElapsedMs(
        task({ startedAt: '2026-11-07T10:00:30.000Z', finishedAt: '2026-11-07T10:00:40.000Z' }),
        now,
      ),
    ).toBe(10_000);
    expect(planElapsedMs(run({ status: 'planning', tasks: [] }), now)).toBe(60_000);
    expect(
      planElapsedMs(run({ tasks: [task({ startedAt: '2026-11-07T10:00:20.000Z' })] }), now),
    ).toBe(20_000);
  });
});
