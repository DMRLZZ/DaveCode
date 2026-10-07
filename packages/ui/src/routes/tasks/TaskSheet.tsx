import { Search } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { TaskStatusDot } from '../../components/domain';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Sheet } from '../../components/ui/Overlay';
import { cn } from '../../lib/cn';
import { useCreateTask, useUpdateTask } from '../../lib/queries';
import {
  createBody,
  type DraftErrors,
  dependencyCandidates,
  draftFromTask,
  emptyDraft,
  isEmptyPatch,
  patchFrom,
  slugifyTaskId,
  type TaskDraft,
  uniqueTaskId,
  validateDraft,
} from '../../lib/task-edit';
import { writeErrorMessage } from '../../lib/task-errors';
import { toast } from '../../lib/toast';
import type { TaskNode } from '../../lib/types';

/** `task` set: edit that task; otherwise the sheet creates a new one. */
export function TaskSheet({
  open,
  task,
  tasks,
  onClose,
}: {
  open: boolean;
  task?: TaskNode | undefined;
  tasks: TaskNode[];
  onClose: () => void;
}) {
  const editing = task !== undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit task' : 'New task'}
      description={
        editing ? (
          <span className="font-mono">{task.id}</span>
        ) : (
          'The task starts as pending and is picked up in dependency order.'
        )
      }
      width="w-[min(560px,100vw)]"
    >
      {open && <TaskForm key={task?.id ?? 'new'} task={task} tasks={tasks} onDone={onClose} />}
    </Sheet>
  );
}

