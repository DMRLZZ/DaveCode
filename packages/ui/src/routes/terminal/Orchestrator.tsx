import { ChevronLeft, Clock, GitMerge, PanelRight, Square, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useOrchestratorOutput } from '../../lib/data';
import { formatDuration, formatRelative } from '../../lib/format';
import {
  canApply,
  defaultTaskId,
  isActiveRun,
  ORCHESTRATOR_AGENT_IDS,
  type OutputLine,
  PLAN_TASK_ID,
  planElapsedMs,
  planStatus,
  RUN_STATUS_LABEL,
  TASK_STATUS_LABEL,
  taskElapsedMs,
} from '../../lib/orchestrator';
import { useApplyOrchestratorRun, useCancelOrchestratorRun } from '../../lib/queries';
import type {
  AgentAvailability,
  OrchestratorAgent,
  OrchestratorRun,
  OrchestratorTask,
} from '../../lib/types';
import { kindMeta } from './kinds';

export type BarMode = 'orchestrate' | 'broadcast';

const STATUS_TEXT: Record<string, string> = {
  running: 'text-zinc-100',
  planning: 'text-zinc-100',
  done: 'text-zinc-400',
  failed: 'text-red-400',
  conflict: 'text-red-400',
  cancelled: 'text-zinc-600',
  skipped: 'text-zinc-600',
  pending: 'text-zinc-600',
};

function Dot({ agent, pulse = false }: { agent: OrchestratorAgent | undefined; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', pulse && 'animate-pulse')}
      style={{ background: agent ? kindMeta(agent).accent : '#52525b' }}
    />
  );
}

function AgentTag({ agent }: { agent: OrchestratorAgent | undefined }) {
  if (!agent) return <span className="text-zinc-600">not chosen yet</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-zinc-300">
      <Dot agent={agent} />
      {kindMeta(agent).label}
    </span>
  );
}

