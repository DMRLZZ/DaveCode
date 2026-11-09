import { ChangesError, type ChangesService, type ChangesWorkspace } from '@davecode/core';
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

function workspace(overrides: Partial<ChangesWorkspace> = {}): ChangesWorkspace {
  return {
    id: 'main',
    label: 'project',
    isolated: false,
    path: '/work/project',
    branch: 'main',
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 1, binary: false }],
    additions: 1,
    deletions: 1,
    dirty: true,
    ahead: 0,
    unpushed: 0,
    hasRemote: true,
    ...overrides,
  };
}

function service(overrides: Partial<ChangesService> = {}): ChangesService {
  return {
    list: vi.fn(async () => [workspace(), workspace({ id: 'abc123', isolated: true })]),
    get: vi.fn(async (id: string) => {
      if (id !== 'main') throw new ChangesError('not_found', `unknown workspace "${id}"`);
      return workspace();
    }),
    create: vi.fn(async (input) =>
      workspace({ id: 'abc123', isolated: true, label: input?.label ?? 'Isolated' }),
    ),
    diff: vi.fn(async () => ({ patch: 'diff --git a/a.ts b/a.ts\n', truncated: false })),
    suggest: vi.fn(async () => ({
      message: 'chore: update a.ts',
      title: 't',
      body: 'b',
      by: 'davecode' as const,
    })),
    ship: vi.fn(async () => ({
      ok: true,
      steps: [{ phase: 'commit' as const, ok: true, detail: 'Committed abc1234' }],
      commit: 'abc1234',
      workspace: workspace({ dirty: false, files: [] }),
    })),
    merge: vi.fn(async () => workspace()),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

async function setup(changes?: ChangesService, authToken?: string) {
  fixture = makeTestEngine(authToken ? { server: { authToken } } : undefined);
  app = await buildGateway(fixture.engine, { login: false, ...(changes ? { changes } : {}) });
  return app;
}

const json = { 'content-type': 'application/json' };

describe('/api/changes', () => {
  it('does not exist when the host gave the gateway no changes service', async () => {
    const gateway = await setup();
    const res = await gateway.inject({ method: 'GET', url: '/api/changes/workspaces' });
    expect(res.statusCode).toBe(404);
  });

  it('lists workspaces without caching', async () => {
    const gateway = await setup(service());
    const res = await gateway.inject({ method: 'GET', url: '/api/changes/workspaces' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().workspaces.map((w: ChangesWorkspace) => w.id)).toEqual(['main', 'abc123']);
  });

  it('creates an isolated workspace and records it', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces',
      headers: json,
      payload: { label: 'Codex' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'abc123', label: 'Codex' });
    expect(fixture?.engine.audit.list().some((e) => e.action === 'changes.create')).toBe(true);
  });

  it('accepts an empty JSON body where every field is optional', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces',
      headers: json,
    });
    expect(res.statusCode).toBe(201);
    expect(changes.create).toHaveBeenCalledWith({});
  });

  it('maps service refusals to the error envelope', async () => {
    const gateway = await setup(
      service({
        merge: vi.fn(async () => {
          throw new ChangesError('conflict', 'The merge conflicts in a.ts. Nothing was changed.');
        }),
      }),
    );
    const missing = await gateway.inject({ method: 'GET', url: '/api/changes/workspaces/zzzz99' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    const conflict = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces/abc123/merge',
      headers: json,
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toEqual({
      code: 'conflict',
      message: 'The merge conflicts in a.ts. Nothing was changed.',
    });
  });

  it('rejects ids that are not workspace ids before reaching the service', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/changes/workspaces/..%2F..%2Fetc/diff',
    });
    expect(res.statusCode).toBe(404);
    expect(changes.diff).not.toHaveBeenCalled();
  });

  it('returns a diff, optionally for one file', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/changes/workspaces/main/diff?path=a.ts',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ patch: 'diff --git a/a.ts b/a.ts\n', truncated: false });
    expect(changes.diff).toHaveBeenCalledWith('main', 'a.ts');
  });

  it('validates ship bodies and audits the steps', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const bad = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces/main/ship',
      headers: json,
      payload: { pr: { title: '' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_body');
    const ok = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces/main/ship',
      headers: json,
      payload: { message: 'fix: a', push: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, commit: 'abc1234' });
    expect(changes.ship).toHaveBeenCalledWith('main', { message: 'fix: a', push: true });
    const entry = fixture?.engine.audit.list().find((e) => e.action === 'changes.ship');
    expect(entry?.details).toEqual({ ok: true, steps: ['commit:ok'] });
  });

  it('suggests with the chosen agent', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/changes/workspaces/main/suggest',
      headers: json,
      payload: { agent: 'claude' },
    });
    expect(res.statusCode).toBe(200);
    expect(changes.suggest).toHaveBeenCalledWith('main', { agent: 'claude' });
  });

  it('removes a workspace, keeping its branch unless asked', async () => {
    const changes = service();
    const gateway = await setup(changes);
    const kept = await gateway.inject({
      method: 'DELETE',
      url: '/api/changes/workspaces/abc123',
      headers: json,
    });
    expect(kept.statusCode).toBe(204);
    expect(changes.remove).toHaveBeenLastCalledWith('abc123', { deleteBranch: false });
    await gateway.inject({
      method: 'DELETE',
      url: '/api/changes/workspaces/abc123?deleteBranch=true',
      headers: json,
    });
    expect(changes.remove).toHaveBeenLastCalledWith('abc123', { deleteBranch: true });
  });

  it('needs the gateway token like every /api route', async () => {
    const gateway = await setup(service(), 'secret-token');
    const res = await gateway.inject({ method: 'GET', url: '/api/changes/workspaces' });
    expect(res.statusCode).toBe(401);
  });
});
