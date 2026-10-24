import { ArrowUp, Check, ChevronDown, Play, Square } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { errorMessage, isApiError } from '../../lib/api';
import { useData } from '../../lib/data';
import {
  useAccounts,
  useCancelGoal,
  useExecuteGoal,
  useGoals,
  useStartGoal,
  useTasks,
} from '../../lib/queries';
import { Link, navigate, useLocation } from '../../lib/router';
import type { GoalStatus } from '../../lib/types';
import { GoalDetail, isActiveGoal } from '../goals/Goals';

const LABELS: Record<GoalStatus, string> = {
  planning: 'Putting a plan together',
  running: 'Working on it',
  reviewing: 'Checking the result',
  planned: 'Your plan is ready',
  succeeded: 'Done',
  failed: 'Something needs attention',
  cancelled: 'Stopped',
  budget_exhausted: 'Usage limit reached',
};
const IDEAS = [
  {
    title: 'Make something',
    prompt:
      'Help me turn an idea into something useful. First help me define who it is for and what it should do.',
  },
  {
    title: 'Understand a project',
    prompt:
      'Explain this project in plain language and write a short getting-started guide for someone without a technical background.',
  },
  {
    title: 'Improve a design',
    prompt:
      'Review this project’s interface. Propose a distinctive visual direction, explain the most useful improvements and make a plan before changing code.',
  },
];

