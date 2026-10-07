import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskGraphError } from './graph';
import { ProjectBrain } from './project';
import { ProjectBrainSource } from './source';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-source-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ProjectBrainSource', () => {
  it('exposes the write methods of a full ProjectBrain and delegates to it', async () => {
    const brain = await ProjectBrain.init(root, { name: 'demo' });
    const source = new ProjectBrainSource(brain);
    await source.createTask?.({ id: 'a', title: 'A' });
    await source.updateTask?.('a', { title: 'A2' });
    expect((await source.graph()).tasks[0]).toMatchObject({ id: 'a', title: 'A2' });
    await source.removeTask?.('a');
    expect((await source.graph()).tasks).toEqual([]);
  });

  it('stays read-only when the brain cannot write', () => {
    const readOnly = new ProjectBrainSource({ root, paths: new ProjectBrain(root).paths });
    expect(readOnly.createTask).toBeUndefined();
    expect(readOnly.updateTask).toBeUndefined();
    expect(readOnly.removeTask).toBeUndefined();
  });

  it('reads empty values when the brain is missing', async () => {
    const source = new ProjectBrainSource(new ProjectBrain(root));
    expect(source.project()).toEqual({ root, name: basename(root) });
    expect(await source.graph()).toEqual({ version: 1, tasks: [] });
    expect(await source.state()).toBe('');
    expect(await source.architecture()).toBe('');
  });

  it('exposes the brain files and validates the graph', async () => {
    const brain = await ProjectBrain.init(root, { name: 'demo' });
    const source = new ProjectBrainSource(brain, 'demo');
    expect(source.project().name).toBe('demo');
    expect(await source.state()).toContain('# demo: project state');
    expect(await source.architecture()).toContain('architecture');
    await brain.writeGraph({
      version: 1,
      tasks: [{ id: 'a', title: 'A', status: 'PENDING', dependsOn: [] }],
    });
    expect((await source.graph()).tasks.map((t) => t.id)).toEqual(['a']);
    writeFileSync(brain.paths.taskGraph, '{"version":1,"tasks":[{"id":"x"}]}');
    await expect(source.graph()).rejects.toBeInstanceOf(TaskGraphError);
  });
});
