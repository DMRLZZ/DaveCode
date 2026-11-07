import { OrchestratorError, type OrchestratorRun, type OrchestratorService } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let app: FastifyInstance | undefined;
let fixture: TestEngine | undefined;
afterEach(async () => {
  await app?.close();
  fixture?.cleanup();
  app = undefined;
  fixture = undefined;
});

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

function service(overrides: Partial<OrchestratorService> = {}): OrchestratorService {
  const runs = new Map<string, OrchestratorRun>([
    ['r1', run({ status: 'running' })],
    ['r0', run({ id: 'r0', status: 'done', integrationBranch: 'davecode/run-r0' })],
  ]);
  return {
    agents: vi.fn(async () => [
      { agent: 'claude' as const, available: true },
      { agent: 'codex' as const, available: false },
      { agent: 'agy' as const, available: true },
    ]),
    start: vi.fn(async (input) =>
      run({ id: 'r2', objective: input.objective, agents: input.agents ?? ['claude'] }),
    ),
    get: vi.fn((id: string) => runs.get(id)),
    list: vi.fn(() => [...runs.values()]),
    cancel: vi.fn((id: string) => runs.get(id)?.status === 'running'),
    apply: vi.fn(async (id: string) => {
      const found = runs.get(id);
      if (!found) throw new OrchestratorError('not_found', `unknown run "${id}"`);
      return { ...found, appliedAt: '2026-11-07T11:00:00.000Z' };
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

async function setup(orchestrator?: OrchestratorService, authToken?: string) {
  fixture = makeTestEngine(authToken ? { server: { authToken } } : undefined);
  app = await buildGateway(fixture.engine, {
    login: false,
    ...(orchestrator ? { orchestrator } : {}),
  });
  return app;
}

const json = { 'content-type': 'application/json' };

describe('/api/orchestrator', () => {
  it('does not exist when the host gave the gateway no orchestrator', async () => {
    const gateway = await setup();
    for (const url of ['/api/orchestrator/agents', '/api/orchestrator/runs']) {
      const response = await gateway.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
    }
    const start = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs',
      headers: json,
      payload: { objective: 'x' },
    });
    expect(start.statusCode).toBe(404);
  });

  it('lists agent availability uncached', async () => {
    const gateway = await setup(service());
    const response = await gateway.inject('/api/orchestrator/agents');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().agents).toEqual([
      { agent: 'claude', available: true },
      { agent: 'codex', available: false },
      { agent: 'agy', available: true },
    ]);
  });

  it('lists runs and reads one, uncached', async () => {
    const gateway = await setup(service());
    const list = await gateway.inject('/api/orchestrator/runs');
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().runs.map((r: OrchestratorRun) => r.id)).toEqual(['r1', 'r0']);
    const one = await gateway.inject('/api/orchestrator/runs/r0');
    expect(one.statusCode).toBe(200);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.json()).toMatchObject({ id: 'r0', status: 'done' });
    const missing = await gateway.inject('/api/orchestrator/runs/nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });

  it('starts a run with a validated body and records it', async () => {
    const orchestrator = service();
    const gateway = await setup(orchestrator);
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs',
      headers: json,
      payload: { objective: '  Add a health endpoint  ', agents: ['codex'], maxTasks: 3 },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: 'r2', status: 'planning', agents: ['codex'] });
    expect(orchestrator.start).toHaveBeenCalledWith({
      objective: 'Add a health endpoint',
      agents: ['codex'],
      maxTasks: 3,
    });
    const audit = fixture?.engine.audit.list({ limit: 5 }) ?? [];
    expect(audit.some((e) => e.action === 'orchestrator.start' && e.target === 'r2')).toBe(true);
  });

  it('rejects invalid bodies before reaching the service', async () => {
    const orchestrator = service();
    const gateway = await setup(orchestrator);
    const bodies: unknown[] = [
      undefined,
      {},
      { objective: '   ' },
      { objective: 'x'.repeat(4001) },
      { objective: 'ok', agents: [] },
      { objective: 'ok', agents: ['gemini'] },
      { objective: 'ok', maxTasks: 0 },
      { objective: 'ok', maxTasks: 9 },
      { objective: 'ok', maxTasks: 2.5 },
    ];
    for (const payload of bodies) {
      const response = await gateway.inject({
        method: 'POST',
        url: '/api/orchestrator/runs',
        headers: json,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code).toBe('invalid_body');
    }
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it.each([
    ['no_agents', 409],
    ['not_a_repository', 409],
    ['busy', 409],
  ] as const)('maps a %s refusal to %i with its code and message', async (code, status) => {
    const start = vi.fn(async () => {
      throw new OrchestratorError(code, `refused: ${code}`);
    });
    const gateway = await setup(service({ start }));
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs',
      headers: json,
      payload: { objective: 'Add a health endpoint' },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code, message: `refused: ${code}` } });
  });

  it('hides unexpected failures behind a 500', async () => {
    const start = vi.fn(async () => {
      throw new Error('EACCES C:\\secret\\path');
    });
    const gateway = await setup(service({ start }));
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs',
      headers: json,
      payload: { objective: 'Add a health endpoint' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });

  it('cancels an active run, 404s an unknown one and 409s one that is over', async () => {
    const orchestrator = service();
    const gateway = await setup(orchestrator);
    const cancel = (id: string) =>
      gateway.inject({ method: 'POST', url: `/api/orchestrator/runs/${id}/cancel`, headers: json });
    const active = await cancel('r1');
    expect(active.statusCode).toBe(204);
    expect(active.body).toBe('');
    const unknown = await cancel('nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');
    const over = await cancel('r0');
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toEqual({ code: 'not_active', message: 'run "r0" is already done' });
    expect(orchestrator.cancel).toHaveBeenCalledTimes(3);
  });

  it('applies a run and maps not_found / not_appliable', async () => {
    const apply = vi.fn(async (id: string) => {
      if (id === 'r0') return run({ id: 'r0', status: 'done', appliedAt: 'now' });
      if (id === 'r1') throw new OrchestratorError('not_appliable', 'the run is still running');
      throw new OrchestratorError('not_found', `unknown run "${id}"`);
    });
    const gateway = await setup(service({ apply }));
    const post = (id: string) =>
      gateway.inject({ method: 'POST', url: `/api/orchestrator/runs/${id}/apply`, headers: json });
    const applied = await post('r0');
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ id: 'r0', appliedAt: 'now' });
    const refused = await post('r1');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toEqual({
      code: 'not_appliable',
      message: 'the run is still running',
    });
    const missing = await post('nope');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });

  it('recognises an OrchestratorError from another copy of core', async () => {
    const apply = vi.fn(async () => {
      throw Object.assign(new Error('dirty tree'), {
        name: 'OrchestratorError',
        code: 'not_appliable',
      });
    });
    const gateway = await setup(service({ apply }));
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs/r0/apply',
      headers: json,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('not_appliable');
  });

  it('needs the gateway token on every route', async () => {
    const orchestrator = service();
    const gateway = await setup(orchestrator, 'api-token');
    const requests = [
      { method: 'GET' as const, url: '/api/orchestrator/agents' },
      { method: 'GET' as const, url: '/api/orchestrator/runs' },
      { method: 'GET' as const, url: '/api/orchestrator/runs/r1' },
      { method: 'POST' as const, url: '/api/orchestrator/runs', payload: { objective: 'x' } },
      { method: 'POST' as const, url: '/api/orchestrator/runs/r1/cancel' },
      { method: 'POST' as const, url: '/api/orchestrator/runs/r0/apply' },
    ];
    for (const request of requests) {
      const response = await gateway.inject({ ...request, headers: json });
      expect(response.statusCode, request.url).toBe(401);
    }
    expect(orchestrator.agents).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(orchestrator.apply).not.toHaveBeenCalled();
    const allowed = await gateway.inject({
      url: '/api/orchestrator/runs',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects writes from another origin and without a JSON body', async () => {
    const orchestrator = service();
    const gateway = await setup(orchestrator);
    const foreign = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs/r1/cancel',
      headers: { ...json, origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    const form = await gateway.inject({
      method: 'POST',
      url: '/api/orchestrator/runs',
      headers: { 'content-type': 'text/plain' },
      payload: '{"objective":"x"}',
    });
    expect(form.statusCode).toBe(415);
    expect(orchestrator.cancel).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it('streams orchestrator events over /api/events', async () => {
    const gateway = await setup(service());
    const events = fixture?.engine.events;
    events?.emit({ type: 'orchestrator.run', run: run() });
    events?.emit({
      type: 'orchestrator.output',
      runId: 'r1',
      taskId: 'plan',
      output: { kind: 'tool', text: 'Read src/index.ts' },
    });
    // The stream never ends on its own: read the replayed frames, then disconnect.
    const address = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    let text = '';
    const decoder = new TextDecoder();
    while (reader && !text.includes('event: orchestrator.output')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    expect(text).toContain('event: orchestrator.run');
    expect(text).toContain('event: orchestrator.output');
    expect(text).toContain('Read src/index.ts');
  });
});
