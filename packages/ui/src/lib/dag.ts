import type { TaskNode, TaskStatus } from './types';

/**
 * Layered (Sugiyama-style) layout for the task graph: longest-path layering from the roots,
 * barycenter ordering to reduce crossings, left-to-right coordinates and cubic edge paths.
 * Pure and deterministic so it can be unit tested.
 */

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  padding: number;
  sweeps: number;
  /** LR = layers flow left to right; TB = top to bottom. */
  direction: 'LR' | 'TB';
}

export interface LaidOutNode {
  id: string;
  layer: number;
  order: number;
  x: number;
  y: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  path: string;
}

export interface DagLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  layers: number;
  /** Dependencies that point at unknown task ids (ignored in the layout). */
  missing: { task: string; dependsOn: string }[];
  /** Edges dropped to break cycles (the graph loader should have rejected these). */
  cycleEdges: { from: string; to: string }[];
}

const DEFAULTS: LayoutOptions = {
  nodeWidth: 220,
  nodeHeight: 60,
  gapX: 64,
  gapY: 16,
  padding: 16,
  sweeps: 4,
  direction: 'LR',
};

export function layoutDag(tasks: TaskNode[], options: Partial<LayoutOptions> = {}): DagLayout {
  const o = { ...DEFAULTS, ...options };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const missing: DagLayout['missing'] = [];
  const cycleEdges: DagLayout['cycleEdges'] = [];

  // Valid dependency lists (known ids only).
  const deps = new Map<string, string[]>();
  for (const t of tasks) {
    const list: string[] = [];
    for (const d of t.dependsOn) {
      if (byId.has(d)) list.push(d);
      else missing.push({ task: t.id, dependsOn: d });
    }
    deps.set(t.id, list);
  }

  // Longest-path layering with DFS; back edges (cycles) are dropped and reported.
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let l = 0;
    const kept: string[] = [];
    for (const d of deps.get(id) ?? []) {
      if (visiting.has(d)) {
        cycleEdges.push({ from: d, to: id });
        continue;
      }
      kept.push(d);
      l = Math.max(l, visit(d) + 1);
    }
    deps.set(id, kept);
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  for (const t of tasks) visit(t.id);

  const layerCount = tasks.length ? Math.max(...layer.values()) + 1 : 0;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  const sorted = [...tasks].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id),
  );
  for (const t of sorted) layers[layer.get(t.id) ?? 0]?.push(t.id);

  const dependents = new Map<string, string[]>();
  for (const [id, list] of deps) {
    for (const d of list) dependents.set(d, [...(dependents.get(d) ?? []), id]);
  }

  // Barycenter sweeps: down (by dependencies), then up (by dependents).
  const position = new Map<string, number>();
  const index = () => {
    for (const l of layers) {
      l.forEach((id, i) => {
        position.set(id, i);
      });
    }
  };
  index();
  const bary = (id: string, neighbours: string[] | undefined): number => {
    const ps = (neighbours ?? [])
      .map((n) => position.get(n))
      .filter((p): p is number => p !== undefined);
    return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : (position.get(id) ?? 0);
  };
  for (let s = 0; s < o.sweeps; s++) {
    for (let l = 1; l < layers.length; l++) {
      const cur = layers[l];
      if (!cur) continue;
      cur.sort((a, b) => bary(a, deps.get(a)) - bary(b, deps.get(b)));
      index();
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const cur = layers[l];
      if (!cur) continue;
      cur.sort((a, b) => bary(a, dependents.get(a)) - bary(b, dependents.get(b)));
      index();
    }
  }

  // Main axis = layers, cross axis = siblings. gapX/gapY are literal horizontal/vertical gaps.
  const tb = o.direction === 'TB';
  const widest = Math.max(0, ...layers.map((l) => l.length));
  const sibSize = tb ? o.nodeWidth : o.nodeHeight;
  const sibGap = tb ? o.gapX : o.gapY;
  const layerSize = tb ? o.nodeHeight : o.nodeWidth;
  const layerGap = tb ? o.gapY : o.gapX;
  const crossExtent = widest * sibSize + Math.max(0, widest - 1) * sibGap;
  const mainExtent = layerCount * layerSize + Math.max(0, layerCount - 1) * layerGap;
  const width = o.padding * 2 + (tb ? crossExtent : mainExtent);
  const height = o.padding * 2 + (tb ? mainExtent : crossExtent);

  const nodes: LaidOutNode[] = [];
  const coords = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, l) => {
    const block = ids.length * sibSize + Math.max(0, ids.length - 1) * sibGap;
    const start = o.padding + (crossExtent - block) / 2;
    ids.forEach((id, i) => {
      const main = o.padding + l * (layerSize + layerGap);
      const cross = start + i * (sibSize + sibGap);
      const x = tb ? cross : main;
      const y = tb ? main : cross;
      coords.set(id, { x, y });
      nodes.push({ id, layer: l, order: i, x, y });
    });
  });

  const edges: LaidOutEdge[] = [];
  for (const t of tasks) {
    const to = coords.get(t.id);
    if (!to) continue;
    for (const d of deps.get(t.id) ?? []) {
      const from = coords.get(d);
      if (!from) continue;
      let path: string;
      if (tb) {
        const x1 = from.x + o.nodeWidth / 2;
        const y1 = from.y + o.nodeHeight;
        const x2 = to.x + o.nodeWidth / 2;
        const y2 = to.y;
        const dy = Math.max(20, (y2 - y1) / 2);
        path = `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`;
      } else {
        const x1 = from.x + o.nodeWidth;
        const y1 = from.y + o.nodeHeight / 2;
        const x2 = to.x;
        const y2 = to.y + o.nodeHeight / 2;
        const dx = Math.max(24, (x2 - x1) / 2);
        path = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      }
      edges.push({ from: d, to: t.id, path });
    }
  }

  return { nodes, edges, width, height, layers: layerCount, missing, cycleEdges };
}

