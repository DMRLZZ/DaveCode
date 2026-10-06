import { CircleCheck, CircleDashed, GitBranch, X } from 'lucide-react';
import { TaskStatusBadge, TaskStatusDot } from '../../components/domain';
import { Badge } from '../../components/ui/Badge';
import { CopyButton } from '../../components/ui/CopyButton';
import type { TaskReadiness } from '../../lib/dag';
import { formatRelative } from '../../lib/format';
import type { TaskNode } from '../../lib/types';

export function TaskDetail({
  task,
  tasks,
  readiness,
  onSelect,
  onClose,
}: {
  task: TaskNode;
  tasks: TaskNode[];
  readiness: TaskReadiness | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.id));
  const done = task.status === 'SUCCESS';

  return (
    <article aria-labelledby="task-title" className="flex flex-col gap-4 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 font-mono text-2xs text-muted">
            {task.id}
            <CopyButton value={task.id} label="Copy task id" className="size-5" />
          </p>
          <h3
            id="task-title"
            className="mt-0.5 text-[15px] leading-5 font-semibold tracking-tight text-fg"
          >
            {task.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task details"
          className="-mr-1 inline-flex size-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <TaskStatusBadge status={task.status} />
        {readiness === 'ready' && <Badge tone="ok">ready to run</Badge>}
        {readiness === 'blocked' && <Badge tone="err">blocked by a failed dependency</Badge>}
        {task.priority !== undefined && <Badge mono>priority {task.priority}</Badge>}
        {task.attempts !== undefined && <Badge mono>attempt {task.attempts}</Badge>}
      </div>

      {task.branch && (
        <p className="flex items-center gap-1.5 font-mono text-[12px] text-fg-2">
          <GitBranch aria-hidden className="size-3.5 text-muted" strokeWidth={1.75} />
          {task.branch}
        </p>
      )}

      {task.description && <p className="text-[13px] leading-5 text-fg-2">{task.description}</p>}

      {task.acceptance && task.acceptance.length > 0 && (
        <section aria-labelledby="acc-title">
          <h4 id="acc-title" className="eyebrow mb-1.5">
            Acceptance criteria
          </h4>
          <ul className="flex flex-col gap-1">
            {task.acceptance.map((a) => (
              <li key={a} className="flex items-start gap-2 text-[13px] leading-5 text-fg-2">
                {done ? (
                  <CircleCheck
                    aria-label="met"
                    className="mt-0.5 size-3.5 shrink-0 text-ok"
                    strokeWidth={1.75}
                  />
                ) : (
                  <CircleDashed
                    aria-label="not verified yet"
                    className="mt-0.5 size-3.5 shrink-0 text-faint"
                    strokeWidth={1.75}
                  />
                )}
                {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.notes && (
        <section aria-labelledby="notes-title">
          <h4 id="notes-title" className="eyebrow mb-1.5">
            Notes
          </h4>
          <p className="rounded-md border border-line bg-raised p-2.5 text-[12px] leading-5 text-fg-2">
            {task.notes}
          </p>
        </section>
      )}

      <section aria-labelledby="deps-title" className="grid grid-cols-2 gap-3">
        <div>
          <h4 id="deps-title" className="eyebrow mb-1.5">
            Depends on
          </h4>
          <DepList ids={task.dependsOn} byId={byId} onSelect={onSelect} />
        </div>
        <div>
          <h4 className="eyebrow mb-1.5">Unblocks</h4>
          <DepList ids={dependents.map((d) => d.id)} byId={byId} onSelect={onSelect} />
        </div>
      </section>

      {task.updatedAt && (
        <p className="text-2xs text-muted">Updated {formatRelative(Date.parse(task.updatedAt))}</p>
      )}
    </article>
  );
}

function DepList({
  ids,
  byId,
  onSelect,
}: {
  ids: string[];
  byId: Map<string, TaskNode>;
  onSelect: (id: string) => void;
}) {
  if (ids.length === 0) return <p className="text-[12px] text-faint">None</p>;
  return (
    <ul className="flex flex-col gap-0.5">
      {ids.map((id) => {
        const t = byId.get(id);
        return (
          <li key={id}>
            <button
              type="button"
              onClick={() => onSelect(id)}
              className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left font-mono text-[12px] text-fg-2 hover:bg-hover hover:text-fg"
            >
              {t ? <TaskStatusDot status={t.status} /> : <span className="text-err">?</span>}
              <span className="truncate">{id}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
