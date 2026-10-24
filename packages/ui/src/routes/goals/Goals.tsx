import {
  ChevronDown,
  ChevronRight,
  FileText,
  Play,
  ShieldCheck,
  Square,
  Target,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { TaskStatusBadge } from '../../components/domain';
import { Markdown } from '../../components/Markdown';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { CommandHint, CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field, Input, Textarea } from '../../components/ui/Field';
import { Dialog } from '../../components/ui/Overlay';
import { PageHeader, Panel, PanelHeader } from '../../components/ui/Panel';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { errorMessage, isApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useLive } from '../../lib/data';
import { formatClock, formatCompact, formatRelative } from '../../lib/format';
import {
  useCancelGoal,
  useExecuteGoal,
  useGoalArtifact,
  useGoals,
  useStartGoal,
} from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Goal, GoalStart, GoalStatus } from '../../lib/types';

const STATUS_TONE: Record<GoalStatus, Tone> = {
  planning: 'info',
  running: 'info',
  reviewing: 'info',
  planned: 'accent',
  succeeded: 'ok',
  failed: 'err',
  cancelled: 'neutral',
  budget_exhausted: 'warn',
};

const STATUS_LABEL: Record<GoalStatus, string> = {
  planning: 'planning',
  running: 'running',
  reviewing: 'reviewing',
  planned: 'planned (dry run)',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  budget_exhausted: 'out of budget',
};

const ACTIVE: ReadonlySet<GoalStatus> = new Set(['planning', 'running', 'reviewing']);

export function isActiveGoal(goal: Pick<Goal, 'status'>): boolean {
  return ACTIVE.has(goal.status);
}