export type TaskReadiness = 'done' | 'running' | 'failed' | 'ready' | 'waiting' | 'blocked';

/**
 * Where a task stands relative to its dependencies: `ready` = PENDING with every dependency
 * done; `blocked` = PENDING behind a FAILED task (directly or transitively).
 */
export function readiness(tasks: TaskNode[]): Map<string, TaskReadiness> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, TaskReadiness>();
  const visiting = new Set<string>();
  const of = (id: string): TaskReadiness => {
    const cached = memo.get(id);
    if (cached) return cached;
    const t = byId.get(id);
    if (!t) return 'waiting';
    const direct: Record<TaskStatus, TaskReadiness | null> = {
      SUCCESS: 'done',
      IN_PROGRESS: 'running',
      FAILED: 'failed',
      PENDING: null,
    };
    let r = direct[t.status];
    if (!r) {
      if (visiting.has(id)) return 'waiting';
      visiting.add(id);
      const states = t.dependsOn.filter((d) => byId.has(d)).map(of);
      visiting.delete(id);
      if (states.some((s) => s === 'failed' || s === 'blocked')) r = 'blocked';
      else if (states.every((s) => s === 'done')) r = 'ready';
      else r = 'waiting';
    }
    memo.set(id, r);
    return r;
  };
  for (const t of tasks) of(t.id);
  return memo;
}

/** All transitive dependencies (upstream) and dependents (downstream) of a task. */
export function neighbourhood(
  tasks: TaskNode[],
  id: string,
): { up: Set<string>; down: Set<string> } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<string, string[]>();
  for (const t of tasks)
    for (const d of t.dependsOn) children.set(d, [...(children.get(d) ?? []), t.id]);
  const walk = (start: string, next: (x: string) => string[]) => {
    const seen = new Set<string>();
    const stack = [...next(start)];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...next(cur));
    }
    return seen;
  };
  return {
    up: walk(id, (x) => byId.get(x)?.dependsOn ?? []),
    down: walk(id, (x) => children.get(x) ?? []),
  };
}
