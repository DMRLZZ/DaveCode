import { mkdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrchestratorRun } from './contract';
import { ORCHESTRATOR_RUNS_KEPT, OrchestratorStore, orchestratorRunsPath } from './store';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'davecode-orch-store-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const run = (id: string, createdAt: string): OrchestratorRun => ({
  id,
  objective: `objective ${id}`,
  status: 'done',
  agents: ['claude'],
  tasks: [
    {
      id: 't1',
      title: 'A',
      agent: 'claude',
      prompt: 'Do A',
      dependsOn: [],
      status: 'done',
      changedFiles: ['a.ts'],
    },
  ],
  createdAt,
  updatedAt: createdAt,
});

describe('OrchestratorStore', () => {
  it('stores runs under a per-project hash in the home', () => {
    const path = orchestratorRunsPath(home, '/projects/app');
    expect(path).toMatch(/orchestrator[\\/][0-9a-f]{16}[\\/]runs\.json$/);
    expect(path.startsWith(home)).toBe(true);
    expect(orchestratorRunsPath(home, '/projects/other')).not.toBe(path);
  });

  it('round-trips runs, newest first', async () => {
    const store = new OrchestratorStore(home, '/projects/app');
    expect(store.load()).toEqual([]);
    await store.save([run('a', '2026-01-01T00:00:00.000Z'), run('b', '2026-01-02T00:00:00.000Z')]);
    const loaded = new OrchestratorStore(home, '/projects/app').load();
    expect(loaded.map((r) => r.id)).toEqual(['b', 'a']);
    expect(loaded[0]).toEqual(run('b', '2026-01-02T00:00:00.000Z'));
  });

  it('keeps only the newest runs', async () => {
    const store = new OrchestratorStore(home, '/p');
    const runs = Array.from({ length: ORCHESTRATOR_RUNS_KEPT + 5 }, (_, i) =>
      run(`r${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    await store.save(runs);
    const loaded = store.load();
    expect(loaded).toHaveLength(ORCHESTRATOR_RUNS_KEPT);
    expect(loaded[0]?.id).toBe(`r${ORCHESTRATOR_RUNS_KEPT + 4}`);
    expect(loaded.at(-1)?.id).toBe('r5');
  });

  it('coalesces queued writes and leaves no temp files', async () => {
    const store = new OrchestratorStore(home, '/p');
    const first = store.save([run('a', '2026-01-01T00:00:00.000Z')]);
    store.save([run('a', '2026-01-01T00:00:00.000Z'), run('b', '2026-01-02T00:00:00.000Z')]);
    await first;
    await store.flush();
    expect(store.load().map((r) => r.id)).toEqual(['b', 'a']);
    expect(await readdir(dirname(store.path))).toEqual(['runs.json']);
  });

  it('ignores a corrupt file and skips invalid runs', async () => {
    const store = new OrchestratorStore(home, '/p');
    mkdirSync(dirname(store.path), { recursive: true });
    await writeFile(store.path, '{ not json', 'utf8');
    expect(store.load()).toEqual([]);
    await writeFile(store.path, JSON.stringify({ version: 2, runs: [] }), 'utf8');
    expect(store.load()).toEqual([]);
    await writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        runs: [run('ok', '2026-01-01T00:00:00.000Z'), { id: 'bad', status: 'weird' }],
      }),
      'utf8',
    );
    expect(store.load().map((r) => r.id)).toEqual(['ok']);
    expect(JSON.parse(await readFile(store.path, 'utf8')).runs).toHaveLength(2);
  });
});
