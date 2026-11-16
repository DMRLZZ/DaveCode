import { Columns3, GitCompareArrows, PanelLeftOpen, Plus, SendHorizontal } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { errorMessage } from '../../lib/api';
import { changedFileCount, shortBranch } from '../../lib/changes';
import { cn } from '../../lib/cn';
import { useOrchestratorRunMap } from '../../lib/data';
import { chooseProject, type PaneKind, type TerminalBridge } from '../../lib/desktop';
import {
  type Divider,
  dividers,
  type Layout,
  paneRects,
  resizeAt,
  type SplitDirection,
} from '../../lib/layout';
import {
  availableAgents,
  isActiveRun,
  orchestratorOffered,
  sortedRuns,
  startRequest,
  toggleAgent,
} from '../../lib/orchestrator';
import {
  useChangesWorkspaces,
  useCreateWorkspace,
  useOrchestratorAgents,
  useOrchestratorRuns,
  useStartOrchestratorRun,
  useTasks,
} from '../../lib/queries';
import { workspaceAction } from '../../lib/sessions';
import type { OrchestratorAccess, OrchestratorAgent } from '../../lib/types';
import { initialWorkspace, isShown, workspaceReducer } from '../../lib/workspace';
import { ChangesPanel } from './Changes';
import { KINDS, kindMeta } from './kinds';
import { AccessToggle, AgentChips, type BarMode, ModeSwitch, PlannerPicker } from './Orchestrator';
import { Pane } from './Pane';
import { RunThread } from './RunThread';
import { SessionSidebar, type SidebarSession } from './SessionSidebar';

type View = 'terminals' | 'run';
type Target = 'agents' | 'focused';

/** A yes/no or one-of-a-few choice remembered between launches; storage may be unavailable. */
function useStored<T extends string>(key: string, initial: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = window.localStorage.getItem(key) as T | null;
      return saved !== null && allowed.includes(saved) ? saved : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* The choice still holds for this session. */
      }
    },
    [key],
  );
  return [value, set] as const;
}

const ON_OFF = ['on', 'off'] as const;
const ACCESS = ['edit', 'full'] as const;

/** A border between two panes that can be dragged. */
function DividerHandle({
  divider,
  layout,
  area,
  onResize,
  onReset,
}: {
  divider: Divider;
  layout: Layout;
  area: RefObject<HTMLDivElement | null>;
  onResize: (layout: Layout) => void;
  onReset: () => void;
}) {
  const column = divider.kind === 'column';
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; layout: Layout } | undefined>(undefined);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY, layout };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = start.current;
    const box = area.current?.getBoundingClientRect();
    if (!from || !box || box.width === 0 || box.height === 0) return;
    // Always from the layout the drag started with, so rounding never accumulates.
    const share = column
      ? (event.clientX - from.x) / box.width
      : (event.clientY - from.y) / box.height;
    onResize(resizeAt(from.layout, divider.path, divider.index, share));
  };
  const end = () => {
    start.current = undefined;
    setDragging(false);
  };
  const step = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const back = column ? 'ArrowLeft' : 'ArrowUp';
    const forward = column ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    onResize(resizeAt(layout, divider.path, divider.index, event.key === back ? -0.02 : 0.02));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be dragged or focused
    <div
      role="separator"
      aria-orientation={column ? 'vertical' : 'horizontal'}
      aria-label={column ? 'Resize columns' : 'Resize panes'}
      aria-valuenow={Math.round((column ? divider.left : divider.top) * 100)}
      tabIndex={0}
      title="Drag to resize; double-click to even out"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={step}
      className={cn(
        'group absolute z-10 flex items-center justify-center outline-none',
        column
          ? 'w-2 -translate-x-1/2 cursor-col-resize'
          : 'h-2 -translate-y-1/2 cursor-row-resize',
      )}
      style={{
        left: `${divider.left * 100}%`,
        top: `${divider.top * 100}%`,
        ...(column ? { height: `${divider.height * 100}%` } : { width: `${divider.width * 100}%` }),
      }}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full bg-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          dragging && 'opacity-100',
          column ? 'h-full w-px' : 'h-px w-full',
        )}
      />
    </div>
  );
}

