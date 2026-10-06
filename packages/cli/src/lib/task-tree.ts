import {
  blockedTasks,
  nextTask,
  summarize,
  type TaskGraph,
  type TaskNode,
  topologicalOrder,
} from '@davecode/core';
import { truncate, visibleWidth } from '../ui/format';
import type { Theme } from '../ui/theme';

/**
 * Text rendering of the task DAG. Each task appears once, under its *primary* parent (the
 * dependency that comes last in topological order); other dependencies are listed inline as
 * `+ needs …`. Blocked tasks carry their reason.
 */

export function statusGlyph(theme: Theme, task: TaskNode, blocked: boolean): string {
  const g = theme.glyph;
  switch (task.status) {
    case 'SUCCESS':
      return theme.ok(g.success);
    case 'IN_PROGRESS':
      return theme.accent(g.running);
    case 'FAILED':
      return theme.error(g.failed);
    default:
      return blocked ? theme.dim(g.blocked) : g.pending;
  }
}

export function summaryLine(theme: Theme, graph: TaskGraph): string {
  const s = summarize(graph);
  const g = theme.glyph;
  const parts = [
    `${theme.ok(g.success)} ${s.counts.SUCCESS} done`,
    `${theme.accent(g.running)} ${s.counts.IN_PROGRESS} running`,
    `${g.pending} ${s.counts.PENDING} pending`,
    `${theme.error(g.failed)} ${s.counts.FAILED} failed`,
  ];
  return `${s.counts.SUCCESS}/${s.total} done (${s.progress}%)  ${theme.dim('·')}  ${parts.join('  ')}`;
}

export interface TreeOptions {
  /** Maximum line width (titles are truncated to fit). */
  width?: number;
}

export function formatTaskTree(
  theme: Theme,
  graph: TaskGraph,
  options: TreeOptions = {},
): string[] {
  const width = options.width ?? 100;
  if (graph.tasks.length === 0) return [theme.dim('No tasks yet.')];

  const order = topologicalOrder(graph);
  const rank = new Map(order.map((t, i) => [t.id, i]));
  const fileIndex = new Map(graph.tasks.map((t, i) => [t.id, i]));
  const blocked = new Map(blockedTasks(graph).map((b) => [b.task.id, b]));
  const next = nextTask(graph);

  const primaryParent = (task: TaskNode): string | undefined =>
    [...task.dependsOn].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0))[0];

  const children = new Map<string, TaskNode[]>();
  const roots: TaskNode[] = [];
  for (const task of graph.tasks) {
    const parent = primaryParent(task);
    if (parent === undefined) roots.push(task);
    else children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const byFileOrder = (a: TaskNode, b: TaskNode) =>
    (fileIndex.get(a.id) ?? 0) - (fileIndex.get(b.id) ?? 0);

  const idWidth = Math.min(24, Math.max(...graph.tasks.map((t) => t.id.length)));
  const lines: string[] = [];

  const annotate = (task: TaskNode, parent: string | undefined): string[] => {
    const notes: string[] = [];
    const others = task.dependsOn.filter((d) => d !== parent);
    if (others.length > 0) notes.push(theme.dim(`+ needs ${others.join(', ')}`));
    const block = blocked.get(task.id);
    if (block?.reason === 'failed-dependency') {
      notes.push(theme.error(`blocked: ${block.blockedBy.join(', ')} failed`));
    } else if (block) {
      notes.push(theme.dim(`waiting on ${block.blockedBy.join(', ')}`));
    }
    if (task.status === 'IN_PROGRESS' && task.attempts) {
      notes.push(theme.accent(`attempt ${task.attempts}`));
    }
    if (task.status === 'FAILED') {
      notes.push(theme.error(`failed${task.attempts ? ` after ${task.attempts} attempt(s)` : ''}`));
    }
    if (task.priority !== undefined && task.status === 'PENDING') {
      notes.push(theme.dim(`p${task.priority}`));
    }
    if (next?.id === task.id) notes.push(theme.accent(`${theme.glyph.arrow} next`));
    return notes;
  };

  const visit = (task: TaskNode, prefix: string, connector: string, parent?: string) => {
    const head = `${prefix}${connector}${statusGlyph(theme, task, blocked.has(task.id))} ${theme.bold(
      task.id.padEnd(idWidth),
    )}  `;
    const notes = annotate(task, parent);
    const tail = notes.length > 0 ? `  ${notes.join(theme.dim(' · '))}` : '';
    const room = width - visibleWidth(head) - visibleWidth(tail);
    const title = truncate(task.title, Math.max(8, room), theme.glyph.ellipsis);
    lines.push(`${head}${title}${tail}`);

    const kids = [...(children.get(task.id) ?? [])].sort(byFileOrder);
    const childPrefix =
      prefix + (connector === theme.glyph.tee ? theme.glyph.pipe : connector ? '  ' : '');
    kids.forEach((kid, i) => {
      visit(kid, childPrefix, i === kids.length - 1 ? theme.glyph.elbow : theme.glyph.tee, task.id);
    });
  };

  for (const root of roots.sort(byFileOrder)) visit(root, '', '');
  return lines;
}

/** Detail view for `davecode tasks next`. */
export function formatTaskDetail(theme: Theme, task: TaskNode): string[] {
  const lines = [`${theme.bold(theme.accent(task.id))}  ${task.title}`];
  if (task.description) lines.push('', ...task.description.split(/\r?\n/).map((l) => `  ${l}`));
  if (task.dependsOn.length > 0)
    lines.push('', `${theme.dim('depends on')}  ${task.dependsOn.join(', ')}`);
  if (task.priority !== undefined) lines.push(`${theme.dim('priority')}    ${task.priority}`);
  if (task.acceptance && task.acceptance.length > 0) {
    lines.push('', theme.dim('acceptance'));
    for (const item of task.acceptance) lines.push(`  ${theme.glyph.bullet} ${item}`);
  }
  return lines;
}