export function Workspace() {
  const { params } = useLocation();
  const { connection } = useData();
  const goals = useGoals();
  const accounts = useAccounts();
  const tasks = useTasks();
  const start = useStartGoal();
  const execute = useExecuteGoal();
  const cancel = useCancelGoal();
  const input = useRef<HTMLTextAreaElement>(null);
  const [objective, setObjective] = useState(() => (params.get('brief') ?? '').slice(0, 4000));
  const [mode, setMode] = useState('plan');
  const [tokens, setTokens] = useState('50000');
  const [error, setError] = useState<string>();
  const list = goals.data ?? [];
  const running = list.find(isActiveGoal);
  const current =
    params.has('new') || params.has('brief')
      ? undefined
      : (list.find((goal) => goal.id === params.get('goal')) ?? running);
  const demo = connection.mode === 'mock';
  const unavailable = isApiError(goals.error) && goals.error.status === 501;
  const enabled = (accounts.data ?? []).some((account) => account.enabled);
  const blocked =
    goals.isPending ||
    goals.isError ||
    accounts.isPending ||
    accounts.isError ||
    !enabled ||
    start.isPending ||
    (Boolean(running) && mode === 'work');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked || !objective.trim()) return;
    setError(undefined);
    start.mutate(
      { objective: objective.trim(), dryRun: mode === 'plan', maxTokens: Number(tokens) },
      {
        onSuccess: (goal) => {
          setObjective('');
          navigate(`/?goal=${encodeURIComponent(goal.id)}`);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-1 flex-col">
      {demo && (
        <p className="mb-4 text-center text-[12px] text-muted">
          This is a demo.{' '}
          <Link to="/settings" className="underline">
            Connect your device
          </Link>{' '}
          to work on your files.
        </p>
      )}
      {unavailable && (
        <Callout tone="warn" title="Open a project to start">
          Start DaveCode in your project folder.{' '}
          <Link to="/goals" className="underline">
            Setup instructions
          </Link>
        </Callout>
      )}
      {goals.isError && !unavailable && (
        <Callout tone="err" title="Could not load your work">
          {errorMessage(goals.error)}
        </Callout>
      )}
      {accounts.isError && (
        <Callout tone="err" title="Could not load AI connections">
          {errorMessage(accounts.error)}
        </Callout>
      )}
      {current ? (
        <div className="flex flex-1 flex-col gap-7 pb-10 pt-6">
          <div className="ml-auto max-w-[90%] rounded-2xl bg-raised px-5 py-4 text-[15px] leading-7 text-fg">
            {current.objective}
          </div>
          <section aria-labelledby="work-status" className="px-1">
            <div className="flex items-center justify-between gap-3">
              <h1 id="work-status" className="text-[19px] font-medium tracking-tight text-fg">
                {LABELS[current.status]}
              </h1>
              {isActiveGoal(current) && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Square}
                  loading={cancel.isPending}
                  onClick={() =>
                    cancel.mutate(current.id, { onError: (err) => setError(errorMessage(err)) })
                  }
                >
                  Stop
                </Button>
              )}
            </div>
            {current.tasks.length > 0 && (
              <ol className="mt-5 flex flex-col gap-4">
                {current.tasks.map((task) => (
                  <li
                    key={task.id}
                    className="flex items-start gap-3 text-[14px] leading-6 text-fg-2"
                  >
                    {task.status === 'SUCCESS' ? (
                      <Check aria-hidden className="mt-1 size-4 shrink-0 text-fg-2" />
                    ) : (
                      <span className="mt-0.5 w-4 shrink-0 text-center text-muted" aria-hidden>
                        {task.id === current.activeTaskId ? '→' : '−'}
                      </span>
                    )}
                    <div>
                      <span>{task.title}</span>
                      {task.status === 'FAILED' && (
                        <p className="mt-1 text-[12px] text-err">This step needs attention.</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {current.summary && <Markdown source={current.summary} className="mt-6 text-[14px]" />}
            {current.lastError && (
              <p role="alert" className="mt-4 text-[13px] text-err">
                {current.lastError}
              </p>
            )}
            {current.status === 'planned' && (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant="primary"
                  icon={Play}
                  loading={execute.isPending}
                  disabled={Boolean(running)}
                  onClick={() => {
                    setError(undefined);
                    execute.mutate(current.id, { onError: (err) => setError(errorMessage(err)) });
                  }}
                >
                  Execute this plan
                </Button>
                <span className="text-[13px] leading-6 text-muted">
                  Runs the planned steps above without re-planning.
                </span>
              </div>
            )}
          </section>
          <details className="text-[12px] text-muted">
            <summary className="mb-3 cursor-pointer">Task details</summary>
            <GoalDetail key={current.id} goal={current} />
          </details>
        </div>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center pb-8 pt-16 text-center md:pt-20">
          <h1 className="text-3xl font-medium tracking-tight text-fg md:text-[38px]">
            What are we making?
          </h1>
          <p className="mt-3 text-[15px] text-muted">An idea is a good place to start.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {IDEAS.map((idea) => (
              <button
                key={idea.title}
                type="button"
                onClick={() => {
                  setObjective(idea.prompt);
                  setMode('plan');
                  input.current?.focus();
                }}
                className="rounded-xl border border-line px-4 py-3 text-[13px] text-fg-2 transition-colors hover:border-line-strong hover:bg-hover"
              >
                {idea.title}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="sticky bottom-0 bg-bg pb-3 pt-3">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-line-strong bg-panel p-4 focus-within:border-faint"
        >
          <label htmlFor="workspace-composer" className="sr-only">
            What would you like to do?
          </label>
          <textarea
            id="workspace-composer"
            ref={input}
            required
            rows={3}
            maxLength={4000}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="Describe what you have in mind…"
            aria-describedby={error ? 'workspace-error' : undefined}
            className="block w-full resize-none border-0 bg-transparent px-1 py-2 text-[15px] leading-6 text-fg outline-none placeholder:text-muted"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="sr-only" htmlFor="workspace-mode">
                How to start
              </label>
              <select
                id="workspace-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                className="max-w-44 rounded-lg border-0 bg-transparent py-2 pr-3 text-[12px] text-fg-2 outline-accent"
              >
                <option value="plan">Plan first</option>
                <option value="work">Plan and work</option>
              </select>
              <details className="relative">
                <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted">
                  Options
                  <ChevronDown aria-hidden className="size-3" />
                </summary>
                <div className="absolute bottom-9 left-0 z-10 w-56 rounded-xl border border-line-strong bg-panel p-4 shadow-overlay">
                  <label htmlFor="workspace-limit" className="text-[12px] text-fg-2">
                    AI usage limit
                  </label>
                  <select
                    id="workspace-limit"
                    value={tokens}
                    onChange={(event) => setTokens(event.target.value)}
                    className="mt-2 w-full rounded-md border border-line-strong bg-panel px-2 py-2 text-[12px] text-fg"
                  >
                    <option value="50000">50k tokens</option>
                    <option value="250000">250k tokens</option>
                    <option value="1000000">1m tokens</option>
                  </select>
                  <p className="mt-2 text-[11px] leading-5 text-muted">
                    A usage limit, not a price cap.
                  </p>
                </div>
              </details>
            </div>
            <Button
              type="submit"
              icon={ArrowUp}
              iconOnly
              aria-label={demo ? 'Try demo' : mode === 'plan' ? 'Make a plan' : 'Start working'}
              variant="primary"
              disabled={blocked || !objective.trim()}
              loading={start.isPending}
              className="size-9 rounded-xl"
            />
          </div>
        </form>
        {error && (
          <p id="workspace-error" role="alert" className="mt-2 text-[12px] text-err">
            {error}
          </p>
        )}
        {!accounts.isPending && !accounts.isError && !enabled && (
          <p className="mt-3 text-center text-[12px] text-muted">
            <Link to="/accounts" className="underline">
              Connect an AI tool
            </Link>{' '}
            to get started.
          </p>
        )}
        {running && mode === 'work' && (
          <p role="status" className="mt-3 text-center text-[12px] text-muted">
            A task is running. You can still plan the next one.
          </p>
        )}
        <p className="mt-3 text-center text-[11px] leading-5 text-muted">
          {mode === 'plan'
            ? 'Planning does not execute tasks.'
            : 'Execution can edit files and merge changes.'}
          {tasks.data?.project ? ` Working in ${tasks.data.project.name}.` : ''}
        </p>
      </div>
    </div>
  );
}
