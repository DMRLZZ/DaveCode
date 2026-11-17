import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { ORCHESTRATOR_AGENT_IDS } from '../../lib/orchestrator';
import type { AgentAvailability, OrchestratorAccess, OrchestratorAgent } from '../../lib/types';
import { kindMeta } from './kinds';

export type BarMode = 'orchestrate' | 'broadcast';

export const STATUS_TEXT: Record<string, string> = {
  running: 'text-zinc-100',
  planning: 'text-zinc-100',
  done: 'text-zinc-400',
  failed: 'text-red-400',
  conflict: 'text-red-400',
  cancelled: 'text-zinc-600',
  skipped: 'text-zinc-600',
  pending: 'text-zinc-600',
};

/** The agent's accent as a dot: the only colour an agent gets. */
export function AgentDot({
  agent,
  pulse = false,
}: {
  agent: OrchestratorAgent | undefined;
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', pulse && 'animate-pulse')}
      style={{ background: agent ? kindMeta(agent).accent : '#52525b' }}
    />
  );
}

/** Re-renders every second while `ticking`, for elapsed times. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

// --- Composer controls ------------------------------------------------------------------------

export function ModeSwitch({ mode, onChange }: { mode: BarMode; onChange: (m: BarMode) => void }) {
  const options: { id: BarMode; label: string; hint: string }[] = [
    {
      id: 'orchestrate',
      label: 'Orchestrate',
      hint: 'DaveCode plans the objective and splits it across your agents',
    },
    {
      id: 'broadcast',
      label: 'Send to panes',
      hint: 'Types the same message into the agent panes you have open',
    },
  ];
  return (
    <fieldset className="flex shrink-0 items-center rounded border border-zinc-800 p-0.5">
      <legend className="sr-only">Message mode</legend>
      {options.map(({ id, label, hint }) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id}
          title={hint}
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

/** Which installed agent splits the objective into tasks. */
export function PlannerPicker({
  installed,
  planner,
  onChange,
}: {
  installed: readonly OrchestratorAgent[];
  planner: OrchestratorAgent | undefined;
  onChange: (agent: OrchestratorAgent) => void;
}) {
  if (installed.length === 0) return null;
  return (
    <label
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-zinc-500"
      title="The agent that plans the run and hands out the tasks"
    >
      lead
      <select
        aria-label="Planner"
        value={planner ?? installed[0]}
        onChange={(event) => onChange(event.target.value as OrchestratorAgent)}
        className="h-6 rounded border border-zinc-800 bg-black px-1 font-mono text-[11px] text-zinc-200 outline-none hover:border-zinc-600 focus:border-zinc-500"
      >
        {installed.map((agent) => (
          <option key={agent} value={agent}>
            {agent}
          </option>
        ))}
      </select>
    </label>
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
    <fieldset className="flex shrink-0 items-center gap-1">
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
            title={
              available
                ? `${kindMeta(agent).label}: ${on ? 'takes tasks' : 'left out of this run'}`
                : `${agent} is not installed`
            }
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

/**
 * Whether the agents of the next run may run shell commands. Off, Claude Code only edits files
 * (it has no sandbox); on, it runs tests and builds with the user's own permissions.
 */
export function AccessToggle({
  access,
  onChange,
}: {
  access: OrchestratorAccess;
  onChange: (access: OrchestratorAccess) => void;
}) {
  const full = access === 'full';
  const Icon = full ? ShieldAlert : ShieldCheck;
  return (
    <button
      type="button"
      aria-pressed={full}
      onClick={() => onChange(full ? 'edit' : 'full')}
      title={
        full
          ? 'Agents may run commands (tests, builds, installs) with your permissions. Click to let them only edit files.'
          : 'Agents only edit files; Claude Code cannot run tests. Click to let them run commands with your permissions.'
      }
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded border px-2 font-mono text-[11px]',
        full
          ? 'border-zinc-500 text-zinc-100'
          : 'border-zinc-800 text-zinc-500 hover:text-zinc-200',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {full ? 'runs commands' : 'edits only'}
    </button>
  );
}