function optionalInt(value: string): number | undefined {
  const n = Number(value);
  return value.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function Goals() {
  const goals = useGoals();
  const [selected, setSelected] = useState<string>();
  const unavailable = isApiError(goals.error) && goals.error.status === 501;
  const list = goals.data ?? [];
  const current = list.find((g) => g.id === selected) ?? list[0];
  const running = list.find(isActiveGoal);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Goals"
        description="Give the agent team an objective: a planner splits it into tasks, role agents execute them, a reviewer re-plans until it is done or the budget runs out."
      />

      {unavailable ? (
        <Callout tone="warn" title="Goal mode unavailable">
          <p>
            This gateway answered <code className="font-mono text-fg">501 goals_unavailable</code>:
            it was started outside a project. Start it inside a repository with a project brain, or
            run a goal from the terminal:
          </p>
          <CommandHint command={'davecode goal "<objective>"'} className="mt-2 max-w-sm" />
        </Callout>
      ) : (
        <NewGoal busy={running?.id} onStarted={(goal) => setSelected(goal.id)} />
      )}
      {goals.isError && !unavailable && (
        <Callout tone="err" title="Could not load goals">
          {errorMessage(goals.error)}
        </Callout>
      )}

      {!unavailable && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Panel aria-labelledby="goal-list-title" className="xl:self-start">
            <PanelHeader
              id="goal-list-title"
              title="History"
              meta={list.length ? `${list.length} goal${list.length === 1 ? '' : 's'}` : undefined}
            />
            {goals.isPending ? (
              <SkeletonRows rows={4} className="p-3" />
            ) : list.length === 0 ? (
              <EmptyState
                icon={Target}
                title="No goals yet"
                description="Describe an objective above, or try a dry run to see the plan first."
              />
            ) : (
              <ul className="flex flex-col p-1.5" aria-label="Goals">
                {list.map((goal) => {
                  const done = goal.tasks.filter((t) => t.status === 'SUCCESS').length;
                  const isCurrent = goal.id === current?.id;
                  return (
                    <li key={goal.id}>
                      <button
                        type="button"
                        aria-current={isCurrent ? 'true' : undefined}
                        onClick={() => setSelected(goal.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-150',
                          isCurrent ? 'bg-hover' : 'hover:bg-hover/60',
                        )}
                      >
                        <span className="line-clamp-2 text-[13px] leading-5 text-fg">
                          {goal.objective}
                        </span>
                        <span className="flex items-center gap-2 text-2xs text-muted">
                          <Badge tone={STATUS_TONE[goal.status]} dot pulse={isActiveGoal(goal)}>
                            {STATUS_LABEL[goal.status]}
                          </Badge>
                          <span className="tnum">
                            {done}/{goal.tasks.length} tasks
                          </span>
                          <span className="ml-auto">
                            {formatRelative(Date.parse(goal.createdAt))}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {current ? <GoalDetail goal={current} /> : null}
        </div>
      )}
    </div>
  );
}

function NewGoal({ busy, onStarted }: { busy?: string; onStarted: (goal: Goal) => void }) {
  const start = useStartGoal();
  const [objective, setObjective] = useState('');
  const [rounds, setRounds] = useState('');
  const [tasks, setTasks] = useState('');
  const [tokens, setTokens] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!objective.trim()) {
      setError('Describe what the team should achieve.');
      return;
    }
    setError(null);
    const body: GoalStart = { objective: objective.trim() };
    const maxRounds = optionalInt(rounds);
    const maxTasks = optionalInt(tasks);
    const maxTokens = optionalInt(tokens);
    if (maxRounds) body.maxRounds = maxRounds;
    if (maxTasks) body.maxTasks = maxTasks;
    if (maxTokens) body.maxTokens = maxTokens;
    if (dryRun) body.dryRun = true;
    start.mutate(body, {
      onSuccess: (goal) => {
        toast({
          tone: 'info',
          title: dryRun ? 'Planning (dry run)' : 'Goal started',
          description: goal.objective,
        });
        setObjective('');
        onStarted(goal);
      },
      onError: (err) =>
        toast({
          tone: 'err',
          title: 'Could not start the goal',
          description:
            isApiError(err) && err.code === 'busy'
              ? `${err.message}. Goals and the runner take turns on the working tree.`
              : errorMessage(err),
        }),
    });
  };

  return (
    <Panel aria-labelledby="new-goal-title">
      <PanelHeader
        id="new-goal-title"
        title="New goal"
        meta={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck aria-hidden className="size-3.5 text-ok" strokeWidth={1.75} />
            Never emails, posts, pays or signs up: those become drafts
          </span>
        }
      />
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <Field label="Objective" required error={error}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              rows={2}
              maxLength={4000}
              placeholder="e.g. Write positioning and landing-page copy for this project, then add a /pricing page"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Max rounds" className="w-28">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                placeholder="4"
                value={rounds}
                onChange={(e) => setRounds(e.target.value)}
              />
            )}
          </Field>
          <Field label="Max tasks" className="w-28">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                placeholder="12"
                value={tasks}
                onChange={(e) => setTasks(e.target.value)}
              />
            )}
          </Field>
          <Field label="Token budget" className="w-36">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                placeholder="1000000"
                value={tokens}
                onChange={(e) => setTokens(e.target.value)}
              />
            )}
          </Field>
          <span className="flex h-8 items-center gap-2 text-[12px] text-fg-2">
            <Switch checked={dryRun} onChange={setDryRun} label="Dry run" />
            Dry run (plan only)
          </span>
          <Button
            type="submit"
            variant="primary"
            icon={Play}
            className="ml-auto"
            loading={start.isPending}
            disabled={start.isPending || (Boolean(busy) && !dryRun)}
            title={busy && !dryRun ? `Goal ${busy} is still running` : undefined}
          >
            {dryRun ? 'Plan' : 'Start goal'}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Meter({
  label,
  value,
  max,
  format = String,
}: {
  label: string;
  value: number;
  max: number;
  format?: (n: number) => string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="tnum font-mono text-fg">
          {format(value)}
          <span className="text-muted"> / {format(max)}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-track" aria-hidden>
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-snappy',
            pct >= 90 ? 'bg-warn' : 'bg-accent',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function GoalDetail({ goal }: { goal: Goal }) {
  const cancel = useCancelGoal();
  const execute = useExecuteGoal();
  const live = useLive();
  const [confirm, setConfirm] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<string>();
  const active = isActiveGoal(goal);
  const done = goal.tasks.filter((t) => t.status === 'SUCCESS').length;
  const logs = live.events.filter(
    (e): e is Extract<typeof e, { type: 'goal.log' }> =>
      e.type === 'goal.log' && e.goalId === goal.id,
  );

  const doCancel = () =>
    cancel.mutate(goal.id, {
      onSuccess: (g) =>
        toast({ tone: 'info', title: `Goal ${g.status}`, description: g.objective }),
      onError: (err) =>
        toast({ tone: 'err', title: 'Could not cancel', description: errorMessage(err) }),
    });

  const doExecute = () =>
    execute.mutate(goal.id, {
      onSuccess: (g) =>
        toast({ tone: 'info', title: 'Executing planned goal', description: g.objective }),
      onError: (err) =>
        toast({ tone: 'err', title: 'Could not execute plan', description: errorMessage(err) }),
    });

  return (
    <Panel aria-labelledby="goal-detail-title" className="min-w-0">
      <PanelHeader
        id="goal-detail-title"
        title={<span className="font-mono text-2xs text-muted">{goal.id}</span>}
        meta={
          <Badge tone={STATUS_TONE[goal.status]} dot pulse={active}>
            {STATUS_LABEL[goal.status]}
          </Badge>
        }
        actions={
          <>
            {goal.status === 'planned' && (
              <Button
                size="sm"
                variant="primary"
                icon={Play}
                loading={execute.isPending}
                onClick={doExecute}
              >
                Execute plan
              </Button>
            )}
            {active && (
              <Button
                size="sm"
                variant="danger"
                icon={Square}
                loading={cancel.isPending}
                onClick={() => setConfirm(true)}
              >
                Cancel
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-4 p-4">
        <p className="text-[15px] leading-6 font-medium text-fg">{goal.objective}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <Meter label="Rounds" value={goal.round} max={goal.limits.maxRounds} />
          <Meter label="Tasks done" value={done} max={Math.max(goal.tasks.length, 1)} />
          <Meter
            label="Tokens"
            value={goal.limits.tokensUsed}
            max={goal.limits.maxTokens}
            format={formatCompact}
          />
        </div>
        {goal.lastError && (
          <p className="rounded-md border border-err/30 bg-err-soft p-2 font-mono text-2xs text-err">
            {goal.lastError}
          </p>
        )}

        <section aria-label="Tasks" className="flex flex-col">
          {goal.tasks.length === 0 ? (
            <p className="text-[12px] text-muted">
              {active ? 'The planner is drafting the task graph…' : 'No tasks were planned.'}
            </p>
          ) : (
            <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
              {goal.tasks.map((task) => (
                <li
                  key={task.id}
                  className={cn(
                    'flex flex-col gap-1.5 px-3 py-2.5',
                    task.id === goal.activeTaskId && 'bg-accent-soft/40',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <TaskStatusBadge status={task.status} />
                    <span className="font-mono text-2xs text-muted">{task.id}</span>
                    <span className="min-w-0 flex-1 text-[13px] text-fg">{task.title}</span>
                    <Badge mono>{task.role}</Badge>
                    <Badge tone={task.kind === 'code' ? 'accent' : 'neutral'} mono>
                      {task.kind}
                    </Badge>
                    {task.round > 1 && <Badge mono>round {task.round}</Badge>}
                  </div>
                  {task.dependsOn.length > 0 && (
                    <p className="text-2xs text-muted">after {task.dependsOn.join(', ')}</p>
                  )}
                  {task.artifact && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 font-mono text-2xs text-fg-2">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenArtifact((prev) => (prev === task.id ? undefined : task.id))
                          }
                          aria-expanded={openArtifact === task.id}
                          className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-fg-2 transition-colors hover:bg-hover hover:text-fg"
                        >
                          {openArtifact === task.id ? (
                            <ChevronDown aria-hidden className="size-3.5 text-muted" />
                          ) : (
                            <ChevronRight aria-hidden className="size-3.5 text-muted" />
                          )}
                          <FileText
                            aria-hidden
                            className="size-3.5 text-muted"
                            strokeWidth={1.75}
                          />
                          <span className="truncate">{task.artifact}</span>
                        </button>
                        <CopyButton value={task.artifact} label="Copy path" />
                      </div>
                      {openArtifact === task.id && (
                        <ArtifactReader goalId={goal.id} taskId={task.id} />
                      )}
                    </div>
                  )}
                  {task.status === 'FAILED' && task.notes && (
                    <p className="line-clamp-3 font-mono text-2xs text-err">{task.notes}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        {goal.summary && (
          <section aria-label="Summary" className="rounded-md border border-line bg-raised/40 p-3">
            <Markdown source={goal.summary} className="text-[13px]" />
          </section>
        )}

        <section
          aria-label="Goal log"
          className="term max-h-64 overflow-auto rounded-md border border-line bg-term py-2 font-mono text-[12px] leading-[1.6]"
        >
          {logs.length === 0 ? (
            <p className="px-3 text-muted">
              {active ? 'Waiting for agent output…' : 'No live log for this goal in this session.'}
            </p>
          ) : (
            logs.map((l) => (
              <div key={`${l.ts}-${l.message}`} className="flex gap-3 px-3">
                <span className="tnum shrink-0 text-faint select-none">{formatClock(l.ts)}</span>
                <span className="w-20 shrink-0 truncate text-info">{l.role ?? 'goal'}</span>
                <span
                  className={cn(
                    'min-w-0 break-words',
                    l.level === 'error'
                      ? 'text-err'
                      : l.level === 'warn'
                        ? 'text-warn'
                        : 'text-fg-2',
                  )}
                >
                  {l.message}
                </span>
              </div>
            ))
          )}
        </section>
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Cancel this goal?"
        description="The agent in flight is stopped. Finished artifacts and merged code stay; an interrupted code task keeps its partial work on its branch."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep going
            </Button>
            <Button
              variant="danger"
              icon={Square}
              onClick={() => {
                setConfirm(false);
                doCancel();
              }}
            >
              Cancel goal
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-muted">{goal.objective}</p>
      </Dialog>
    </Panel>
  );
}

function ArtifactReader({ goalId, taskId }: { goalId: string; taskId: string }) {
  const artifact = useGoalArtifact(goalId, taskId);
  if (artifact.isPending) {
    return <SkeletonRows rows={3} className="p-2" />;
  }
  if (artifact.isError) {
    return (
      <p className="rounded-md border border-err/30 bg-err-soft p-2 font-mono text-2xs text-err">
        {errorMessage(artifact.error)}
      </p>
    );
  }
  return (
    <div className="rounded-md border border-line bg-raised/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-line pb-1.5">
        <span className="font-mono text-2xs text-muted">{artifact.data.path}</span>
        <CopyButton value={artifact.data.content} label="Copy markdown" />
      </div>
      <Markdown source={artifact.data.content} className="text-[13px]" />
    </div>
  );
}
