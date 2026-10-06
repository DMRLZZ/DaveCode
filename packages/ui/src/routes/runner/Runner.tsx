import { Bot, Check, GitBranch, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TaskStatusBadge } from '../../components/domain';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { CommandHint } from '../../components/ui/CopyButton';
import { Dialog } from '../../components/ui/Overlay';
import { PageHeader, Panel, PanelHeader } from '../../components/ui/Panel';
import { Skeleton } from '../../components/ui/Skeleton';
import { errorMessage, isApiError, type RunnerAction } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useData, useLive } from '../../lib/data';
import { formatDuration } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useRunner, useRunnerAction, useTasks } from '../../lib/queries';
import { Link } from '../../lib/router';
import { toast } from '../../lib/toast';
import type { RunnerState } from '../../lib/types';
import { LogConsole } from './LogConsole';

const PIPELINE: RunnerState[] = [
  'idle',
  'selecting',
  'preparing',
  'implementing',
  'validating',
  'repairing',
  'merging',
];

const STATE_COPY: Record<RunnerState, string> = {
  idle: 'Waiting for work',
  selecting: 'Picking the next unblocked task',
  preparing: 'Creating the task branch and loading the brain',
  implementing: 'Writing code through the gateway',
  validating: 'Running lint, typecheck and tests',
  repairing: 'Feeding failures back for another attempt',
  merging: 'Merging the task branch',
  paused: 'Paused; resumes at the same step',
  stopped: 'Stopped',
  error: 'Stopped on an error',
};

const STATE_TONE: Record<RunnerState, Tone> = {
  idle: 'neutral',
  selecting: 'info',
  preparing: 'info',
  implementing: 'info',
  validating: 'info',
  repairing: 'warn',
  merging: 'ok',
  paused: 'warn',
  stopped: 'neutral',
  error: 'err',
};

const MAX_REPAIRS = 3;

