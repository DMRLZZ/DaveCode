import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events';
import type { TaskGraph } from '../types';
import { atomicWriteFile } from './fs-util';
import { TaskGraphError } from './graph';
import { findProjectRoot, ProjectBrain } from './project';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'davecode-brain-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const sampleGraph: TaskGraph = {
  version: 1,
  tasks: [
    { id: 'a', title: 'A', status: 'PENDING', dependsOn: [], priority: 5 },
    { id: 'b', title: 'B', status: 'PENDING', dependsOn: ['a'] },
  ],
};

describe('findProjectRoot', () => {
  it('finds a parent containing .davecode', async () => {
    await mkdir(join(tmp, '.davecode'));
    const deep = join(tmp, 'packages', 'x', 'src');
    await mkdir(deep, { recursive: true });
    expect(await findProjectRoot(deep)).toBe(tmp);
  });

  it('finds a parent containing .git (dir or file)', async () => {
    await mkdir(join(tmp, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(tmp, 'sub', '.git'), 'gitdir: elsewhere');
    expect(await findProjectRoot(join(tmp, 'sub', 'deeper'))).toBe(join(tmp, 'sub'));
  });

  it('prefers the nearest marker', async () => {
    await mkdir(join(tmp, '.git'));
    await mkdir(join(tmp, 'inner', '.davecode'), { recursive: true });
    expect(await findProjectRoot(join(tmp, 'inner'))).toBe(join(tmp, 'inner'));
  });
});

describe('atomicWriteFile', () => {
  it('replaces content and leaves no temp files behind', async () => {
    const file = join(tmp, 'x.txt');
    await atomicWriteFile(file, 'one');
    await atomicWriteFile(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(tmp)).toEqual(['x.txt']);
  });

  it('keeps the previous content and cleans up when the write fails', async () => {
    const file = join(tmp, 'keep.txt');
    await atomicWriteFile(file, 'original');
    // A directory at the destination makes the final rename fail.
    const blocked = join(tmp, 'blocked');
    await mkdir(blocked);
    await expect(atomicWriteFile(blocked, 'nope')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('original');
    expect((await readdir(tmp)).sort()).toEqual(['blocked', 'keep.txt']);
  });

  it('creates missing parent directories', async () => {
    const file = join(tmp, 'a', 'b', 'c.txt');
    await atomicWriteFile(file, 'deep');
    expect(await readFile(file, 'utf8')).toBe('deep');
  });
});

describe('ProjectBrain.init', () => {
  it('scaffolds the three files from templates', async () => {
    const brain = await ProjectBrain.init(tmp, { name: 'Demo' });
    const snapshot = await brain.load();
    expect(snapshot.state).toContain('# Demo: project state');
    expect(snapshot.state).toMatch(/_Last updated: \d{4}-\d{2}-\d{2}_/);
    expect(snapshot.architecture).toContain('# Demo: architecture');
    expect(snapshot.graph).toEqual({ version: 1, tasks: [] });
    expect(await readFile(brain.paths.taskGraph, 'utf8')).toBe(
      '{\n  "version": 1,\n  "tasks": []\n}\n',
    );
    expect(await brain.isInitialised()).toBe(true);
  });

  it('defaults the name to the directory name', async () => {
    const dir = join(tmp, 'my-repo');
    await mkdir(dir);
    const brain = await ProjectBrain.init(dir);
    expect(await brain.readState()).toContain('# my-repo: project state');
  });

  it('never overwrites existing files', async () => {
    await mkdir(join(tmp, '.davecode'));
    await writeFile(join(tmp, '.davecode', 'STATE.md'), 'custom state\n');
    const brain = await ProjectBrain.init(tmp);
    expect(await brain.readState()).toBe('custom state\n');
    expect(await brain.readArchitecture()).toContain('architecture');
    await brain.writeGraph(sampleGraph);
    await ProjectBrain.init(tmp);
    expect((await brain.readGraph()).tasks).toHaveLength(2);
  });

  it('reports a helpful error when files are missing', async () => {
    await expect(new ProjectBrain(tmp).readState()).rejects.toThrow(/Missing project brain file/);
  });
});

describe('graph persistence', () => {
  it('writes 2-space JSON with a trailing newline and round-trips', async () => {
    const brain = await ProjectBrain.init(tmp);
    await brain.writeGraph(sampleGraph);
    const raw = await readFile(brain.paths.taskGraph, 'utf8');
    expect(raw).toBe(`${JSON.stringify(sampleGraph, null, 2)}\n`);
    expect(await brain.readGraph()).toEqual(sampleGraph);
  });

  it('validates on write and keeps the old file', async () => {
    const brain = await ProjectBrain.init(tmp);
    await brain.writeGraph(sampleGraph);
    const cyclic: TaskGraph = {
      version: 1,
      tasks: [
        { id: 'a', title: 'A', status: 'PENDING', dependsOn: ['b'] },
        { id: 'b', title: 'B', status: 'PENDING', dependsOn: ['a'] },
      ],
    };
    await expect(brain.writeGraph(cyclic)).rejects.toThrow(TaskGraphError);
    expect((await brain.readGraph()).tasks).toHaveLength(2);
  });

  it('validates on read', async () => {
    const brain = await ProjectBrain.init(tmp);
    await writeFile(brain.paths.taskGraph, '{"version":1,"tasks":[{"id":"a"}]}');
    await expect(brain.readGraph()).rejects.toThrow(TaskGraphError);
  });
});

describe('task updates', () => {
  it('persists changes and emits task.updated', async () => {
    const events = new EventBus();
    const brain = await ProjectBrain.init(tmp, {
      events,
      now: () => new Date('2026-05-06T07:08:09.000Z'),
    });
    await brain.writeGraph(sampleGraph);

    const started = await brain.setTaskStatus('a', 'IN_PROGRESS');
    expect(started).toMatchObject({ status: 'IN_PROGRESS', attempts: 1 });
    expect(started.updatedAt).toBe('2026-05-06T07:08:09.000Z');

    await brain.updateTask('a', { branch: 'davecode/task-a' });
    await brain.setTaskStatus('a', 'SUCCESS', { notes: 'merged' });

    const persisted = (await brain.readGraph()).tasks[0];
    expect(persisted).toMatchObject({
      status: 'SUCCESS',
      notes: 'merged',
      branch: 'davecode/task-a',
    });

    const emitted = events.recent().filter((e) => e.type === 'task.updated');
    expect(emitted).toHaveLength(3);
    expect(emitted[2]).toMatchObject({ task: { id: 'a', status: 'SUCCESS' } });
  });

  it('rejects invalid transitions without writing or emitting', async () => {
    const events = new EventBus();
    const brain = await ProjectBrain.init(tmp, { events });
    await brain.writeGraph(sampleGraph);
    await expect(brain.setTaskStatus('a', 'SUCCESS')).rejects.toThrow(
      /cannot move PENDING → SUCCESS/,
    );
    await expect(brain.setTaskStatus('nope', 'IN_PROGRESS')).rejects.toThrow(/unknown task/);
    expect((await brain.readGraph()).tasks[0]?.status).toBe('PENDING');
    expect(events.recent()).toHaveLength(0);
  });

  it('works without an event bus', async () => {
    const brain = await ProjectBrain.init(tmp);
    await brain.writeGraph(sampleGraph);
    await expect(brain.setTaskStatus('a', 'IN_PROGRESS')).resolves.toMatchObject({ id: 'a' });
  });
});
