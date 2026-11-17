import { GitBranch, GitMerge, Maximize2, Minimize2, Square, TerminalSquare } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useOrchestratorOutput } from '../../lib/data';
import { formatDuration, formatRelative } from '../../lib/format';
import {
  canApply,
  isActiveRun,
  type OutputLine,
  PLAN_TASK_ID,
  planElapsedMs,
  planStatus,
  RUN_STATUS_LABEL,
  runChangedFiles,
  runElapsedMs,
  runProgress,
  TASK_STATUS_LABEL,
  taskElapsedMs,
  withoutPlanReply,
} from '../../lib/orchestrator';
import {
  useApplyOrchestratorRun,
  useCancelOrchestratorRun,
  useOrchestratorTranscript,
} from '../../lib/queries';
import type { OrchestratorAgent, OrchestratorRun, OrchestratorTask } from '../../lib/types';
import { kindMeta } from './kinds';
import { AgentDot, STATUS_TEXT, useNow } from './Orchestrator';

const elapsed = (ms: number | undefined) => (ms === undefined ? '' : formatDuration(ms / 1000));

type CardStatus = keyof typeof TASK_STATUS_LABEL;

/**
 * One orchestrator run as a thread: the objective, the plan, and one live card per agent, all on
 * screen at once, so what every agent is doing is never hidden behind a selection.
 */
