import { FileText, GitBranch, Kanban, List, Network } from 'lucide-react';
import { useMemo } from 'react';
import { TASK_LABEL, TaskStatusBadge, TaskStatusDot } from '../../components/domain';
import { Markdown } from '../../components/Markdown';
import { Badge } from '../../components/ui/Badge';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader, Panel, PanelHeader } from '../../components/ui/Panel';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton, SkeletonRows } from '../../components/ui/Skeleton';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { layoutDag, readiness, type TaskReadiness } from '../../lib/dag';
import { useBrain, useTasks } from '../../lib/queries';
import { setParam, useLocation } from '../../lib/router';
import type { TaskNode, TaskStatus } from '../../lib/types';
import { TaskDetail } from './TaskDetail';
import { TaskGraphView } from './TaskGraphView';

type View = 'graph' | 'board' | 'list';
type SidePanel = 'task' | 'state' | 'architecture';

const STATUSES: TaskStatus[] = ['IN_PROGRESS', 'PENDING', 'FAILED', 'SUCCESS'];

export function Tasks() {
  const tasksQ = useTasks();
  const brain = useBrain();
  const { params } = useLocation();
  const view = (
    ['graph', 'board', 'list'].includes(params.get('view') ?? '') ? params.get('view') : 'graph'
  ) as View;
  const selectedId = params.get('task');
  const panelParam = params.get('panel') as SidePanel | null;

  const tasks = tasksQ.data?.graph.tasks ?? [];
  const ready = useMemo(() => readiness(tasks), [tasks]);
  const selected = tasks.find((t) => t.id === selectedId);
  const panel: SidePanel = panelParam ?? (selected ? 'task' : 'state');
  const layout = useMemo(() => layoutDag(tasks), [tasks]);

  const counts = useMemo(() => {
    const c: Record<TaskStatus, number> = { PENDING: 0, IN_PROGRESS: 0, SUCCESS: 0, FAILED: 0 };
    for (const t of tasks) c[t.status] += 1;
    return c;
  }, [tasks]);
  const doneRatio = tasks.length ? counts.SUCCESS / tasks.length : 0;

  const select = (id: string) => {
    setParam('panel', null);
    setParam('task', id);
  };

  const project = tasksQ.data?.project;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tasks"
        description={
          project ? (
            <span>
              <span className="text-fg-2">{project.name}</span>{' '}
              <span className="font-mono text-2xs text-faint">
                {project.root}/.davecode/TASK_GRAPH.json
              </span>
            </span>
          ) : (
            'The project task graph the autonomous runner works through.'
          )
        }
        actions={
          <Segmented
            label="Task view"
            value={view}
            onChange={(v) => setParam('view', v === 'graph' ? null : v)}
            options={[
              { value: 'graph', label: 'Graph', icon: Network },
              { value: 'board', label: 'Board', icon: Kanban },
              { value: 'list', label: 'List', icon: List },
            ]}
          />
        }
      />

      {tasksQ.isError && (
        <Callout tone="err" title="Could not load the task graph">
          {errorMessage(tasksQ.error)}
        </Callout>
      )}

      {tasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]">
          <div className="flex items-center gap-2.5">
            <div
              className="h-1.5 w-40 overflow-hidden rounded-full bg-track"
              role="progressbar"
              aria-label="Tasks done"
              aria-valuemin={0}
              aria-valuemax={tasks.length}
              aria-valuenow={counts.SUCCESS}
            >
              <div
                className="h-full rounded-full bg-ok transition-[width] duration-500 ease-snappy"
                style={{ width: `${doneRatio * 100}%` }}
              />
            </div>
            <span className="tnum text-fg-2">
              {counts.SUCCESS} of {tasks.length} done
            </span>
          </div>
          {STATUSES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-muted">
              <TaskStatusDot status={s} />
              {TASK_LABEL[s]} <span className="tnum text-fg-2">{counts[s]}</span>
            </span>
          ))}
          {layout.missing.length > 0 && (
            <Badge tone="warn">{layout.missing.length} unknown dependencies</Badge>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel className="min-h-[420px]">
          {tasksQ.isPending ? (
            <div className="p-4">
              <Skeleton className="h-[380px] w-full" />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No task graph yet"
              description="Describe the work as a DAG of tasks in .davecode/TASK_GRAPH.json and the runner will pick them up in dependency order."
              command="davecode run"
              className="py-20"
            />
          ) : view === 'graph' ? (
            <TaskGraphView tasks={tasks} ready={ready} selectedId={selectedId} onSelect={select} />
          ) : view === 'board' ? (
            <Board tasks={tasks} ready={ready} selectedId={selectedId} onSelect={select} />
          ) : (
            <TaskList tasks={tasks} ready={ready} selectedId={selectedId} onSelect={select} />
          )}
        </Panel>

        <Panel className="xl:sticky xl:top-16 xl:max-h-[calc(100dvh-5rem)] xl:self-start">
          <PanelHeader
            title={
              <Segmented
                size="sm"
                label="Side panel"
                value={panel}
                onChange={(v) => setParam('panel', v)}
                options={[
                  ...(selected ? [{ value: 'task' as const, label: 'Task', icon: GitBranch }] : []),
                  { value: 'state', label: 'STATE.md', icon: FileText },
                  { value: 'architecture', label: 'ARCHITECTURE.md', icon: FileText },
                ]}
              />
            }
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'task' && selected ? (
              <TaskDetail
                task={selected}
                tasks={tasks}
                readiness={ready.get(selected.id)}
                onSelect={select}
                onClose={() => {
                  setParam('task', null);
                  setParam('panel', null);
                }}
              />
            ) : brain.isPending ? (
              <SkeletonRows rows={6} />
            ) : brain.isError ? (
              <p className="p-4 text-[12px] text-err">{errorMessage(brain.error)}</p>
            ) : (
              <Markdown
                className="p-4"
                source={
                  (panel === 'architecture' ? brain.data?.architecture : brain.data?.state) ||
                  '_This file is empty._'
                }
              />
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

interface ViewProps {
  tasks: TaskNode[];
  ready: Map<string, TaskReadiness>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function ReadyTag({ r }: { r: TaskReadiness | undefined }) {
  if (r === 'ready') return <Badge tone="ok">ready</Badge>;
  if (r === 'blocked') return <Badge tone="err">blocked</Badge>;
  return null;
}

function Board({ tasks, ready, selectedId, onSelect }: ViewProps) {
  return (
    <div className="grid grid-cols-1 gap-px overflow-x-auto bg-line sm:grid-cols-2 lg:grid-cols-4">
      {STATUSES.map((status) => {
        const column = tasks
          .filter((t) => t.status === status)
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        return (
          <section
            key={status}
            aria-label={TASK_LABEL[status]}
            className="flex min-w-0 flex-col bg-panel"
          >
            <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] font-medium text-fg-2">
              <TaskStatusDot status={status} />
              {TASK_LABEL[status]}
              <span className="tnum ml-auto text-muted">{column.length}</span>
            </h3>
            <ul className="flex flex-col gap-2 p-2">
              {column.length === 0 && (
                <li className="px-1 py-3 text-center text-[12px] text-faint">Empty</li>
              )}
              {column.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    aria-pressed={t.id === selectedId}
                    className={cn(
                      'flex w-full flex-col gap-1.5 rounded-md border bg-raised p-2.5 text-left transition-colors duration-150 hover:border-fg-2/30',
                      t.id === selectedId ? 'border-accent' : 'border-line',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-2xs text-muted">{t.id}</span>
                      <span className="ml-auto">
                        <ReadyTag r={ready.get(t.id)} />
                      </span>
                    </span>
                    <span className="text-[12px] leading-4 text-fg">{t.title}</span>
                    {t.dependsOn.length > 0 && (
                      <span className="truncate font-mono text-[10px] text-faint">
                        after {t.dependsOn.join(', ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TaskList({ tasks, ready, selectedId, onSelect }: ViewProps) {
  const layers = useMemo(
    () => new Map(layoutDag(tasks).nodes.map((n) => [n.id, n.layer])),
    [tasks],
  );
  const rows = [...tasks].sort(
    (a, b) =>
      (layers.get(a.id) ?? 0) - (layers.get(b.id) ?? 0) || (b.priority ?? 0) - (a.priority ?? 0),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12px]">
        <caption className="sr-only">Tasks in dependency order</caption>
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="px-3.5 py-2 font-medium">
              Task
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              Priority
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Depends on
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.id}
              className={cn(
                'border-b border-line last:border-b-0',
                t.id === selectedId && 'bg-hover/60',
              )}
            >
              <td className="max-w-0 px-3.5 py-2">
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  className="block w-full min-w-0 text-left hover:underline"
                >
                  <span className="block truncate text-[13px] text-fg">{t.title}</span>
                  <span className="block truncate font-mono text-2xs text-muted">{t.id}</span>
                </button>
              </td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-1.5">
                  <TaskStatusBadge status={t.status} />
                  <ReadyTag r={ready.get(t.id)} />
                </span>
              </td>
              <td className="tnum px-2 py-2 text-right font-mono text-fg-2">{t.priority ?? '—'}</td>
              <td className="max-w-0 truncate px-2 py-2 font-mono text-2xs text-muted">
                {t.dependsOn.join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
