import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TaskGraph, TaskNode, TaskStatus } from '../types';
import {
  addTask,
  blockedTasks,
  checkRunnable,
  dependentsOf,
  findCycles,
  nextTask,
  parseTaskGraph,
  readyTasks,
  removeTask,
  setTaskStatus,
  summarize,
  TaskGraphError,
  topologicalOrder,
  updateTask,
} from './graph';

function task(
  id: string,
  dependsOn: string[] = [],
  status: TaskStatus = 'PENDING',
  priority?: number,
): TaskNode {
  const node: TaskNode = { id, title: `Task ${id}`, status, dependsOn };
  if (priority !== undefined) node.priority = priority;
  return node;
}

const graphOf = (...tasks: TaskNode[]): TaskGraph => ({ version: 1, tasks });

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof TaskGraphError) return err.issues.map((i) => i.message);
    throw err;
  }
  throw new Error('expected TaskGraphError');
}

describe('parseTaskGraph', () => {
  it('parses objects and JSON strings, defaulting dependsOn', () => {
    const graph = parseTaskGraph(
      JSON.stringify({ version: 1, tasks: [{ id: 'a', title: 'A', status: 'PENDING' }] }),
    );
    expect(graph.tasks[0]?.dependsOn).toEqual([]);
    expect(parseTaskGraph({ version: 1, tasks: [] }).tasks).toEqual([]);
  });

  it('rejects invalid JSON, wrong version, bad status and bad ids', () => {
    expect(issuesOf(() => parseTaskGraph('{nope'))[0]).toMatch(/not valid JSON/);
    expect(issuesOf(() => parseTaskGraph({ version: 2, tasks: [] }))[0]).toMatch(/version/);
    const bad = issuesOf(() =>
      parseTaskGraph({ version: 1, tasks: [{ id: 'Bad Id', title: 'x', status: 'DONE' }] }),
    );
    expect(bad.some((m) => m.startsWith('tasks.0.id'))).toBe(true);
    expect(bad.some((m) => m.startsWith('tasks.0.status'))).toBe(true);
  });

  it('accepts kebab, snake and dotted ids', () => {
    const graph = parseTaskGraph({
      version: 1,
      tasks: [task('p1-storage'), task('snake_case_1'), task('release-0.1.0')],
    });
    expect(graph.tasks).toHaveLength(3);
  });

  it('reports duplicate ids', () => {
    expect(issuesOf(() => parseTaskGraph(graphOf(task('a'), task('a'))))).toEqual([
      'duplicate task id "a"',
    ]);
  });

  it('reports unknown dependencies and self-dependencies', () => {
    const messages = issuesOf(() =>
      parseTaskGraph(graphOf(task('a', ['ghost']), task('b', ['b']))),
    );
    expect(messages).toContain('task "a" depends on unknown task "ghost"');
    expect(messages).toContain('task "b" depends on itself');
  });

  it('reports the exact cycle path', () => {
    const messages = issuesOf(() =>
      parseTaskGraph(graphOf(task('a', ['b']), task('b', ['c']), task('c', ['a']))),
    );
    expect(messages).toEqual(['dependency cycle: a → b → c → a']);
  });

  it('reports several problems at once', () => {
    const messages = issuesOf(() =>
      parseTaskGraph(graphOf(task('a', ['b']), task('b', ['a']), task('c', ['nope']))),
    );
    expect(messages).toHaveLength(2);
  });
});

