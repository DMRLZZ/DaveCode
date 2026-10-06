import { useMemo, useState } from 'react';
import { TaskStatusDot } from '../../components/domain';
import { cn } from '../../lib/cn';
import { layoutDag, neighbourhood, type TaskReadiness } from '../../lib/dag';
import type { TaskNode } from '../../lib/types';

const NODE_W = 204;
const NODE_H = 56;

const edgeTone: Record<TaskNode['status'], string> = {
  SUCCESS: 'stroke-ok/50',
  IN_PROGRESS: 'stroke-info/70',
  FAILED: 'stroke-err/70',
  PENDING: 'stroke-line-strong',
};

const nodeTone: Record<TaskNode['status'], string> = {
  SUCCESS: 'border-line-strong',
  IN_PROGRESS: 'border-info/50 shadow-[0_0_0_3px_var(--dc-info-soft)]',
  FAILED: 'border-err/50',
  PENDING: 'border-line-strong border-dashed',
};

/** Dependency DAG: layered layout, SVG edges, status-colored nodes; nodes are buttons. */
export function TaskGraphView({
  tasks,
  ready,
  selectedId,
  onSelect,
}: {
  tasks: TaskNode[];
  ready: Map<string, TaskReadiness>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(
    () =>
      layoutDag(tasks, {
        nodeWidth: NODE_W,
        nodeHeight: NODE_H,
        gapX: 14,
        gapY: 40,
        padding: 20,
        direction: 'TB',
      }),
    [tasks],
  );
  const [hoverId, setHoverId] = useState<string | null>(null);
  const focusId = hoverId ?? selectedId;
  const hood = useMemo(() => (focusId ? neighbourhood(tasks, focusId) : null), [tasks, focusId]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const related = (id: string) => !hood || id === focusId || hood.up.has(id) || hood.down.has(id);
  const edgeRelated = (from: string, to: string) =>
    !hood ||
    ((from === focusId || hood.up.has(from)) && (to === focusId || hood.up.has(to))) ||
    ((to === focusId || hood.down.has(to)) && (from === focusId || hood.down.has(from)));

  return (
    <div className="relative overflow-x-auto">
      <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
        <svg
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute inset-0"
          aria-hidden
        >
          <defs>
            <marker
              id="dag-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-faint" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const from = byId.get(e.from);
            const on = edgeRelated(e.from, e.to);
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={e.path}
                fill="none"
                strokeWidth={on && hood ? 1.75 : 1.25}
                markerEnd="url(#dag-arrow)"
                className={cn(
                  'transition-opacity duration-200',
                  from ? edgeTone[from.status] : 'stroke-line-strong',
                  !on && 'opacity-20',
                )}
              />
            );
          })}
        </svg>

        {layout.nodes.map((n) => {
          const t = byId.get(n.id);
          if (!t) return null;
          const r = ready.get(t.id);
          const selected = t.id === selectedId;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelect(t.id)}
              onPointerEnter={() => setHoverId(t.id)}
              onPointerLeave={() => setHoverId(null)}
              onFocus={() => setHoverId(t.id)}
              onBlur={() => setHoverId(null)}
              aria-pressed={selected}
              aria-label={`${t.id}: ${t.title}. ${t.status.toLowerCase().replace('_', ' ')}${r === 'ready' ? ', ready to run' : r === 'blocked' ? ', blocked by a failed dependency' : ''}`}
              className={cn(
                'absolute flex flex-col justify-center gap-1 rounded-md border bg-panel px-2.5 text-left transition-[opacity,border-color,box-shadow,transform] duration-200 ease-snappy',
                'hover:-translate-y-px hover:border-fg-2/40',
                nodeTone[t.status],
                selected && 'border-accent shadow-[0_0_0_3px_var(--dc-accent-soft)]',
                !related(t.id) && 'opacity-35',
              )}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <TaskStatusDot status={t.status} />
                <span className="truncate font-mono text-2xs text-muted">{t.id}</span>
                {r === 'ready' && (
                  <span className="ml-auto shrink-0 rounded border border-ok/30 px-1 text-[10px] leading-4 text-ok">
                    ready
                  </span>
                )}
                {r === 'blocked' && (
                  <span className="ml-auto shrink-0 rounded border border-err/30 px-1 text-[10px] leading-4 text-err">
                    blocked
                  </span>
                )}
                {t.status === 'IN_PROGRESS' && (
                  <span className="ml-auto shrink-0 rounded border border-info/30 px-1 text-[10px] leading-4 text-info">
                    running
                  </span>
                )}
              </span>
              <span className="truncate text-[12px] leading-4 text-fg">{t.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
