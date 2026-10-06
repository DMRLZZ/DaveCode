import { describe, expect, it } from 'vitest';
import { layoutDag, neighbourhood, readiness } from './dag';
import { mockTasks } from './mock-data';
import type { TaskNode } from './types';

const t = (
  id: string,
  dependsOn: string[] = [],
  status: TaskNode['status'] = 'PENDING',
  priority = 0,
): TaskNode => ({
  id,
  title: id,
  status,
  dependsOn,
  priority,
});

describe('layoutDag', () => {
  it('places every task one layer after its deepest dependency', () => {
    const { nodes, layers } = layoutDag([
      t('a'),
      t('b', ['a']),
      t('c', ['a']),
      t('d', ['b', 'c']),
      t('e', ['a', 'd']),
    ]);
    const layer = Object.fromEntries(nodes.map((n) => [n.id, n.layer]));
    expect(layer).toEqual({ a: 0, b: 1, c: 1, d: 2, e: 3 });
    expect(layers).toBe(4);
  });

  it('creates one edge per known dependency and reports unknown ones', () => {
    const { edges, missing } = layoutDag([t('a'), t('b', ['a', 'ghost'])]);
    expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(['a->b']);
    expect(missing).toEqual([{ task: 'b', dependsOn: 'ghost' }]);
  });

  it('breaks cycles instead of looping forever', () => {
    const { nodes, cycleEdges } = layoutDag([t('a', ['c']), t('b', ['a']), t('c', ['b'])]);
    expect(nodes).toHaveLength(3);
    expect(cycleEdges).toHaveLength(1);
  });

  it.each(['LR', 'TB'] as const)(
    'never overlaps nodes and fits them inside the canvas (%s)',
    (direction) => {
      const opts = { nodeWidth: 200, nodeHeight: 50, gapX: 40, gapY: 10, padding: 8, direction };
      const layout = layoutDag(mockTasks(Date.now()), opts);
      for (const a of layout.nodes) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + opts.nodeWidth).toBeLessThanOrEqual(layout.width);
        expect(a.y + opts.nodeHeight).toBeLessThanOrEqual(layout.height);
        for (const b of layout.nodes) {
          if (a === b) continue;
          const overlap =
            a.x < b.x + opts.nodeWidth &&
            b.x < a.x + opts.nodeWidth &&
            a.y < b.y + opts.nodeHeight &&
            b.y < a.y + opts.nodeHeight;
          expect(overlap).toBe(false);
        }
      }
    },
  );

  it('is deterministic', () => {
    const tasks = mockTasks(0);
    expect(layoutDag(tasks)).toEqual(layoutDag(tasks));
  });
});

describe('readiness', () => {
  it('distinguishes ready, waiting and blocked pending tasks', () => {
    const r = readiness([
      t('done', [], 'SUCCESS'),
      t('broken', [], 'FAILED'),
      t('ready', ['done']),
      t('waiting', ['ready']),
      t('blocked', ['broken']),
      t('transitive', ['blocked']),
    ]);
    expect(Object.fromEntries(r)).toEqual({
      done: 'done',
      broken: 'failed',
      ready: 'ready',
      waiting: 'waiting',
      blocked: 'blocked',
      transitive: 'blocked',
    });
  });
});

describe('neighbourhood', () => {
  it('collects transitive dependencies and dependents', () => {
    const tasks = [t('a'), t('b', ['a']), t('c', ['b']), t('x')];
    expect(neighbourhood(tasks, 'b')).toEqual({ up: new Set(['a']), down: new Set(['c']) });
  });
});