export function RunThread({
  run,
  onOpenTerminals,
}: {
  run: OrchestratorRun;
  onOpenTerminals: () => void;
}) {
  const active = isActiveRun(run);
  const now = useNow(active);
  useOrchestratorTranscript(run.id);
  const cancel = useCancelOrchestratorRun();
  const apply = useApplyOrchestratorRun();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const [expanded, setExpanded] = useState<string>();
  const plan = planStatus(run);
  const files = runChangedFiles(run);
  const toggle = (id: string) => setExpanded((current) => (current === id ? undefined : id));

  const doCancel = () =>
    cancel.mutate(run.id, { onError: (e) => setNotice({ error: true, text: errorMessage(e) }) });
  const doApply = () =>
    apply.mutate(run.id, {
      onSuccess: (r) =>
        setNotice({
          error: false,
          text: `Merged ${r.integrationBranch ?? 'the run'} into ${r.baseBranch ?? 'your branch'}.`,
        }),
      onError: (e) => setNotice({ error: true, text: errorMessage(e) }),
    });

  return (
    <section
      aria-label="Orchestrator run"
      className="flex h-full min-h-0 flex-col font-mono text-[11px] text-zinc-400"
    >
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full bg-white', active && 'animate-pulse')}
        />
        <span className={cn('shrink-0', STATUS_TEXT[run.status])} aria-live="polite">
          {RUN_STATUS_LABEL[run.status]}
          {run.appliedAt && <span className="text-zinc-500"> · applied</span>}
        </span>
        {runProgress(run) && (
          <span className="shrink-0 tabular-nums text-zinc-500">{runProgress(run)} tasks</span>
        )}
        <span className="shrink-0 tabular-nums text-zinc-600">
          {elapsed(runElapsedMs(run, now))}
        </span>
        {run.baseBranch && (
          <span
            className="flex min-w-0 items-center gap-1 text-zinc-500"
            title={`${run.baseBranch} → ${run.integrationBranch ?? ''}`}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {run.baseBranch}
              {run.integrationBranch && (
                <span className="text-zinc-600"> → {run.integrationBranch}</span>
              )}
            </span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {active && (
            <button
              type="button"
              onClick={doCancel}
              disabled={cancel.isPending}
              className="flex h-6 items-center gap-1.5 rounded border border-zinc-700 px-2 text-zinc-200 hover:border-zinc-500 hover:text-white disabled:opacity-50"
            >
              <Square aria-hidden className="size-2.5" />
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {canApply(run) && <ApplyButton run={run} pending={apply.isPending} onApply={doApply} />}
          <button
            type="button"
            onClick={onOpenTerminals}
            title="Back to the terminals"
            className="flex h-6 items-center gap-1.5 rounded px-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
          >
            <TerminalSquare aria-hidden className="size-3" />
            Terminals
          </button>
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-100">
                {run.objective}
              </p>
              <p className="mt-1 text-right text-zinc-600">
                {formatRelative(Date.parse(run.createdAt))}
                {run.access === 'full' && ' · agents may run commands'}
              </p>
            </div>
          </div>

          <Narration>
            {run.status === 'planning' ? (
              <>
                <AgentName agent={run.planner} /> is reading the project and splitting the objective
                into tasks.
              </>
            ) : run.tasks.length > 0 ? (
              <>
                <AgentName agent={run.planner} /> planned {run.tasks.length}{' '}
                {run.tasks.length === 1 ? 'task' : 'tasks'}. Each one runs in its own git worktree;
                your files stay untouched until you apply the result.
              </>
            ) : (
              <>The run ended before there was a plan.</>
            )}
          </Narration>

          <ul
            aria-label="Agents"
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}
          >
            <AgentCard
              runId={run.id}
              taskId={PLAN_TASK_ID}
              tag="plan"
              title="Plan the work"
              agent={run.planner}
              status={plan}
              time={elapsed(planElapsedMs(run, now))}
              expanded={expanded === PLAN_TASK_ID}
              onToggle={toggle}
              empty={plan === 'running' ? 'The planner is starting…' : 'No planner output.'}
              plan={run.tasks}
            />
            {run.tasks.map((task) => (
              <TaskCard
                key={task.id}
                run={run}
                task={task}
                time={elapsed(taskElapsedMs(task, now))}
                expanded={expanded === task.id}
                onToggle={toggle}
              />
            ))}
          </ul>

          {!active && (
            <Narration>
              <div className="space-y-2">
                {run.summary && (
                  <p className="whitespace-pre-wrap break-words leading-relaxed text-zinc-200">
                    {run.summary}
                  </p>
                )}
                {run.error && run.error !== run.summary && (
                  <p className="whitespace-pre-wrap break-words text-red-400">{run.error}</p>
                )}
                {files.length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-zinc-500 hover:text-zinc-200">
                      {files.length === 1 ? '1 file changed' : `${files.length} files changed`} on{' '}
                      {run.integrationBranch}
                    </summary>
                    <ul className="mt-1 max-h-40 overflow-y-auto text-zinc-300">
                      {files.map((file) => (
                        <li key={file} className="truncate" title={file}>
                          {file}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {canApply(run) && (
                  <ApplyButton run={run} pending={apply.isPending} onApply={doApply} />
                )}
              </div>
            </Narration>
          )}
          {notice && (
            <p
              role={notice.error ? 'alert' : 'status'}
              className={cn('break-words', notice.error ? 'text-red-400' : 'text-zinc-300')}
            >
              {notice.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ApplyButton({
  run,
  pending,
  onApply,
}: {
  run: OrchestratorRun;
  pending: boolean;
  onApply: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onApply}
      disabled={pending}
      className="flex h-6 max-w-full items-center gap-1.5 rounded border border-zinc-500 bg-zinc-100 px-2 text-black hover:bg-white disabled:opacity-50"
    >
      <GitMerge aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {pending ? 'Applying…' : `Apply to ${run.baseBranch ?? 'base branch'}`}
      </span>
    </button>
  );
}

/** A line from DaveCode itself, between the user's objective and the agents' cards. */
function Narration({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-white" />
      <div className="min-w-0 flex-1 leading-relaxed text-zinc-400">{children}</div>
    </div>
  );
}

function AgentName({ agent }: { agent: OrchestratorAgent | undefined }) {
  if (!agent) return <span className="text-zinc-300">The planner</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-zinc-200">
      <AgentDot agent={agent} />
      {kindMeta(agent).label}
    </span>
  );
}

function TaskCard({
  run,
  task,
  time,
  expanded,
  onToggle,
}: {
  run: OrchestratorRun;
  task: OrchestratorTask;
  time: string;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const showError =
    task.error &&
    (task.status === 'failed' || task.status === 'conflict' || task.status === 'skipped');
  const finished = task.status === 'done' || task.status === 'conflict';
  return (
    <AgentCard
      runId={run.id}
      taskId={task.id}
      tag={task.id}
      title={task.title}
      agent={task.agent}
      status={task.status}
      time={time}
      expanded={expanded}
      onToggle={onToggle}
      empty={
        task.status === 'pending'
          ? `Waiting for ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'a free slot'}.`
          : 'No output.'
      }
      summary={task.summary}
    >
      {task.dependsOn.length > 0 && <span>after {task.dependsOn.join(', ')}</span>}
      {finished && task.changedFiles && (
        <span title={task.changedFiles.join('\n')} className="text-zinc-400">
          {task.changedFiles.length === 1
            ? '1 file changed'
            : `${task.changedFiles.length} files changed`}
        </span>
      )}
      {finished && task.branch && (
        <span className="truncate" title={task.branch}>
          {task.branch}
        </span>
      )}
      {showError && (
        <span className="w-full whitespace-pre-wrap break-words text-red-400">{task.error}</span>
      )}
    </AgentCard>
  );
}

function AgentCard({
  runId,
  taskId,
  tag,
  title,
  agent,
  status,
  time,
  expanded,
  onToggle,
  empty,
  summary,
  plan,
  children,
}: {
  runId: string;
  taskId: string;
  /** `plan`, `t1`, `t2`… */
  tag: string;
  title: string;
  agent: OrchestratorAgent | undefined;
  status: CardStatus;
  time: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  empty: string;
  /** The agent's final reply, shown under its activity. */
  summary?: string | undefined;
  /** For the planner's card: the tasks it came up with, shown instead of its JSON reply. */
  plan?: OrchestratorTask[] | undefined;
  children?: ReactNode;
}) {
  const output = useOrchestratorOutput(runId, taskId);
  const lines = plan && plan.length > 0 ? withoutPlanReply(output) : output;
  const running = status === 'running';
  return (
    <li
      data-agent-card={taskId}
      className={cn(
        'flex min-w-0 flex-col border bg-black',
        running ? 'border-zinc-600' : 'border-zinc-800',
        expanded ? 'col-span-full h-[70vh]' : 'h-72',
      )}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-800 px-2">
        <AgentDot agent={agent} pulse={running} />
        <span className="shrink-0 text-zinc-300">{agent ? kindMeta(agent).label : 'agent'}</span>
        <span className="shrink-0 text-zinc-600">{tag}</span>
        <span className={cn('ml-auto shrink-0', STATUS_TEXT[status])}>
          {TASK_STATUS_LABEL[status]}
        </span>
        <span className="w-10 shrink-0 text-right tabular-nums text-zinc-600">{time}</span>
        <button
          type="button"
          aria-label={expanded ? `Shrink ${title}` : `Expand ${title}`}
          aria-expanded={expanded}
          onClick={() => onToggle(taskId)}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {expanded ? (
            <Minimize2 aria-hidden className="size-3" />
          ) : (
            <Maximize2 aria-hidden className="size-3" />
          )}
        </button>
      </header>
      <p
        className={cn(
          'shrink-0 border-b border-zinc-900 px-2 py-1 text-zinc-100',
          !expanded && 'truncate',
        )}
        title={title}
      >
        {title}
      </p>
      <OutputLog
        key={`${runId}:${taskId}`}
        lines={lines}
        label={`Activity of ${title}`}
        empty={empty}
        summary={summary}
      >
        {plan && plan.length > 0 && (
          <ol
            aria-label="Planned tasks"
            className="mt-1.5 space-y-0.5 border-t border-zinc-900 pt-1.5"
          >
            {plan.map((task) => (
              <li key={task.id} className="flex items-baseline gap-2">
                <span className="w-5 shrink-0 text-zinc-600">{task.id}</span>
                <AgentDot agent={task.agent} />
                <span className="w-10 shrink-0 text-zinc-500">{task.agent}</span>
                <span className="min-w-0 break-words text-zinc-200">
                  {task.title}
                  {task.dependsOn.length > 0 && (
                    <span className="text-zinc-600"> · after {task.dependsOn.join(', ')}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </OutputLog>
      {children && (
        <footer className="flex max-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-y-auto border-t border-zinc-900 px-2 py-1 text-zinc-600">
          {children}
        </footer>
      )}
    </li>
  );
}

const LINE_CLASS: Record<OutputLine['kind'], string> = {
  text: 'text-zinc-300',
  tool: 'text-zinc-500',
  status: 'text-zinc-600',
  error: 'text-red-400',
};

/** Live output that follows new lines unless the user scrolled up to read. */
function OutputLog({
  lines,
  label,
  empty,
  summary,
  children,
}: {
  lines: OutputLine[];
  label: string;
  empty: string;
  summary: string | undefined;
  /** Shown after the lines, inside the scrolling area. */
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever new lines arrive
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, summary]);
  // The agent's last message is its summary; printing both would say it twice.
  const last = lines.at(-1);
  const repeated = summary !== undefined && last?.kind === 'text' && summary.endsWith(last.text);
  return (
    <div
      ref={box}
      role="log"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll area must be reachable by keyboard
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
    >
      {lines.length === 0 && !summary && !children ? (
        <p className="text-zinc-600">{empty}</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            className={cn('whitespace-pre-wrap break-words', LINE_CLASS[line.kind])}
          >
            {line.kind === 'tool' ? `› ${line.text}` : line.text || ' '}
          </div>
        ))
      )}
      {summary && !repeated && (
        <p className="mt-1.5 whitespace-pre-wrap break-words border-t border-zinc-900 pt-1.5 text-zinc-200">
          {summary}
        </p>
      )}
      {children}
    </div>
  );
}