/** Re-renders every second while `ticking`, for elapsed times. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

const elapsed = (ms: number | undefined) => (ms === undefined ? '' : formatDuration(ms / 1000));

// --- Bottom bar controls ----------------------------------------------------------------------

export function ModeSwitch({ mode, onChange }: { mode: BarMode; onChange: (m: BarMode) => void }) {
  const options: { id: BarMode; label: string }[] = [
    { id: 'orchestrate', label: 'Orchestrate' },
    { id: 'broadcast', label: 'Send to panes' },
  ];
  return (
    <fieldset className="mr-2 flex shrink-0 items-center rounded border border-zinc-800 p-0.5">
      <legend className="sr-only">Message mode</legend>
      {options.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id}
          onClick={() => onChange(id)}
          className={cn(
            'h-6 rounded-sm px-2 font-mono text-[11px]',
            mode === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

export function AgentChips({
  agents,
  selection,
  onToggle,
}: {
  agents: AgentAvailability[];
  selection: readonly OrchestratorAgent[];
  onToggle: (agent: OrchestratorAgent) => void;
}) {
  return (
    <fieldset className="ml-2 flex shrink-0 items-center gap-1">
      <legend className="sr-only">Agents the run may use</legend>
      {ORCHESTRATOR_AGENT_IDS.map((agent) => {
        const available = agents.some((a) => a.agent === agent && a.available);
        const on = available && selection.includes(agent);
        return (
          <button
            key={agent}
            type="button"
            aria-pressed={on}
            // aria-disabled keeps the tooltip and keyboard focus that `disabled` would lose.
            aria-disabled={!available}
            title={available ? `${kindMeta(agent).label}` : `${agent} is not installed`}
            onClick={() => available && onToggle(agent)}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded border px-2 font-mono text-[11px]',
              !available && 'cursor-not-allowed border-zinc-900 text-zinc-700 line-through',
              available && on && 'border-zinc-600 text-zinc-200',
              available && !on && 'border-zinc-800 text-zinc-600 hover:text-zinc-300',
            )}
          >
            <span
              aria-hidden
              className={cn('size-1.5 rounded-full', !on && 'opacity-30')}
              style={{ background: kindMeta(agent).accent }}
            />
            {agent}
          </button>
        );
      })}
    </fieldset>
  );
}

export function PanelToggle({
  open,
  busy,
  onToggle,
}: {
  open: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={open ? 'Hide the orchestrator panel' : 'Show the orchestrator panel'}
      aria-expanded={open}
      aria-controls="orchestrator-panel"
      title={busy ? 'Orchestrator: a run is in progress' : 'Orchestrator'}
      onClick={onToggle}
      className={cn(
        'relative ml-2 rounded p-1 hover:bg-zinc-900 hover:text-zinc-100',
        open ? 'text-zinc-200' : 'text-zinc-500',
      )}
    >
      <PanelRight aria-hidden className="size-3.5" />
      {busy && (
        <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-white" />
      )}
    </button>
  );
}

// --- Panel ------------------------------------------------------------------------------------

export function OrchestratorPanel({
  runs,
  run,
  onSelectRun,
  onClose,
}: {
  runs: OrchestratorRun[];
  run: OrchestratorRun | undefined;
  onSelectRun: (id: string) => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState(false);
  return (
    <aside
      id="orchestrator-panel"
      aria-label="Orchestrator"
      className="my-1 mr-1 flex w-[360px] shrink-0 flex-col border border-zinc-800 bg-black font-mono text-[11px] text-zinc-400"
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-800 px-2">
        {history ? (
          <button
            type="button"
            onClick={() => setHistory(false)}
            className="flex items-center gap-1 rounded px-1 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <ChevronLeft aria-hidden className="size-3" />
            Runs
          </button>
        ) : (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-white" />
            <span className="text-zinc-300">Orchestrator</span>
            {run && <span className="truncate text-zinc-600">{run.id}</span>}
          </>
        )}
        <span className="ml-auto" />
        {!history && runs.length > 1 && (
          <button
            type="button"
            aria-expanded={history}
            onClick={() => setHistory(true)}
            className="flex items-center gap-1 rounded px-1 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Clock aria-hidden className="size-3" />
            History
          </button>
        )}
        <button
          type="button"
          aria-label="Collapse the orchestrator panel"
          onClick={onClose}
          className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X aria-hidden className="size-3" />
        </button>
      </header>
      {history ? (
        <RunHistory
          runs={runs}
          current={run?.id}
          onSelect={(id) => {
            onSelectRun(id);
            setHistory(false);
          }}
        />
      ) : run ? (
        <RunView key={run.id} run={run} />
      ) : (
        <p className="p-3 leading-relaxed text-zinc-500">
          Type an objective in the bar below. A planner agent splits it into tasks, each one runs in
          its own git worktree, and the results land on a <code>davecode/run-…</code> branch you can
          apply.
        </p>
      )}
    </aside>
  );
}

function RunHistory({
  runs,
  current,
  onSelect,
}: {
  runs: OrchestratorRun[];
  current: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <ul aria-label="Previous runs" className="min-h-0 flex-1 overflow-y-auto py-1">
      {runs.slice(0, 20).map((r) => (
        <li key={r.id}>
          <button
            type="button"
            aria-current={r.id === current ? 'true' : undefined}
            onClick={() => onSelect(r.id)}
            className={cn(
              'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-zinc-900',
              r.id === current && 'bg-zinc-900',
            )}
          >
            <span className="truncate text-zinc-200">{r.objective}</span>
            <span className="flex gap-2">
              <span className={STATUS_TEXT[r.status]}>{RUN_STATUS_LABEL[r.status]}</span>
              {r.appliedAt && <span className="text-zinc-500">applied</span>}
              <span className="ml-auto text-zinc-600">
                {formatRelative(Date.parse(r.createdAt))}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RunView({ run }: { run: OrchestratorRun }) {
  const active = isActiveRun(run);
  const now = useNow(active);
  const cancel = useCancelOrchestratorRun();
  const apply = useApplyOrchestratorRun();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const [picked, setPicked] = useState<string>();
  const known = picked === PLAN_TASK_ID || run.tasks.some((t) => t.id === picked);
  const selected = picked && known ? picked : defaultTaskId(run);
  const task = run.tasks.find((t) => t.id === selected);
  const plan = planStatus(run);

  const doCancel = () =>
    cancel.mutate(run.id, {
      onError: (e) => setNotice({ error: true, text: errorMessage(e) }),
    });
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
    <div className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Run"
        className="max-h-[38%] shrink-0 space-y-2 overflow-y-auto border-b border-zinc-800 p-3"
      >
        <p className="whitespace-pre-wrap break-words text-xs text-zinc-100">{run.objective}</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt className="text-zinc-600">status</dt>
          <dd className={STATUS_TEXT[run.status]} aria-live="polite">
            {RUN_STATUS_LABEL[run.status]}
            {run.appliedAt && <span className="text-zinc-500"> · applied</span>}
          </dd>
          <dt className="text-zinc-600">planner</dt>
          <dd>
            <AgentTag agent={run.planner} />
          </dd>
          {run.baseBranch && (
            <>
              <dt className="text-zinc-600">base</dt>
              <dd className="truncate text-zinc-300">{run.baseBranch}</dd>
            </>
          )}
          {run.integrationBranch && (
            <>
              <dt className="text-zinc-600">branch</dt>
              <dd className="truncate text-zinc-300" title={run.integrationBranch}>
                {run.integrationBranch}
              </dd>
            </>
          )}
        </dl>
        {run.error && <p className="whitespace-pre-wrap break-words text-red-400">{run.error}</p>}
        {run.summary && (
          <p className="whitespace-pre-wrap break-words leading-relaxed text-zinc-300">
            {run.summary}
          </p>
        )}
        {(active || canApply(run)) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
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
            {canApply(run) && (
              <button
                type="button"
                onClick={doApply}
                disabled={apply.isPending}
                className="flex h-6 max-w-full items-center gap-1.5 rounded border border-zinc-500 bg-zinc-100 px-2 text-black hover:bg-white disabled:opacity-50"
              >
                <GitMerge aria-hidden className="size-3 shrink-0" />
                <span className="truncate">
                  {apply.isPending ? 'Applying…' : `Apply to ${run.baseBranch ?? 'base branch'}`}
                </span>
              </button>
            )}
          </div>
        )}
        {notice && (
          <p
            role={notice.error ? 'alert' : 'status'}
            className={cn('break-words', notice.error ? 'text-red-400' : 'text-zinc-300')}
          >
            {notice.text}
          </p>
        )}
      </section>

      <ul
        aria-label="Tasks"
        className="max-h-[30%] shrink-0 overflow-y-auto border-b border-zinc-800 py-1"
      >
        <TaskRow
          id={PLAN_TASK_ID}
          title="Plan"
          agent={run.planner}
          status={plan}
          time={elapsed(planElapsedMs(run, now))}
          selected={selected === PLAN_TASK_ID}
          onSelect={setPicked}
        />
        {run.tasks.map((t) => (
          <TaskRow
            key={t.id}
            id={t.id}
            title={t.title}
            agent={t.agent}
            status={t.status}
            time={elapsed(taskElapsedMs(t, now))}
            selected={selected === t.id}
            onSelect={setPicked}
          />
        ))}
      </ul>

      {task ? (
        <TaskDetail run={run} task={task} />
      ) : (
        <Detail
          title="Plan"
          agent={run.planner}
          status={plan}
          runId={run.id}
          taskId={PLAN_TASK_ID}
          empty={plan === 'running' ? 'The planner is starting…' : 'No planner output.'}
        />
      )}
    </div>
  );
}

function TaskRow({
  id,
  title,
  agent,
  status,
  time,
  selected,
  onSelect,
}: {
  id: string;
  title: string;
  agent: OrchestratorAgent | undefined;
  status: keyof typeof TASK_STATUS_LABEL;
  time: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(id)}
        className={cn(
          'flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-zinc-900',
          selected ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-300',
        )}
      >
        <Dot agent={agent} pulse={status === 'running'} />
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        <span className={STATUS_TEXT[status]}>{TASK_STATUS_LABEL[status]}</span>
        <span className="w-12 shrink-0 text-right text-zinc-600 tabular-nums">{time}</span>
      </button>
    </li>
  );
}

function TaskDetail({ run, task }: { run: OrchestratorRun; task: OrchestratorTask }) {
  const showError =
    task.error &&
    (task.status === 'failed' || task.status === 'conflict' || task.status === 'skipped');
  const finished = task.status === 'done' || task.status === 'conflict';
  return (
    <Detail
      title={task.title}
      agent={task.agent}
      status={task.status}
      runId={run.id}
      taskId={task.id}
      empty={
        task.status === 'pending'
          ? `Waiting for ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'a free slot'}.`
          : 'No output.'
      }
    >
      {task.dependsOn.length > 0 && (
        <p className="text-zinc-600">after {task.dependsOn.join(', ')}</p>
      )}
      {showError && <p className="whitespace-pre-wrap break-words text-red-400">{task.error}</p>}
      {finished && task.branch && (
        <p className="truncate text-zinc-500" title={task.branch}>
          branch <span className="text-zinc-300">{task.branch}</span>
        </p>
      )}
      {finished && task.changedFiles && (
        <div>
          <p className="text-zinc-500">
            {task.changedFiles.length === 1
              ? '1 file changed'
              : `${task.changedFiles.length} files changed`}
          </p>
          {task.changedFiles.length > 0 && (
            <ul aria-label="Changed files" className="max-h-20 overflow-y-auto text-zinc-300">
              {task.changedFiles.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {task.summary && (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-zinc-300">
          {task.summary}
        </p>
      )}
    </Detail>
  );
}

function Detail({
  title,
  agent,
  status,
  runId,
  taskId,
  empty,
  children,
}: {
  title: string;
  agent: OrchestratorAgent | undefined;
  status: keyof typeof TASK_STATUS_LABEL;
  runId: string;
  taskId: string;
  empty: string;
  children?: ReactNode;
}) {
  const lines = useOrchestratorOutput(runId, taskId);
  return (
    <section aria-label={`${title} details`} className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[45%] shrink-0 space-y-1.5 overflow-y-auto border-b border-zinc-900 px-3 py-2">
        <p className="flex items-center gap-2">
          <AgentTag agent={agent} />
          <span className={cn('ml-auto', STATUS_TEXT[status])}>{TASK_STATUS_LABEL[status]}</span>
        </p>
        <p className="break-words text-zinc-100">{title}</p>
        {children}
      </div>
      <OutputLog
        key={`${runId}:${taskId}`}
        lines={lines}
        label={`Output of ${title}`}
        empty={empty}
      />
    </section>
  );
}

const LINE_CLASS: Record<OutputLine['kind'], string> = {
  text: 'text-zinc-300',
  tool: 'text-zinc-500',
  status: 'text-zinc-600',
  error: 'text-red-400',
};

/** Live output that follows new lines unless the user scrolled up to read. */
function OutputLog({ lines, label, empty }: { lines: OutputLine[]; label: string; empty: string }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever new lines arrive
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
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
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2 leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
    >
      {lines.length === 0 ? (
        <p className="text-zinc-600">{empty}</p>
      ) : (
        lines.map((line) => (
          <div
            key={line.id}
            className={cn('whitespace-pre-wrap break-words', LINE_CLASS[line.kind])}
          >
            {line.kind === 'tool' ? `› ${line.text}` : line.text || ' '}
          </div>
        ))
      )}
    </div>
  );
}
