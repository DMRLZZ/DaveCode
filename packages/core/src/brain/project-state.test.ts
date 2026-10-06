import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskGraph } from '../types';
import { ProjectBrain } from './project';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'davecode-state-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const fixedNow = () => new Date('2031-04-05T06:07:08.000Z');

const graph: TaskGraph = {
  version: 1,
  tasks: [{ id: 'a', title: 'A', status: 'PENDING', dependsOn: [] }],
};

describe('STATE.md helpers', () => {
  it('updateStateSection replaces a section, preserves the rest and refreshes the date', async () => {
    const brain = await ProjectBrain.init(tmp, {
      name: 'Demo',
      now: () => new Date('2020-01-01T00:00:00Z'),
    });
    const before = await brain.readState();
    const later = new ProjectBrain(tmp, { now: fixedNow });
    await later.updateStateSection('Current focus', 'Implementing the runner.');
    const after = await later.readState();
    expect(after).toContain('## Current focus\n\nImplementing the runner.\n\n## Done');
    expect(after).toContain('_Last updated: 2031-04-05_');
    const restored = after
      .replace('2031-04-05', '2020-01-01')
      .replace('Implementing the runner.', 'Describe what is being worked on right now.');
    expect(restored).toBe(before);
  });

  it('updateStateSection appends unknown sections', async () => {
    const brain = await ProjectBrain.init(tmp, { now: fixedNow });
    await brain.updateStateSection('Risks', '- flaky CI');
    const state = await brain.readState();
    expect(state.trimEnd().endsWith('## Risks\n\n- flaky CI')).toBe(true);
    expect(state).toContain('## Blockers');
  });

  it('appendStateLog appends timestamped bullets in order', async () => {
    const brain = await ProjectBrain.init(tmp, { now: fixedNow });
    await brain.appendStateLog('Started task a');
    await brain.appendStateLog('Finished\ntask a');
    const state = await brain.readState();
    expect(
      state
        .trimEnd()
        .endsWith(
          '## Activity log\n\n- 2031-04-05T06:07:08Z: Started task a\n- 2031-04-05T06:07:08Z: Finished task a',
        ),
    ).toBe(true);
  });

  it('appendStateLog creates the Activity log section when missing', async () => {
    const brain = await ProjectBrain.init(tmp, { now: fixedNow });
    await brain.writeState('# S\n\n_Last updated: 2000-01-01_\n\n## Done\n\n- x\n');
    await brain.appendStateLog('hello');
    expect(await brain.readState()).toBe(
      '# S\n\n_Last updated: 2031-04-05_\n\n## Done\n\n- x\n\n## Activity log\n\n- 2031-04-05T06:07:08Z: hello\n',
    );
  });
});

describe('locking', () => {
  it('does not lose updates when several writers race', async () => {
    const lock = { retryMs: 2 };
    const a = await ProjectBrain.init(tmp, { now: fixedNow, lock });
    const b = new ProjectBrain(tmp, { now: fixedNow, lock });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).appendStateLog(`entry ${i}`)),
    );
    const state = await a.readState();
    for (let i = 0; i < 12; i++) expect(state).toContain(`entry ${i}`);
    expect(state.match(/- 2031/g)).toHaveLength(12);
  });

  it('recovers from a stale lock left by a crashed process', async () => {
    const brain = await ProjectBrain.init(tmp, { now: fixedNow });
    await writeFile(
      brain.lockPath,
      JSON.stringify({ pid: 424242, ts: Date.now() - 45_000, token: 't' }),
    );
    await brain.appendStateLog('after crash');
    expect(await brain.readState()).toContain('after crash');
    expect(await readdir(brain.paths.dir)).not.toContain('.lock');
  });

  it('task updates wait for the lock and fail cleanly on timeout', async () => {
    const brain = await ProjectBrain.init(tmp, { lock: { timeoutMs: 60, retryMs: 10 } });
    await brain.writeGraph(graph);
    await writeFile(brain.lockPath, JSON.stringify({ pid: 1, ts: Date.now(), token: 'held' }));
    await expect(brain.setTaskStatus('a', 'IN_PROGRESS')).rejects.toThrow(/Timed out/);
    expect((await brain.readGraph()).tasks[0]?.status).toBe('PENDING');
  });

  it('concurrent status updates from two instances are all applied', async () => {
    const lock = { retryMs: 2 };
    const a = await ProjectBrain.init(tmp, { lock });
    const b = new ProjectBrain(tmp, { lock });
    await a.writeGraph({
      version: 1,
      tasks: [
        { id: 't1', title: '1', status: 'PENDING', dependsOn: [] },
        { id: 't2', title: '2', status: 'PENDING', dependsOn: [] },
      ],
    });
    await Promise.all([a.setTaskStatus('t1', 'IN_PROGRESS'), b.setTaskStatus('t2', 'IN_PROGRESS')]);
    const tasks = (await a.readGraph()).tasks;
    expect(tasks.map((t) => t.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
  });
});
