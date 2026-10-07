import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DaveEvent,
  ProjectBrain,
  ProjectBrainSource,
  type TaskGraph,
  type TaskNode,
} from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from './gateway';
import type { BrainSource } from './options';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine;
let app: FastifyInstance;
let root: string;
let brain: ProjectBrain;
let seen: DaveEvent[];

const node = (id: string, patch: Partial<TaskNode> = {}): TaskNode => ({
  id,
  title: `Task ${id}`,
  status: 'PENDING',
  dependsOn: [],
  ...patch,
});

async function setup(graph: TaskGraph = { version: 1, tasks: [] }): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'davecode-api-tasks-'));
  t = makeTestEngine();
  brain = await ProjectBrain.init(root, { events: t.engine.events, name: 'demo' });
  await brain.writeGraph(graph);
  app = await buildGateway(t.engine, { brain: new ProjectBrainSource(brain) });
  seen = [];
  t.engine.events.subscribe((e) => seen.push(e));
}

afterEach(async () => {
  await app?.close();
  t?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/tasks', payload });
const patch = (id: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/tasks/${id}`, payload });
const del = (id: string) => app.inject({ method: 'DELETE', url: `/api/tasks/${id}` });

describe('POST /api/tasks', () => {
  it('creates a PENDING task, persists it and emits task.updated', async () => {
    await setup({ version: 1, tasks: [node('a')] });
    const res = await post({
      id: 'b',
      title: '  Build B ',
      description: 'details',
      dependsOn: ['a'],
      priority: 5,
      acceptance: ['it works'],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().task).toMatchObject({
      id: 'b',
      title: 'Build B',
      status: 'PENDING',
      dependsOn: ['a'],
      priority: 5,
      acceptance: ['it works'],
      createdAt: expect.any(String),
    });
    expect((await brain.readGraph()).tasks.map((x) => x.id)).toEqual(['a', 'b']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/tasks' })).json().graph.tasks,
    ).toHaveLength(2);
    expect(seen.find((e) => e.type === 'task.updated')).toMatchObject({ task: { id: 'b' } });
  });

  it('validates the body', async () => {
    await setup();
    for (const payload of [
      {},
      { id: 'Bad Id', title: 'x' },
      { id: 'ok', title: '   ' },
      { id: 'ok', title: 'x', status: 'SUCCESS' },
      { id: 'ok', title: 'x', priority: 'high' },
      { id: 'ok', title: 'x', dependsOn: 'a' },
    ]) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
    }
    expect((await brain.readGraph()).tasks).toEqual([]);
  });

  it('409 duplicate_id, 400 unknown_dependency', async () => {
    await setup({ version: 1, tasks: [node('a')] });
    const dup = await post({ id: 'a', title: 'again' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('duplicate_id');
    const unknown = await post({ id: 'z', title: 'Z', dependsOn: ['ghost'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('unknown_dependency');
    expect((await brain.readGraph()).tasks).toHaveLength(1);
  });

  it('400 self_dependency', async () => {
    await setup();
    const res = await post({ id: 'z', title: 'Z', dependsOn: ['z'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('self_dependency');
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('edits fields and clears optional ones with null', async () => {
    await setup({
      version: 1,
      tasks: [node('a'), node('b', { description: 'old', priority: 9, notes: 'n' })],
    });
    const res = await patch('b', {
      title: 'New title',
      dependsOn: ['a'],
      acceptance: ['x', 'y'],
      description: null,
      priority: null,
      notes: 'fresh',
    });
    expect(res.statusCode).toBe(200);
    const task = res.json().task;
    expect(task).toMatchObject({
      id: 'b',
      title: 'New title',
      dependsOn: ['a'],
      acceptance: ['x', 'y'],
      notes: 'fresh',
    });
    expect(task).not.toHaveProperty('description');
    expect(task).not.toHaveProperty('priority');
    expect((await brain.readGraph()).tasks[1]).toEqual(task);
    expect(seen.filter((e) => e.type === 'task.updated')).toHaveLength(1);
  });

  it('follows the allowed status transitions', async () => {
    await setup({ version: 1, tasks: [node('a')] });
    const bad = await patch('a', { status: 'SUCCESS' });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('invalid_transition');
    expect((await brain.readGraph()).tasks[0]?.status).toBe('PENDING');

    const started = await patch('a', { status: 'IN_PROGRESS' });
    expect(started.json().task).toMatchObject({ status: 'IN_PROGRESS', attempts: 1 });
    expect((await patch('a', { status: 'FAILED', notes: 'broke' })).json().task).toMatchObject({
      status: 'FAILED',
      notes: 'broke',
    });
    expect((await patch('a', { status: 'PENDING' })).json().task.status).toBe('PENDING');
  });

  it('400 cycle carries the cycle path', async () => {
    await setup({ version: 1, tasks: [node('a'), node('b', { dependsOn: ['a'] })] });
    const res = await patch('a', { dependsOn: ['b'] });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('cycle');
    expect(error.cycle).toEqual(['a', 'b', 'a']);
    expect(error.message).toContain('a → b → a');
    expect((await brain.readGraph()).tasks[0]?.dependsOn).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it('400 on unknown dependency, 404 on unknown task, 400 on empty or unknown fields', async () => {
    await setup({ version: 1, tasks: [node('a')] });
    expect((await patch('a', { dependsOn: ['ghost'] })).json().error.code).toBe(
      'unknown_dependency',
    );
    const missing = await patch('nope', { title: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    for (const payload of [{}, { id: 'other' }, { status: 'DONE' }, { title: '' }]) {
      const res = await patch('a', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
    }
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('removes a task with no dependents and emits task.removed', async () => {
    await setup({ version: 1, tasks: [node('a'), node('b', { dependsOn: ['a'] })] });
    const res = await del('b');
    expect(res.statusCode).toBe(204);
    expect((await brain.readGraph()).tasks.map((x) => x.id)).toEqual(['a']);
    expect(seen.find((e) => e.type === 'task.removed')).toMatchObject({ taskId: 'b' });
  });

  it('409 has_dependents names the dependents and keeps the task', async () => {
    await setup({
      version: 1,
      tasks: [node('a'), node('b', { dependsOn: ['a'] }), node('c', { dependsOn: ['a'] })],
    });
    const res = await del('a');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'has_dependents', dependents: ['b', 'c'] });
    expect(res.json().error.message).toContain('"b"');
    expect((await brain.readGraph()).tasks).toHaveLength(3);
    expect(seen).toHaveLength(0);
  });

  it('409 task_in_progress and 404 for unknown ids', async () => {
    await setup({ version: 1, tasks: [node('a', { status: 'IN_PROGRESS' })] });
    const busy = await del('a');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('task_in_progress');
    const missing = await del('zz');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
  });
});

describe('without a writable brain', () => {
  it('501 brain_read_only when the source has no write methods', async () => {
    t = makeTestEngine();
    const source: BrainSource = {
      project: () => ({ root: '/repo', name: 'repo' }),
      graph: async () => ({ version: 1, tasks: [] }),
      state: async () => '',
      architecture: async () => '',
    };
    app = await buildGateway(t.engine, { brain: source });
    for (const res of [
      await post({ id: 'a', title: 'A' }),
      await patch('a', { title: 'B' }),
      await del('a'),
    ]) {
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('brain_read_only');
    }
  });

  it('409 no_brain when the gateway has no project', async () => {
    t = makeTestEngine();
    app = await buildGateway(t.engine, {});
    const res = await post({ id: 'a', title: 'A' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_brain');
  });

  it('409 no_brain when the project was never initialised', async () => {
    root = mkdtempSync(join(tmpdir(), 'davecode-api-tasks-'));
    t = makeTestEngine();
    app = await buildGateway(t.engine, {
      brain: new ProjectBrainSource(new ProjectBrain(root, { events: t.engine.events })),
    });
    const res = await post({ id: 'a', title: 'A' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_brain');
  });
});