function TaskForm({
  task,
  tasks,
  onDone,
}: {
  task: TaskNode | undefined;
  tasks: TaskNode[];
  onDone: () => void;
}) {
  const create = useCreateTask();
  const update = useUpdateTask();
  const [draft, setDraft] = useState<TaskDraft>(() => (task ? draftFromTask(task) : emptyDraft()));
  const [idTouched, setIdTouched] = useState(false);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const onTitle = (title: string) =>
    setDraft((d) => ({
      ...d,
      title,
      ...(!task && !idTouched ? { id: uniqueTaskId(slugifyTaskId(title), tasks) } : {}),
    }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const found = validateDraft(draft, tasks, task?.id);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      if (task) {
        const patch = patchFrom(task, draft);
        if (!isEmptyPatch(patch)) await update.mutateAsync({ id: task.id, patch });
        toast({ tone: 'ok', title: 'Task updated', description: task.id });
      } else {
        const created = await create.mutateAsync(createBody(draft));
        toast({ tone: 'ok', title: 'Task created', description: created.id });
      }
      onDone();
    } catch (err) {
      setServerError(writeErrorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <Field label="Title" required error={errors.title}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            autoFocus
            value={draft.title}
            onChange={(e) => onTitle(e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            placeholder="Add the /health endpoint"
          />
        )}
      </Field>

      {!task && (
        <Field
          label="Id"
          required
          error={errors.id}
          hint="Lowercase kebab-case. Used for the branch name and in dependencies; it cannot change later."
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={draft.id}
              onChange={(e) => {
                setIdTouched(true);
                set('id', e.target.value);
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
            />
          )}
        </Field>
      )}

      <Field label="Description">
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            value={draft.description}
            onChange={(e) => set('description', e.target.value)}
            aria-describedby={describedBy}
            placeholder="What needs to be done and why."
          />
        )}
      </Field>

      <Field
        label="Acceptance criteria"
        hint="One per line. The validator and judge check the result against these."
      >
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            value={draft.acceptance}
            onChange={(e) => set('acceptance', e.target.value)}
            aria-describedby={describedBy}
            placeholder={'GET /health returns 200\nThe route has a test'}
          />
        )}
      </Field>

      <Field
        label="Priority"
        error={errors.priority}
        hint="Higher runs first among unblocked tasks. Empty means 0."
        className="max-w-40"
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            inputMode="decimal"
            value={draft.priority}
            onChange={(e) => set('priority', e.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            className="tnum font-mono"
          />
        )}
      </Field>

      <DependencyPicker
        tasks={tasks}
        selfId={task?.id}
        value={draft.dependsOn}
        onChange={(v) => set('dependsOn', v)}
        error={errors.dependsOn}
      />

      {task && (
        <Field label="Notes" hint="Written by the runner after each attempt; edit to leave a hint.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              aria-describedby={describedBy}
            />
          )}
        </Field>
      )}

      {serverError && (
        <Callout tone="err" title={task ? 'Could not save the task' : 'Could not create the task'}>
          {serverError}
        </Callout>
      )}

      <div className="sticky -bottom-4 -mx-5 -mb-4 flex items-center justify-end gap-2 border-t border-line bg-panel px-5 py-3">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={pending}>
          {task ? 'Save changes' : 'Create task'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Multi-select of the tasks this one waits on. The task being edited and everything that
 * (transitively) depends on it are not offered, so a cycle cannot be built from here.
 */
export function DependencyPicker({
  tasks,
  selfId,
  value,
  onChange,
  error,
}: {
  tasks: TaskNode[];
  selfId?: string | undefined;
  value: string[];
  onChange: (value: string[]) => void;
  error?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => dependencyCandidates(tasks, selfId), [tasks, selfId]);
  const known = new Set(tasks.map((t) => t.id));
  const hidden = tasks.length - candidates.length - (selfId ? 1 : 0);

  const q = query.trim().toLowerCase();
  const visible = candidates.filter(
    (t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
  );
  // Dependencies that no longer exist stay listed so they can be removed.
  const stale = value.filter((id) => !known.has(id));

  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((v) => v !== id));

  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={error ? 'deps-error' : undefined}>
      <legend className="mb-1.5 flex w-full items-baseline gap-2 text-[12px] font-medium text-fg-2">
        Depends on
        <span className="tnum font-normal text-muted">
          {value.length === 0 ? 'none' : `${value.length} selected`}
        </span>
      </legend>

      <div className="rounded-md border border-line-strong bg-bg">
        <div className="relative border-b border-line">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
            strokeWidth={1.75}
          />
          <input
            type="search"
            aria-label="Filter tasks"
            placeholder="Filter tasks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full bg-transparent pr-2.5 pl-8 text-[13px] text-fg placeholder:text-faint focus-visible:outline-none"
          />
        </div>
        <ul className="max-h-48 overflow-y-auto p-1">
          {stale.map((id) => (
            <li key={id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-hover">
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggle(id, false)}
                  className="size-3.5 accent-accent"
                />
                <span className="font-mono text-err">{id}</span>
                <span className="text-muted">unknown task, uncheck to remove</span>
              </label>
            </li>
          ))}
          {visible.length === 0 && stale.length === 0 && (
            <li className="px-2 py-3 text-center text-[12px] text-faint">
              {tasks.length === 0 ? 'No other tasks yet.' : 'No tasks match.'}
            </li>
          )}
          {visible.map((t) => {
            const checked = value.includes(t.id);
            return (
              <li key={t.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-hover',
                    checked && 'bg-hover/60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggle(t.id, e.target.checked)}
                    className="size-3.5 accent-accent"
                  />
                  <TaskStatusDot status={t.status} />
                  <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                  <span className="shrink-0 font-mono text-2xs text-muted">{t.id}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      {error ? (
        <p id="deps-error" role="alert" className="text-[12px] leading-4 text-err">
          {error}
        </p>
      ) : (
        <p className="text-[12px] leading-4 text-muted">
          This task waits until every selected task is done.
          {selfId &&
            hidden > 0 &&
            ` ${hidden} dependent task${hidden === 1 ? '' : 's'} hidden: choosing them would create a cycle.`}
        </p>
      )}
    </fieldset>
  );
}