export function Runner() {
  const runner = useRunner();
  const tasks = useTasks();
  const live = useLive();
  const { live: store } = useData();
  const action = useRunnerAction();
  const now = useNow(1000);
  const [confirmStop, setConfirmStop] = useState(false);

  const unavailable = isApiError(runner.error) && runner.error.status === 501;
  // A 501 means there is no runner at all: ignore any status cached from earlier events.
  const status = unavailable ? undefined : runner.data;
  const state = status?.state;
  const task = tasks.data?.graph.tasks.find((t) => t.id === status?.taskId);

  // While paused/stopped, show where in the pipeline the runner was (from the event history).
  const lastActive = useMemo<RunnerState | undefined>(() => {
    if (unavailable) return undefined;
    if (state && PIPELINE.includes(state)) return state;
    for (let i = live.events.length - 1; i >= 0; i--) {
      const e = live.events[i];
      if (e?.type === 'runner.status' && PIPELINE.includes(e.status.state)) return e.status.state;
    }
    return undefined;
  }, [unavailable, state, live.events]);

  const run = async (a: RunnerAction) => {
    try {
      const next = await action.mutateAsync(a);
      toast({ tone: 'info', title: `Runner ${next.state}`, description: STATE_COPY[next.state] });
    } catch (err) {
      toast({
        tone: 'err',
        title: `Could not ${a} the runner`,
        description:
          isApiError(err) && err.code === 'runner_unavailable'
            ? 'This gateway was started without the autonomous runner.'
            : errorMessage(err),
      });
    }
  };

  const running = state !== undefined && !['idle', 'paused', 'stopped', 'error'].includes(state);
  const canStart =
    !unavailable &&
    (state === 'idle' || state === 'paused' || state === 'stopped' || state === 'error');
  const elapsed = status?.startedAt ? (now - Date.parse(status.startedAt)) / 1000 : undefined;
  const repairs = status?.repairCycle ?? 0;
  const tasksDone = tasks.data?.graph.tasks.filter((t) => t.status === 'SUCCESS').length ?? 0;
  const tasksTotal = tasks.data?.graph.tasks.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Runner"
        description="The autonomous engineer: one task at a time, on its own branch, merged only when checks pass."
        actions={
          <>
            <Button
              variant="primary"
              icon={Play}
              disabled={!canStart || action.isPending}
              loading={action.isPending && action.variables === 'start'}
              onClick={() => run('start')}
            >
              {state === 'paused' ? 'Resume' : 'Start'}
            </Button>
            <Button
              icon={Pause}
              disabled={unavailable || !running || action.isPending}
              loading={action.isPending && action.variables === 'pause'}
              onClick={() => run('pause')}
            >
              Pause
            </Button>
            <Button
              variant="danger"
              icon={Square}
              disabled={
                unavailable ||
                state === 'stopped' ||
                state === 'idle' ||
                state === undefined ||
                action.isPending
              }
              onClick={() => setConfirmStop(true)}
            >
              Stop
            </Button>
          </>
        }
      />

      {unavailable && (
        <Callout tone="warn" title="Runner unavailable">
          <p>
            This gateway answered <code className="font-mono text-fg">501 runner_unavailable</code>:
            it is running without the autonomous engine. Routing and the dashboard keep working;
            start the runner from a project directory to drive the task graph:
          </p>
          <CommandHint command="davecode run" className="mt-2 max-w-sm" />
        </Callout>
      )}
      {runner.isError && !unavailable && (
        <Callout tone="err" title="Could not read the runner status">
          {errorMessage(runner.error)}
        </Callout>
      )}

      <Panel aria-labelledby="machine-title">
        <PanelHeader
          id="machine-title"
          title="State machine"
          meta={state ? STATE_COPY[state] : undefined}
          actions={
            state && (
              <Badge tone={STATE_TONE[state]} dot pulse={running}>
                {state}
              </Badge>
            )
          }
        />
        <div className="p-4">
          {runner.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <ol className="flex flex-wrap items-center gap-y-3" aria-label="Runner pipeline">
              {PIPELINE.map((s, i) => {
                const current = s === lastActive;
                const isLive = current && running;
                const idx = lastActive ? PIPELINE.indexOf(lastActive) : -1;
                const past = idx > 0 && i > 0 && i < idx && !(s === 'repairing' && repairs === 0);
                return (
                  <li
                    key={s}
                    className="flex items-center"
                    aria-current={current ? 'step' : undefined}
                  >
                    {i > 0 && (
                      <span
                        aria-hidden
                        className={cn(
                          'mx-1.5 h-px w-4 sm:w-6',
                          past || current ? 'bg-fg-2/50' : 'bg-line-strong',
                        )}
                      />
                    )}
                    <span
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 font-mono text-[12px] transition-colors duration-200',
                        current
                          ? state === 'paused' || state === 'stopped'
                            ? 'border-warn/50 bg-warn-soft text-warn'
                            : s === 'repairing'
                              ? 'border-warn/50 bg-warn-soft text-warn'
                              : 'border-accent/60 bg-accent-soft text-accent-text shadow-[0_0_0_3px_var(--dc-accent-soft)]'
                          : past
                            ? 'border-line-strong text-fg-2'
                            : 'border-line text-faint',
                      )}
                    >
                      {past && <Check aria-hidden className="size-3" strokeWidth={2.25} />}
                      {s === 'repairing' && !past && (
                        <RotateCcw aria-hidden className="size-3" strokeWidth={2} />
                      )}
                      {isLive && (
                        <span
                          aria-hidden
                          className="size-1.5 animate-pulse-dot rounded-full bg-current"
                        />
                      )}
                      {s}
                      {current && (
                        <span className="sr-only"> (current{state !== s ? `, ${state}` : ''})</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-3 text-[12px] text-muted">
            <RotateCcw aria-hidden className="mr-1 inline size-3 align-[-2px]" strokeWidth={2} />
            Failed validation loops <span className="font-mono">repairing → implementing</span> up
            to {MAX_REPAIRS} times; then the task is marked FAILED and the runner moves on.
          </p>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel aria-labelledby="current-title" className="xl:order-2 xl:self-start">
          <PanelHeader
            id="current-title"
            title="Current task"
            meta={tasksTotal ? `${tasksDone}/${tasksTotal} tasks done` : undefined}
          />
          <div className="flex flex-col gap-3 p-4">
            {runner.isPending ? (
              <>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-56" />
              </>
            ) : task ? (
              <>
                <div>
                  <Link
                    to={`/tasks?task=${encodeURIComponent(task.id)}`}
                    className="font-mono text-2xs text-muted hover:text-fg"
                  >
                    {task.id}
                  </Link>
                  <p className="text-[13px] leading-5 font-medium text-fg">{task.title}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <TaskStatusBadge status={task.status} />
                  {task.attempts !== undefined && <Badge mono>attempt {task.attempts}</Badge>}
                </div>
                <p className="flex items-center gap-1.5 font-mono text-[12px] text-fg-2">
                  <GitBranch aria-hidden className="size-3.5 text-muted" strokeWidth={1.75} />
                  {task.branch ?? `davecode/task-${task.id}`}
                </p>
                <div className="flex items-center justify-between gap-3 text-[12px]">
                  <span className="text-muted">Repair cycle</span>
                  <span className="flex items-center gap-2">
                    <span className="flex gap-1" aria-hidden>
                      {Array.from({ length: MAX_REPAIRS }, (_, i) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size pip row
                          key={i}
                          className={cn(
                            'h-1.5 w-5 rounded-full',
                            i < repairs ? 'bg-warn' : 'bg-track',
                          )}
                        />
                      ))}
                    </span>
                    <span className="tnum font-mono text-fg">
                      {repairs}/{MAX_REPAIRS}
                    </span>
                  </span>
                </div>
                {elapsed !== undefined && (
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="text-muted">Running for</span>
                    <span className="tnum font-mono text-fg">{formatDuration(elapsed)}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2.5 text-[12px] text-muted">
                <Bot aria-hidden className="size-4" strokeWidth={1.5} />
                {unavailable ? 'No runner attached to this gateway.' : 'No task in progress.'}
              </div>
            )}
            {status?.lastError && (
              <p className="rounded-md border border-err/30 bg-err-soft p-2 font-mono text-2xs text-err">
                {status.lastError}
              </p>
            )}
          </div>
        </Panel>
        <LogConsole
          lines={live.logs}
          onClear={() => store.clearLogs()}
          className="h-[480px] xl:order-1"
        />
      </div>

      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop the runner?"
        description="The current step is abandoned. Work done so far stays on the task branch."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Keep running
            </Button>
            <Button
              variant="danger"
              icon={Square}
              onClick={() => {
                setConfirmStop(false);
                void run('stop');
              }}
            >
              Stop runner
            </Button>
          </>
        }
      >
        {task && <p className="font-mono text-[12px] text-muted">{task.id}</p>}
      </Dialog>
    </div>
  );
}
