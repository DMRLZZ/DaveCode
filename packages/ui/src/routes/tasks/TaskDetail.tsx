import { CircleCheck, CircleDashed, GitBranch, Pencil, Play, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { TaskStatusBadge, TaskStatusDot } from '../../components/domain';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { CopyButton } from '../../components/ui/CopyButton';
import { Dialog } from '../../components/ui/Overlay';
import type { TaskReadiness } from '../../lib/dag';
import { formatRelative } from '../../lib/format';
import { useDeleteTask, useRunTask, useUpdateTask } from '../../lib/queries';
import { statusActions } from '../../lib/task-edit';
import { writeErrorMessage } from '../../lib/task-errors';
import { toast } from '../../lib/toast';
import type { TaskNode, TaskStatus } from '../../lib/types';

export function TaskDetail({
  task,
  tasks,
  readiness,
  onSelect,
  onClose,
  onEdit,
}: {
  task: TaskNode;
  tasks: TaskNode[];
  readiness: TaskReadiness | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const run = useRunTask();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const move = (to: TaskStatus, label: string) =>
    update.mutate(
      { id: task.id, patch: { status: to } },
      {
        onSuccess: () => toast({ tone: 'ok', title: label, description: task.id }),
        onError: (err) =>
          toast({
            tone: 'err',
            title: `Could not ${label.toLowerCase()}`,
            description: writeErrorMessage(err),
          }),
      },
    );

  const runNow = () =>
    run.mutate(task.id, {
      onSuccess: () => toast({ tone: 'info', title: 'Runner started', description: task.id }),
      onError: (err) =>
        toast({
          tone: 'err',
          title: 'Could not start the runner',
          description: writeErrorMessage(err),
        }),
    });

  const doDelete = () =>
    remove.mutate(task.id, {
      onSuccess: () => {
        toast({ tone: 'ok', title: 'Task deleted', description: task.id });
        setConfirmDelete(false);
        onClose();
      },
      onError: (err) => setDeleteError(writeErrorMessage(err)),
    });

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

      <div className="flex flex-wrap items-center gap-1.5">
        {readiness === 'ready' && (
          <Button size="sm" variant="primary" icon={Play} loading={run.isPending} onClick={runNow}>
            Run now
          </Button>
        )}
        {statusActions(task.status).map((a) => (
          <Button
            key={a.to}
            size="sm"
            variant={a.variant}
            disabled={update.isPending}
            onClick={() => move(a.to, a.label)}
          >
            {a.label}
          </Button>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={Trash2}
            aria-label={`Delete task ${task.id}`}
            onClick={() => {
              setDeleteError(null);
              setConfirmDelete(true);
            }}
            className="text-err hover:bg-err-soft hover:text-err"
          />
        </span>
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

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${task.id}?`}
        description={
          dependents.length > 0
            ? 'Other tasks depend on this one, so the gateway will refuse until those dependencies are removed.'
            : 'The task is removed from TASK_GRAPH.json. Its branch and any merged work stay in git.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep task
            </Button>
            <Button variant="danger" icon={Trash2} loading={remove.isPending} onClick={doDelete}>
              Delete task
            </Button>
          </>
        }
      >
        <p className="truncate text-[13px] text-fg-2">{task.title}</p>
        {dependents.length > 0 && (
          <p className="mt-2 font-mono text-[12px] text-muted">
            Needed by {dependents.map((d) => d.id).join(', ')}
          </p>
        )}
        {deleteError && (
          <Callout tone="err" title="Could not delete the task" className="mt-3">
            {deleteError}
          </Callout>
        )}
      </Dialog>
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