describe('findCycles', () => {
  it('returns nothing for a DAG (diamond)', () => {
    const g = graphOf(task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c']));
    expect(findCycles(g)).toEqual([]);
  });

  it('finds two disjoint cycles once each', () => {
    const g = graphOf(task('a', ['b']), task('b', ['a']), task('x', ['y']), task('y', ['x']));
    expect(findCycles(g)).toEqual([
      ['a', 'b', 'a'],
      ['x', 'y', 'x'],
    ]);
  });

  it('starts the reported path where the cycle is entered', () => {
    const g = graphOf(task('entry', ['a']), task('a', ['b']), task('b', ['a']));
    expect(findCycles(g)).toEqual([['a', 'b', 'a']]);
  });
});

describe('topologicalOrder', () => {
  it('puts dependencies first and keeps file order otherwise', () => {
    const g = graphOf(task('c', ['b']), task('b', ['a']), task('a'), task('z'));
    expect(topologicalOrder(g).map((t) => t.id)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('throws on cycles', () => {
    expect(() => topologicalOrder(graphOf(task('a', ['b']), task('b', ['a'])))).toThrow(
      /a → b → a/,
    );
  });
});

describe('nextTask / readyTasks / blockedTasks', () => {
  it('picks the highest priority unblocked PENDING task', () => {
    const g = graphOf(
      task('done', [], 'SUCCESS'),
      task('low', ['done'], 'PENDING', 10),
      task('high', ['done'], 'PENDING', 90),
      task('locked', ['low'], 'PENDING', 100),
    );
    expect(nextTask(g)?.id).toBe('high');
    expect(readyTasks(g).map((t) => t.id)).toEqual(['high', 'low']);
  });

  it('keeps file order on ties and treats missing priority as 0', () => {
    const g = graphOf(task('first'), task('second'), task('third', [], 'PENDING', 0));
    expect(readyTasks(g).map((t) => t.id)).toEqual(['first', 'second', 'third']);
  });

  it('ignores IN_PROGRESS, FAILED and SUCCESS tasks', () => {
    const g = graphOf(
      task('a', [], 'IN_PROGRESS'),
      task('b', [], 'FAILED'),
      task('c', [], 'SUCCESS'),
    );
    expect(nextTask(g)).toBeUndefined();
  });

  it('explains waiting vs failed-dependency blocks', () => {
    const g = graphOf(
      task('ok', [], 'SUCCESS'),
      task('bad', [], 'FAILED'),
      task('busy', [], 'IN_PROGRESS'),
      task('after-bad', ['ok', 'bad'], 'PENDING'),
      task('after-busy', ['busy'], 'PENDING'),
      task('free', ['ok'], 'PENDING'),
    );
    expect(blockedTasks(g).map((b) => [b.task.id, b.reason, b.blockedBy])).toEqual([
      ['after-bad', 'failed-dependency', ['bad']],
      ['after-busy', 'waiting', ['busy']],
    ]);
  });
});

describe('summarize', () => {
  it('counts statuses and computes progress', () => {
    const g = graphOf(
      task('a', [], 'SUCCESS'),
      task('b', [], 'PENDING'),
      task('c', [], 'IN_PROGRESS'),
    );
    expect(summarize(g)).toEqual({
      total: 3,
      counts: { PENDING: 1, IN_PROGRESS: 1, SUCCESS: 1, FAILED: 0 },
      progress: 33.3,
    });
    expect(summarize(graphOf()).progress).toBe(0);
  });
});

describe('updaters', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');

  it('does not mutate the input graph', () => {
    const g = graphOf(task('a'));
    const next = setTaskStatus(g, 'a', 'IN_PROGRESS', { now });
    expect(g.tasks[0]?.status).toBe('PENDING');
    expect(next.tasks[0]?.status).toBe('IN_PROGRESS');
  });

  it('stamps updatedAt and increments attempts on IN_PROGRESS', () => {
    let g = graphOf(task('a'));
    g = setTaskStatus(g, 'a', 'IN_PROGRESS', { now });
    expect(g.tasks[0]).toMatchObject({ attempts: 1, updatedAt: now.toISOString() });
    g = setTaskStatus(g, 'a', 'FAILED', { now, notes: 'tests red' });
    expect(g.tasks[0]).toMatchObject({ attempts: 1, notes: 'tests red' });
    g = setTaskStatus(g, 'a', 'PENDING', { now });
    g = setTaskStatus(g, 'a', 'IN_PROGRESS', { now });
    expect(g.tasks[0]?.attempts).toBe(2);
  });

  it('allows the documented transitions', () => {
    const allowed: Array<[TaskStatus, TaskStatus]> = [
      ['PENDING', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'SUCCESS'],
      ['IN_PROGRESS', 'FAILED'],
      ['IN_PROGRESS', 'PENDING'],
      ['FAILED', 'PENDING'],
      ['SUCCESS', 'PENDING'],
    ];
    for (const [from, to] of allowed) {
      expect(setTaskStatus(graphOf(task('a', [], from)), 'a', to).tasks[0]?.status).toBe(to);
    }
  });

  it('rejects every other transition', () => {
    const rejected: Array<[TaskStatus, TaskStatus]> = [
      ['PENDING', 'SUCCESS'],
      ['PENDING', 'FAILED'],
      ['FAILED', 'SUCCESS'],
      ['FAILED', 'IN_PROGRESS'],
      ['SUCCESS', 'FAILED'],
      ['SUCCESS', 'IN_PROGRESS'],
    ];
    for (const [from, to] of rejected) {
      expect(() => setTaskStatus(graphOf(task('a', [], from)), 'a', to)).toThrow(
        new RegExp(`cannot move ${from} → ${to}`),
      );
    }
  });

  it('throws for unknown ids', () => {
    expect(() => updateTask(graphOf(task('a')), 'zzz', { title: 'x' })).toThrow(/unknown task/);
  });

  it('patches fields without a status change and re-validates dependencies', () => {
    const g = graphOf(task('a'), task('b'));
    const patched = updateTask(g, 'b', { title: 'New', dependsOn: ['a'] }, { now });
    expect(patched.tasks[1]).toMatchObject({ title: 'New', dependsOn: ['a'] });
    expect(() => updateTask(patched, 'a', { dependsOn: ['b'] })).toThrow(/a → b → a/);
    expect(() => updateTask(g, 'a', { dependsOn: ['ghost'] })).toThrow(/unknown task "ghost"/);
  });
});

describe('repository task graph', () => {
  it('parses .davecode/TASK_GRAPH.json into a resolvable DAG', () => {
    const file = fileURLToPath(new URL('../../../../.davecode/TASK_GRAPH.json', import.meta.url));
    const graph = parseTaskGraph(readFileSync(file, 'utf8'));
    expect(graph.tasks.length).toBeGreaterThan(0);
    expect(topologicalOrder(graph)).toHaveLength(graph.tasks.length);
    // The live graph changes as work lands; whatever its state, any next task must be ready.
    const next = nextTask(graph);
    if (next) expect(readyTasks(graph).map((t) => t.id)).toContain(next.id);
  });
});

describe('addTask / removeTask / clear', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');

  it('appends a PENDING task and validates it', () => {
    const g = graphOf(task('a'));
    const created = addTask(
      g,
      { id: 'b', title: 'B', dependsOn: ['a'], priority: 3, acceptance: ['works'] },
      { now },
    );
    expect(created.tasks[1]).toEqual({
      id: 'b',
      title: 'B',
      status: 'PENDING',
      dependsOn: ['a'],
      priority: 3,
      acceptance: ['works'],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(g.tasks).toHaveLength(1);
    expect(() => addTask(g, { id: 'a', title: 'dup' })).toThrow(/duplicate task id "a"/);
    expect(() => addTask(g, { id: 'c', title: 'C', dependsOn: ['ghost'] })).toThrow(
      /unknown task "ghost"/,
    );
    expect(() => addTask(g, { id: 'c', title: 'C', dependsOn: ['c'] })).toThrow(
      /depends on itself/,
    );
  });

  it('removes a task nobody depends on, and refuses otherwise', () => {
    const g = graphOf(task('a'), task('b', ['a']), task('c', [], 'IN_PROGRESS'));
    expect(removeTask(g, 'b').tasks.map((t) => t.id)).toEqual(['a', 'c']);
    expect(dependentsOf(g, 'a')).toEqual(['b']);
    const err = (() => {
      try {
        removeTask(g, 'a');
      } catch (e) {
        return e as TaskGraphError;
      }
    })();
    expect(err?.issues[0]).toMatchObject({ code: 'has_dependents', dependents: ['b'] });
    expect(() => removeTask(g, 'c')).toThrow(/IN_PROGRESS/);
    expect(() => removeTask(g, 'zz')).toThrow(/unknown task/);
  });

  it('clears optional fields through updateTask({ clear })', () => {
    const g = graphOf({ ...task('a', [], 'PENDING', 4), description: 'd', notes: 'n' });
    const out = updateTask(g, 'a', { title: 'T' }, { now, clear: ['description', 'priority'] });
    expect(out.tasks[0]).not.toHaveProperty('description');
    expect(out.tasks[0]).not.toHaveProperty('priority');
    expect(out.tasks[0]).toMatchObject({ title: 'T', notes: 'n' });
  });
});

describe('checkRunnable', () => {
  const g = graphOf(
    task('done', [], 'SUCCESS'),
    task('bad', [], 'FAILED'),
    task('ready', ['done']),
    task('waiting', ['ready', 'done']),
    task('stuck', ['bad']),
    task('busy', [], 'IN_PROGRESS'),
  );

  it('accepts a PENDING task whose dependencies are done, regardless of priority order', () => {
    expect(checkRunnable(g, 'ready')).toMatchObject({ ok: true, task: { id: 'ready' } });
  });

  it('explains every refusal', () => {
    expect(checkRunnable(g, 'nope')).toMatchObject({ ok: false, reason: 'unknown_task' });
    expect(checkRunnable(g, 'done')).toMatchObject({ ok: false, reason: 'wrong_status' });
    expect(checkRunnable(g, 'busy')).toMatchObject({ ok: false, reason: 'wrong_status' });
    const waiting = checkRunnable(g, 'waiting');
    expect(waiting).toMatchObject({ ok: false, reason: 'blocked', blockedBy: ['ready'] });
    expect(!waiting.ok && waiting.message).toContain('"ready" (PENDING)');
    const stuck = checkRunnable(g, 'stuck');
    expect(!stuck.ok && stuck.message).toContain('"bad" (FAILED)');
  });
});