export function Panes({ bridge, active }: { bridge: TerminalBridge; active: boolean }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, initialWorkspace);
  const [view, setView] = useState<View>('terminals');
  const [liveKeys, setLiveKeys] = useState<ReadonlySet<number>>(() => new Set());
  const [sidebar, setSidebar] = useStored('davecode.workspace.sidebar', 'on', ON_OFF);
  const writers = useRef(new Map<number, (data: string) => void>());
  const area = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState('');

  const project = useTasks().data?.project?.name;
  const pickProject = chooseProject();

  // --- Isolated workspaces and the changes review ---------------------------------------------
  const [isolate, setIsolate] = useState(false);
  const [addError, setAddError] = useState<string>();
  const createWorkspace = useCreateWorkspace();
  const changesQuery = useChangesWorkspaces(active);
  const workspaces = changesQuery.data ?? undefined;
  const changesOffered = workspaces !== undefined;
  const workspaceById = useMemo(
    () => new Map((workspaces ?? []).map((w) => [w.id, w])),
    [workspaces],
  );
  const [changesOpen, setChangesOpen] = useState(false);
  const [changesId, setChangesId] = useState<string>();
  const showChanges = (id?: string) => {
    if (id) setChangesId(id);
    setChangesOpen(true);
  };

  const add = (kind: PaneKind) => {
    setAddError(undefined);
    setView('terminals');
    const label = kindMeta(kind).label;
    if (!isolate || !changesOffered) {
      dispatch({ type: 'open', kind, label });
      return;
    }
    // Each isolated session gets a fresh worktree on its own branch before its terminal starts.
    createWorkspace.mutate(label, {
      onSuccess: (workspace) => dispatch({ type: 'open', kind, label, workspace: workspace.id }),
      onError: (error) => setAddError(errorMessage(error)),
    });
  };
  /** A split opens a shell beside the pane, in the same folder (its worktree, when isolated). */
  const split = (near: number, direction: SplitDirection) => {
    const source = state.sessions.find((s) => s.key === near);
    dispatch({
      type: 'open',
      kind: 'shell',
      label: kindMeta('shell').label,
      workspace: source?.workspace,
      split: { near, direction },
    });
  };
  const select = (key: number) => {
    setView('terminals');
    dispatch({ type: 'focus', key });
  };

  const onWriter = useCallback((key: number, writer: ((data: string) => void) | undefined) => {
    if (writer) writers.current.set(key, writer);
    else writers.current.delete(key);
  }, []);
  const onLive = useCallback((key: number, live: boolean) => {
    setLiveKeys((current) => {
      if (current.has(key) === live) return current;
      const next = new Set(current);
      if (live) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // --- Orchestrator -----------------------------------------------------------------------------
  // Offered only when the gateway has one and an agent CLI is installed.
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
  const [access, setAccess] = useStored<OrchestratorAccess>(
    'davecode.orchestrator.access',
    'edit',
    ACCESS,
  );
  const [runId, setRunId] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const shownRun = runs.find((r) => r.id === runId) ?? runs[0];
  const busyRun = runs.find(isActiveRun);

  const orchestrate = () => {
    const lead = planner ?? availableAgents(availability)[0];
    const input = startRequest(message, selection, availability, lead, access);
    if (!input || start.isPending) return;
    setStartError(undefined);
    start.mutate(input, {
      onSuccess: (run) => {
        setMessage('');
        setRunId(run.id);
        setView('run');
      },
      onError: (error) => setStartError(errorMessage(error)),
    });
  };

  // --- Sending to panes -------------------------------------------------------------------------
  const [target, setTarget] = useState<Target>('agents');
  const agentSessions = state.sessions.filter((s) => s.kind !== 'shell');
  const focusedSession = state.sessions.find((s) => s.key === state.focused);
  const recipients =
    target === 'focused' && focusedSession
      ? [focusedSession]
      : agentSessions.length > 0
        ? agentSessions
        : state.sessions;
  const broadcast = () => {
    const text = message.trim();
    if (!text) return;
    for (const session of recipients) {
      const write = writers.current.get(session.key);
      if (!write) continue;
      write(text);
      // Agent TUIs treat text and Enter in one chunk as a paste, which would not submit it.
      setTimeout(() => write('\r'), 60);
    }
    setMessage('');
  };
  const send = () => (mode === 'orchestrate' ? orchestrate() : broadcast());

  // --- Keyboard ---------------------------------------------------------------------------------
  const shortcut = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcut.current = (event) => {
    const action = workspaceAction(event);
    if (!action) return;
    if (action === 'sidebar') {
      event.preventDefault();
      setSidebar(sidebar === 'on' ? 'off' : 'on');
      return;
    }
    const key = state.focused;
    if (view !== 'terminals' || key === undefined) return;
    event.preventDefault();
    if (action === 'split-right') split(key, 'right');
    else if (action === 'split-down') split(key, 'down');
    else if (action === 'minimize') dispatch({ type: 'minimize', key });
    else if (action === 'zoom') dispatch({ type: 'zoom', key });
    else dispatch({ type: 'close', key });
  };
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => shortcut.current(event);
    // Capture: the terminal's own key handling must not see these first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);

  // --- Rendering --------------------------------------------------------------------------------
  const rects = useMemo(() => paneRects(state.layout), [state.layout]);
  const lines = useMemo(() => dividers(state.layout), [state.layout]);
  const terminals = view === 'terminals';
  const shownCount =
    state.zoomed !== undefined ? 1 : state.sessions.filter((s) => !s.minimized).length;
  const sidebarSessions: SidebarSession[] = state.sessions.map((s) => ({
    key: s.key,
    kind: s.kind,
    name: s.name,
    minimized: s.minimized,
    live: liveKeys.has(s.key),
    branch: s.workspace
      ? shortBranch(workspaceById.get(s.workspace)?.branch ?? 'isolated')
      : undefined,
  }));
  const changesCount = changedFileCount(workspaces);
  const rows = Math.min(6, Math.max(1, message.split('\n').length));

  return (
    <div id="terminal-workspace" className="flex h-full">
      {sidebar === 'on' && (
        <SessionSidebar
          projectName={project}
          onChooseProject={pickProject}
          sessions={sidebarSessions}
          focused={state.focused}
          showingRun={!terminals}
          onSelectSession={select}
          onRenameSession={(key, name) => dispatch({ type: 'rename', key, name })}
          onToggleMinimize={(key) => {
            const session = state.sessions.find((s) => s.key === key);
            if (session?.minimized) select(key);
            else dispatch({ type: 'minimize', key });
          }}
          onCloseSession={(key) => dispatch({ type: 'close', key })}
          onAdd={add}
          isolateOffered={changesOffered}
          isolate={isolate}
          onIsolate={setIsolate}
          creating={createWorkspace.isPending}
          addError={addError}
          runsOffered={offered}
          runs={runs}
          runId={shownRun?.id}
          onSelectRun={(id) => {
            setRunId(id);
            setView('run');
          }}
          onNewRun={() => {
            setChosenMode('orchestrate');
            setView('run');
            composer.current?.focus();
          }}
          changesOffered={changesOffered || changesQuery.isError}
          changesCount={changesCount}
          onShowChanges={() => (changesOpen ? setChangesOpen(false) : showChanges())}
          onCollapse={() => setSidebar('off')}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 px-2 font-mono text-[11px]">
          {sidebar === 'off' && (
            <button
              type="button"
              aria-label="Show the sidebar"
              title="Show the sidebar (Ctrl+Shift+B)"
              onClick={() => setSidebar('on')}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
            >
              <PanelLeftOpen aria-hidden className="size-3.5" />
            </button>
          )}
          <fieldset className="flex items-center rounded border border-zinc-800 p-0.5">
            <legend className="sr-only">View</legend>
            <button
              type="button"
              aria-pressed={terminals}
              onClick={() => setView('terminals')}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-sm px-2',
                terminals ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
              )}
            >
              Terminals
              <span className="tabular-nums text-zinc-500">{state.sessions.length}</span>
            </button>
            {offered && (
              <button
                type="button"
                aria-pressed={!terminals}
                onClick={() => setView('run')}
                title="What the orchestrator and each of its agents are doing"
                className={cn(
                  'flex h-6 items-center gap-1.5 rounded-sm px-2',
                  !terminals ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
                )}
              >
                Orchestrator
                {busyRun && (
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-white" />
                )}
              </button>
            )}
          </fieldset>
          {terminals && state.zoomed !== undefined && (
            <button
              type="button"
              onClick={() =>
                state.zoomed !== undefined && dispatch({ type: 'zoom', key: state.zoomed })
              }
              className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 hover:text-white"
            >
              Zoomed · show all {state.sessions.filter((s) => !s.minimized).length}
            </button>
          )}
          {!terminals && busyRun && shownRun && busyRun.id !== shownRun.id && (
            <button
              type="button"
              onClick={() => setRunId(busyRun.id)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 hover:text-white"
            >
              Another run is in progress · show it
            </button>
          )}
          <span className="ml-auto flex items-center gap-1 text-zinc-500">
            {terminals && state.zoomed === undefined && shownCount > 1 && (
              <button
                type="button"
                aria-label="Even out the panes"
                title="Even out the panes"
                onClick={() => dispatch({ type: 'balance' })}
                className="rounded p-1 hover:bg-zinc-900 hover:text-zinc-100"
              >
                <Columns3 aria-hidden className="size-3.5" />
              </button>
            )}
            {(changesOffered || changesQuery.isError) && (
              <button
                type="button"
                aria-label={changesOpen ? 'Hide changes' : 'Review changes'}
                aria-expanded={changesOpen}
                aria-controls="changes-panel"
                title="Review changes, commit, push and open a pull request"
                onClick={() => (changesOpen ? setChangesOpen(false) : showChanges())}
                className={cn(
                  'flex h-6 items-center gap-1 rounded px-1.5 hover:bg-zinc-900 hover:text-zinc-100',
                  changesOpen && 'text-zinc-200',
                )}
              >
                <GitCompareArrows aria-hidden className="size-3.5" />
                {changesCount > 0 && <span className="tabular-nums">{changesCount}</span>}
              </button>
            )}
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1">
            {/* The terminals stay mounted behind the orchestrator view: hiding must not kill them. */}
            <div
              ref={area}
              className={cn('absolute inset-0.5', !terminals && 'invisible')}
              aria-hidden={!terminals}
            >
              {state.sessions.map((session) => {
                const shown = isShown(state, session.key);
                const rect =
                  state.zoomed === session.key
                    ? { left: 0, top: 0, width: 1, height: 1 }
                    : rects.get(session.key);
                return (
                  <div
                    key={session.key}
                    className={cn('absolute p-0.5', (!shown || !rect) && 'hidden')}
                    style={
                      rect
                        ? {
                            left: `${rect.left * 100}%`,
                            top: `${rect.top * 100}%`,
                            width: `${rect.width * 100}%`,
                            height: `${rect.height * 100}%`,
                          }
                        : undefined
                    }
                  >
                    <Pane
                      session={session}
                      bridge={bridge}
                      visible={active && terminals && shown}
                      focused={session.key === state.focused}
                      zoomed={state.zoomed === session.key}
                      workspace={
                        session.workspace ? workspaceById.get(session.workspace) : undefined
                      }
                      onFocus={() => dispatch({ type: 'focus', key: session.key })}
                      onClose={() => dispatch({ type: 'close', key: session.key })}
                      onRename={(name) => dispatch({ type: 'rename', key: session.key, name })}
                      onSplit={(direction) => split(session.key, direction)}
                      onMinimize={() => dispatch({ type: 'minimize', key: session.key })}
                      onZoom={() => dispatch({ type: 'zoom', key: session.key })}
                      onWriter={onWriter}
                      onLive={onLive}
                      onShowChanges={() => showChanges(session.workspace)}
                    />
                  </div>
                );
              })}
              {state.zoomed === undefined &&
                lines.map((divider) => (
                  <DividerHandle
                    key={`${divider.path.join('.')}:${divider.index}`}
                    divider={divider}
                    layout={state.layout}
                    area={area}
                    onResize={(layout) => dispatch({ type: 'layout', layout })}
                    onReset={() => dispatch({ type: 'balance' })}
                  />
                ))}
              {shownCount === 0 && (
                <EmptyTerminals
                  minimized={state.sessions.length}
                  onAdd={add}
                  onRestoreAll={() => {
                    for (const session of state.sessions) {
                      dispatch({ type: 'restore', key: session.key });
                    }
                  }}
                />
              )}
            </div>
            {!terminals && (
              <div className="absolute inset-0">
                {shownRun ? (
                  <RunThread
                    key={shownRun.id}
                    run={shownRun}
                    onOpenTerminals={() => setView('terminals')}
                  />
                ) : (
                  <EmptyOrchestrator />
                )}
              </div>
            )}
          </div>
          {changesOpen && (changesOffered || changesQuery.isError) && (
            <ChangesPanel
              workspaces={workspaces}
              error={changesQuery.isError ? errorMessage(changesQuery.error) : undefined}
              selectedId={changesId}
              onSelect={setChangesId}
              onClose={() => setChangesOpen(false)}
              agents={availableAgents(availability)}
            />
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          className="shrink-0 border-t border-zinc-800 p-2"
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 focus-within:border-zinc-600">
            <div className="flex items-start gap-2 px-3 pt-2">
              <span aria-hidden className="pt-0.5 font-mono text-xs text-zinc-500">
                ›
              </span>
              {/* One field for both modes, so switching never drops focus or the text typed so far. */}
              <textarea
                ref={composer}
                rows={rows}
                aria-label={
                  mode === 'orchestrate'
                    ? 'Objective for the orchestrator'
                    : 'Message for the agent panes'
                }
                aria-describedby={startError ? 'composer-error' : undefined}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setStartError(undefined);
                }}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter is a new line. Not while an IME is composing.
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  send();
                }}
                placeholder={
                  mode === 'orchestrate'
                    ? start.isPending
                      ? 'Starting the run…'
                      : 'Describe an objective. DaveCode plans it and splits it across your agents; you watch each one work.'
                    : recipients.length === 0
                      ? 'Open a session first'
                      : target === 'focused' && focusedSession
                        ? `Send to ${focusedSession.name}`
                        : agentSessions.length > 1
                          ? `Send to all ${agentSessions.length} agents`
                          : `Send to ${recipients[0]?.name ?? 'the pane'}`
                }
                className="min-w-0 flex-1 resize-none bg-transparent font-mono text-xs leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
              {offered && <ModeSwitch mode={mode} onChange={setChosenMode} />}
              {mode === 'orchestrate' && availability && (
                <>
                  <PlannerPicker
                    installed={availableAgents(availability)}
                    planner={planner}
                    onChange={setPlanner}
                  />
                  <AgentChips
                    agents={availability}
                    selection={selection}
                    onToggle={(agent) => setChosenAgents(toggleAgent(selection, agent))}
                  />
                  <AccessToggle access={access} onChange={setAccess} />
                </>
              )}
              {mode === 'broadcast' && (
                <label className="flex items-center gap-1 font-mono text-[11px] text-zinc-500">
                  to
                  <select
                    aria-label="Who receives the message"
                    value={target}
                    onChange={(event) => setTarget(event.target.value as Target)}
                    className="h-6 max-w-48 rounded border border-zinc-800 bg-black px-1 font-mono text-[11px] text-zinc-200 outline-none hover:border-zinc-600 focus:border-zinc-500"
                  >
                    <option value="agents">
                      {agentSessions.length > 0
                        ? `all agents (${agentSessions.length})`
                        : `every pane (${state.sessions.length})`}
                    </option>
                    {focusedSession && <option value="focused">{focusedSession.name}</option>}
                  </select>
                </label>
              )}
              {startError && (
                <p
                  id="composer-error"
                  role="alert"
                  title={startError}
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-red-400"
                >
                  {startError}
                </p>
              )}
              <button
                type="submit"
                disabled={!message.trim() || start.isPending}
                aria-label={mode === 'orchestrate' ? 'Start the run' : 'Send'}
                title="Enter to send, Shift+Enter for a new line"
                className="ml-auto flex h-6 items-center gap-1.5 rounded border border-zinc-500 bg-zinc-100 px-2 font-mono text-[11px] text-black hover:bg-white disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
              >
                <SendHorizontal aria-hidden className="size-3" />
                {mode === 'orchestrate' ? 'Run' : 'Send'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function EmptyTerminals({
  minimized,
  onAdd,
  onRestoreAll,
}: {
  /** Sessions that still run, off the grid. */
  minimized: number;
  onAdd: (kind: PaneKind) => void;
  onRestoreAll: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 font-mono text-xs text-zinc-500">
      <p>
        {minimized > 0
          ? `${minimized === 1 ? '1 session is' : `${minimized} sessions are`} minimized and still running.`
          : 'No session is open.'}
      </p>
      {minimized > 0 && (
        <button
          type="button"
          onClick={onRestoreAll}
          className="rounded border border-zinc-600 px-3 py-1 text-zinc-200 hover:border-zinc-400 hover:text-white"
        >
          Bring {minimized === 1 ? 'it' : 'them'} back
        </button>
      )}
      <div className="flex flex-wrap justify-center gap-1">
        {KINDS.map(({ kind, label, accent }) => (
          <button
            key={kind}
            type="button"
            onClick={() => onAdd(kind)}
            className="flex h-7 items-center gap-1.5 rounded border border-zinc-800 px-2 text-zinc-300 hover:border-zinc-600 hover:text-white"
          >
            <Plus aria-hidden className="size-3" style={{ color: accent }} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyOrchestrator() {
  return (
    <div className="flex h-full items-center justify-center p-6 font-mono text-xs text-zinc-500">
      <div className="max-w-md space-y-3 leading-relaxed">
        <p className="text-zinc-200">One objective, several agents, nothing hidden.</p>
        <p>
          Type an objective below. The lead agent splits it into tasks, each task runs in its own
          git worktree, and every agent gets a live card here showing what it reads, edits and runs.
        </p>
        <p>
          The results land on a <code className="text-zinc-300">davecode/run-…</code> branch. Your
          files change only when you press Apply.
        </p>
      </div>
    </div>
  );
}
