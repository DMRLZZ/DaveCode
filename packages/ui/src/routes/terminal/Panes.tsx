import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from '../../components/shell/Sidebar';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useOrchestratorRunMap } from '../../lib/data';
import { gridColumns, type PaneKind, type TerminalBridge } from '../../lib/desktop';
import {
  availableAgents,
  isActiveRun,
  orchestratorOffered,
  sortedRuns,
  startRequest,
  toggleAgent,
} from '../../lib/orchestrator';
import {
  useOrchestratorAgents,
  useOrchestratorRuns,
  useStartOrchestratorRun,
} from '../../lib/queries';
import { Link } from '../../lib/router';
import type { OrchestratorAgent } from '../../lib/types';
import { KINDS, kindMeta } from './kinds';
import {
  AgentChips,
  type BarMode,
  ModeSwitch,
  OrchestratorPanel,
  PanelToggle,
  PlannerPicker,
} from './Orchestrator';

interface PaneState {
  key: number;
  kind: PaneKind;
}

function isCopy(e: KeyboardEvent, selection: boolean): boolean {
  if (e.key.toLowerCase() !== 'c' || !(e.ctrlKey || e.metaKey)) return false;
  return e.shiftKey || selection;
}

function isPaste(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey);
}

function Pane({
  pane,
  bridge,
  active,
  focused,
  onFocus,
  onClose,
  onWriter,
}: {
  pane: PaneState;
  bridge: TerminalBridge;
  active: boolean;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onWriter: (key: number, writer: ((data: string) => void) | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const refit = useRef<() => void>(() => {});
  const [live, setLive] = useState(false);
  const meta = kindMeta(pane.kind);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one terminal per pane for its lifetime
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: "'Geist Mono Variable', Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: { background: '#000000', foreground: '#f4f4f5', cursor: '#ffffff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (isCopy(event, term.hasSelection())) {
        event.preventDefault();
        void bridge.copy(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Returning false lets the browser fire the paste event that xterm listens for.
      return !isPaste(event);
    });

    let id: string | undefined;
    let disposed = false;
    let starting = true;
    // Output can arrive before `open` resolves, so nothing is matched to this pane yet.
    const early: [string, string][] = [];
    const offData = bridge.onData((from, data) => {
      if (starting) early.push([from, data]);
      else if (from === id) term.write(data);
    });
    const offExit = bridge.onExit((from, code) => {
      if (from !== id) return;
      id = undefined;
      setLive(false);
      onWriter(pane.key, undefined);
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    });
    const typed = term.onData((data) => {
      if (id !== undefined) void bridge.write({ id, data });
    });

    let frame = 0;
    refit.current = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      // When a pane narrows (e.g. the orchestrator panel opens), the first fit can measure the
      // old, wider screen and overflow the pane; fitting again once it has rendered settles it.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
        fit.fit();
        if (id !== undefined) void bridge.resize({ id, cols: term.cols, rows: term.rows });
      });
    };
    const observer = new ResizeObserver(() => refit.current());
    observer.observe(element);
    refit.current();

    bridge
      .open({ kind: pane.kind, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (disposed) {
          void bridge.close(opened);
          return;
        }
        id = opened;
        starting = false;
        for (const [from, data] of early) if (from === opened) term.write(data);
        early.length = 0;
        setLive(true);
        onWriter(pane.key, (data) => void bridge.write({ id: opened, data }));
        term.focus();
      })
      .catch(() => {
        starting = false;
        early.length = 0;
        term.write('\x1b[31mCould not start this terminal.\x1b[0m\r\n');
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      offData();
      offExit();
      typed.dispose();
      onWriter(pane.key, undefined);
      if (id !== undefined) void bridge.close(id);
      term.dispose();
    };
  }, []);

  // A hidden page has no size; fit again when it comes back.
  useEffect(() => {
    if (active) refit.current();
    if (active && focused) terminal.current?.focus();
  }, [active, focused]);

  return (
    <section
      data-pane-live={live}
      aria-label={meta.label}
      onMouseDown={onFocus}
      className={cn(
        'flex min-h-0 min-w-0 flex-col border bg-black',
        focused ? 'border-zinc-500' : 'border-zinc-800',
      )}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-800 px-2 font-mono text-[11px] text-zinc-400">
        <span aria-hidden className="size-1.5 rounded-full" style={{ background: meta.accent }} />
        <span className="truncate">{meta.label}</span>
        {!live && <span className="text-zinc-600">stopped</span>}
        <button
          type="button"
          aria-label={`Close ${meta.label} pane`}
          onClick={onClose}
          className="ml-auto rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X aria-hidden className="size-3" />
        </button>
      </header>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </section>
  );
}

