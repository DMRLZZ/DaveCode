import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGoalService,
  type DaveEvent,
  type Goal,
  type GoalService,
  ProjectBrain,
  WorkspaceLock,
} from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;
let root: string;
let service: GoalService;
let lock: WorkspaceLock;

const PLAN = JSON.stringify({
  summary: 'two steps',
  tasks: [
    { id: 'research', title: 'Research the market', role: 'researcher' },
    { id: 'copy', title: 'Write the landing copy', role: 'writer', dependsOn: ['research'] },
  ],
});

async function setup(): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'davecode-api-goals-'));
  t = makeTestEngine({
    routing: {
      routes: [{ name: 'auto', targets: [{ provider: 'openai', model: 'openai-model' }] }],
    },
  });
  const brain = await ProjectBrain.init(root, { events: t.engine.events, name: 'demo' });
  lock = new WorkspaceLock();
  service = createGoalService(t.engine, { brain, lock });
  app = await buildGateway(t.engine, { goals: service });
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('/api/goals', () => {
  it('answers 501 when goal mode is not wired', async () => {
    t = makeTestEngine();
    app = await buildGateway(t.engine, {});
    const res = await app.inject({ method: 'GET', url: '/api/goals' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('goals_unavailable');
  });

  it('validates the body', async () => {
    await setup();
    for (const payload of [
      {},
      { objective: '  ' },
      { objective: 'x', extra: 1 },
      { objective: 'x', maxRounds: 0 },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/goals', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
    }
  });

  it('starts a dry-run goal, streams goal events and lists it', async () => {
    await setup();
    const account = t.engine.accounts.create({ provider: 'openai', label: 'a' });
    t.fake('openai').script(account.id, { type: 'complete', content: PLAN });
    const seen: DaveEvent[] = [];
    t.engine.events.subscribe((e) => seen.push(e));

    const res = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: { objective: 'Launch a landing page', dryRun: true },
    });
    expect(res.statusCode).toBe(202);
    const started = res.json().goal as Goal;
    expect(started).toMatchObject({ objective: 'Launch a landing page', dryRun: true });

    const done = await service.wait(started.id);
    expect(done?.lastError).toBeUndefined();
    expect(done).toMatchObject({ status: 'planned', summary: 'two steps' });
    expect(done?.tasks.map((x) => x.id)).toEqual(['research', 'copy']);
    expect(seen.some((e) => e.type === 'goal.updated' && e.goal.status === 'planned')).toBe(true);

    const one = await app.inject({ method: 'GET', url: `/api/goals/${started.id}` });
    expect(one.json().goal.status).toBe('planned');
    const list = await app.inject({ method: 'GET', url: '/api/goals' });
    expect(list.json().goals.map((g: Goal) => g.id)).toEqual([started.id]);
    expect(t.engine.audit.list({ limit: 5 }).some((e) => e.action === 'goal.start')).toBe(true);
  });

  it('answers 409 busy while the runner holds the working tree, and 404 for unknown goals', async () => {
    await setup();
    lock.acquire('runner');
    const busy = await app.inject({
      method: 'POST',
      url: '/api/goals',
      payload: { objective: 'x' },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('busy');

    const missing = await app.inject({ method: 'GET', url: '/api/goals/goal_000000' });
    expect(missing.statusCode).toBe(404);
    const cancel = await app.inject({ method: 'POST', url: '/api/goals/goal_000000/cancel' });
    expect(cancel.statusCode).toBe(404);
    expect(cancel.json().error.code).toBe('not_found');
  });
});