export function Panes({ bridge, active }: { bridge: TerminalBridge; active: boolean }) {
  const next = useRef(2);
  const [panes, setPanes] = useState<PaneState[]>([{ key: 1, kind: 'shell' }]);
  const [focused, setFocused] = useState(1);
  const [message, setMessage] = useState('');
  const writers = useRef(new Map<number, (data: string) => void>());

  const add = (kind: PaneKind) => {
    const key = next.current++;
    setPanes((current) => [...current, { key, kind }]);
    setFocused(key);
  };
  const close = (key: number) => {
    const remaining = panes.filter((pane) => pane.key !== key);
    setPanes(remaining);
    const last = remaining.at(-1);
    if (key === focused && last) setFocused(last.key);
  };
  const onWriter = useCallback((key: number, writer: ((data: string) => void) | undefined) => {
    if (writer) writers.current.set(key, writer);
    else writers.current.delete(key);
  }, []);

  // The orchestrator is offered only when the gateway has one and an agent CLI is installed.
  const agentsQuery = useOrchestratorAgents();
  const availability = agentsQuery.data ?? null;
  const offered = orchestratorOffered(availability);
  useOrchestratorRuns(offered);
  const runMap = useOrchestratorRunMap();
  const runs = useMemo(() => sortedRuns({ runs: runMap }), [runMap]);
  const start = useStartOrchestratorRun();
  const [chosenMode, setChosenMode] = useState<BarMode>();
  const mode: BarMode = offered ? (chosenMode ?? 'orchestrate') : 'broadcast';
  const [chosenAgents, setChosenAgents] = useState<OrchestratorAgent[]>();
  const selection = chosenAgents ?? availableAgents(availability);
  const [planner, setPlanner] = useState<OrchestratorAgent>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const shownRun = runs.find((r) => r.id === runId) ?? runs[0];
  const busy = runs.some(isActiveRun);
  const panel = offered && panelOpen;

  const orchestrate = () => {
    const lead = planner ?? availableAgents(availability)[0];
    const input = startRequest(message, selection, availability, lead);
    if (!input || start.isPending) return;
    setStartError(undefined);
    start.mutate(input, {
      onSuccess: (run) => {
        setMessage('');
        setRunId(run.id);
        setPanelOpen(true);
      },
      onError: (error) => setStartError(errorMessage(error)),
    });
  };

  const agents = panes.filter((pane) => pane.kind !== 'shell');
  const targets = agents.length > 0 ? agents : panes;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'orchestrate') {
      orchestrate();
      return;
    }
    const text = message.trim();
    if (!text) return;
    for (const pane of targets) {
      const write = writers.current.get(pane.key);
      if (!write) continue;
      write(text);
      // Agent TUIs treat text and Enter in one chunk as a paste, which would not submit it.
      setTimeout(() => write('\r'), 60);
    }
    setMessage('');
  };

  return (
    <div id="terminal-workspace" className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-800 px-3 font-mono text-xs">
        <BrandMark className="mr-2 size-5" />
        {KINDS.map(({ kind, label, accent }) => (
          <button
            key={kind}
            type="button"
            onClick={() => add(kind)}
            className="flex h-7 items-center gap-1.5 rounded px-2 text-zinc-300 hover:bg-zinc-900 hover:text-white"
          >
            <Plus aria-hidden className="size-3" style={{ color: accent }} />
            {label}
          </button>
        ))}
        <nav aria-label="DaveCode" className="ml-auto flex items-center gap-3 text-zinc-500">
          <Link to="/accounts" className="hover:text-zinc-100">
            Connections
          </Link>
          <Link to="/overview" className="hover:text-zinc-100">
            Dashboard
          </Link>
          <Link to="/settings" className="hover:text-zinc-100">
            Settings
          </Link>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        {panes.length === 0 ? (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center font-mono text-sm text-zinc-500">
            Open a shell or an agent from the bar above.
          </div>
        ) : (
          <main
            className="grid min-h-0 min-w-0 flex-1 gap-1 p-1"
            style={{
              gridTemplateColumns: `repeat(${gridColumns(panes.length)}, minmax(0, 1fr))`,
              gridAutoRows: 'minmax(0, 1fr)',
            }}
          >
            {panes.map((pane) => (
              <Pane
                key={pane.key}
                pane={pane}
                bridge={bridge}
                active={active}
                focused={pane.key === focused}
                onFocus={() => setFocused(pane.key)}
                onClose={() => close(pane.key)}
                onWriter={onWriter}
              />
            ))}
          </main>
        )}
        {panel && (
          <OrchestratorPanel
            runs={runs}
            run={shownRun}
            onSelectRun={setRunId}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
      <form
        onSubmit={send}
        className="flex h-10 shrink-0 items-center border-t border-zinc-800 px-3"
      >
        {offered && <ModeSwitch mode={mode} onChange={setChosenMode} />}
        <span aria-hidden className="mr-2 font-mono text-xs text-zinc-500">
          ›
        </span>
        {/* One input for both modes, so switching never drops focus or the text typed so far. */}
        <input
          aria-label={
            mode === 'orchestrate'
              ? 'Objective for the orchestrator'
              : 'Send a message to every agent'
          }
          aria-describedby={
            mode === 'orchestrate' && startError ? 'orchestrator-start-error' : undefined
          }
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            setStartError(undefined);
          }}
          placeholder={
            mode === 'orchestrate'
              ? start.isPending
                ? 'Starting the run…'
                : 'Describe an objective; DaveCode plans it and splits it across your agents'
              : agents.length > 1
                ? `Send to all ${agents.length} agents`
                : agents.length === 1
                  ? 'Send to the agent'
                  : 'Send to every pane'
          }
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        {mode === 'orchestrate' && startError && (
          <p
            id="orchestrator-start-error"
            role="alert"
            title={startError}
            className="ml-2 max-w-[40%] truncate font-mono text-[11px] text-red-400"
          >
            {startError}
          </p>
        )}
        {mode === 'orchestrate' && availability && (
          <PlannerPicker
            installed={availableAgents(availability)}
            planner={planner}
            onChange={setPlanner}
          />
        )}
        {mode === 'orchestrate' && availability && (
          <AgentChips
            agents={availability}
            selection={selection}
            onToggle={(agent) => setChosenAgents(toggleAgent(selection, agent))}
          />
        )}
        {offered && (
          <PanelToggle open={panelOpen} busy={busy} onToggle={() => setPanelOpen((o) => !o)} />
        )}
      </form>
    </div>
  );
}
