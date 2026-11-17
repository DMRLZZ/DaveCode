import {
  ChevronDown,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Minus,
  PanelLeftClose,
  Plus,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BrandMark } from '../../components/shell/Sidebar';
import { isChatBusy } from '../../lib/chat';
import { cn } from '../../lib/cn';
import type { PaneKind } from '../../lib/desktop';
import { formatRelative } from '../../lib/format';
import { isActiveRun, RUN_STATUS_LABEL, runProgress } from '../../lib/orchestrator';
import { Link } from '../../lib/router';
import type { ChatSession, OrchestratorAgent, OrchestratorRun } from '../../lib/types';
import { KINDS, kindMeta } from './kinds';
import { STATUS_TEXT } from './Orchestrator';
import { EditableName } from './Pane';

export interface SidebarSession {
  key: number;
  kind: PaneKind;
  name: string;
  minimized: boolean;
  live: boolean;
  /** Short branch of its isolated workspace, when it has one. */
  branch?: string | undefined;
  /** It finished or asked for the person while they looked elsewhere. */
  attention: boolean;
}

/** Runs listed before "Show all". */
const RUNS_SHOWN = 6;

function Heading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center px-3 text-[10px] uppercase tracking-wider text-zinc-600">
      <span>{children}</span>
      <span className="ml-auto flex items-center">{action}</span>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

/**
 * The workspace's left column: the project, every session (pane) with its state, and the
 * orchestrator runs. Sessions keep running when minimized; this is where they are found again.
 */
export function SessionSidebar({
  projectName,
  onChooseProject,
  sessions,
  focused,
  showingRun,
  onSelectSession,
  onRenameSession,
  onToggleMinimize,
  onCloseSession,
  onAdd,
  isolateOffered,
  isolate,
  onIsolate,
  creating,
  addError,
  runsOffered,
  runs,
  runId,
  onSelectRun,
  onNewRun,
  chatsOffered,
  chats,
  chatId,
  showingChat,
  chatAgents,
  creatingChat,
  onSelectChat,
  onNewChat,
  changesOffered,
  changesCount,
  onShowChanges,
  onCollapse,
  installed,
  defaultAgent,
  yolo,
  onNewDefault,
  defaultIsChat,
}: {
  projectName: string | undefined;
  /** Absent outside the desktop app. */
  onChooseProject: (() => void) | undefined;
  sessions: SidebarSession[];
  focused: number | undefined;
  /** A run is on screen instead of the terminals, so no session row is current. */
  showingRun: boolean;
  onSelectSession: (key: number) => void;
  onRenameSession: (key: number, name: string) => void;
  onToggleMinimize: (key: number) => void;
  onCloseSession: (key: number) => void;
  onAdd: (kind: PaneKind) => void;
  isolateOffered: boolean;
  isolate: boolean;
  onIsolate: (on: boolean) => void;
  creating: boolean;
  addError: string | undefined;
  runsOffered: boolean;
  runs: OrchestratorRun[];
  runId: string | undefined;
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  /** The gateway serves agent chats. */
  chatsOffered: boolean;
  /** Newest first. */
  chats: ChatSession[];
  chatId: string | undefined;
  /** A chat is on screen. */
  showingChat: boolean;
  /** The installed agents that can chat, the default one first. */
  chatAgents: OrchestratorAgent[];
  creatingChat: boolean;
  onSelectChat: (id: string) => void;
  onNewChat: (agent: OrchestratorAgent) => void;
  changesOffered: boolean;
  changesCount: number;
  onShowChanges: () => void;
  onCollapse: () => void;
  /** Which agent CLIs are on this computer; undefined until known. */
  installed: Map<string, boolean> | undefined;
  defaultAgent: PaneKind;
  /** New agent sessions start without asking for permission. */
  yolo: boolean;
  /** Opens the default agent: a chat in chat mode, a terminal otherwise. */
  onNewDefault: () => void;
  defaultIsChat: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [allKinds, setAllKinds] = useState(false);
  // The shell and the agents found on this computer first, the default agent at the top of those.
  const present = KINDS.filter(
    (k) => k.kind === 'shell' || installed === undefined || installed.get(k.kind),
  ).sort((a, b) => Number(b.kind === defaultAgent) - Number(a.kind === defaultAgent));
  const absent = KINDS.filter((k) => !present.includes(k));
  const defaultMeta = kindMeta(defaultAgent);
  const [allRuns, setAllRuns] = useState(false);
  const menuOpen = adding || sessions.length === 0;
  const shownRuns = allRuns ? runs : runs.slice(0, RUNS_SHOWN);

  return (
    <aside
      id="workspace-sidebar"
      aria-label="Sessions"
      className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-black font-mono text-[11px] text-zinc-400"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
        <BrandMark className="size-5 shrink-0" />
        <span className="text-xs text-zinc-100">DaveCode</span>
        <button
          type="button"
          aria-label="Hide the sidebar"
          title="Hide the sidebar (Ctrl+Shift+B)"
          onClick={onCollapse}
          className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
        >
          <PanelLeftClose aria-hidden className="size-3.5" />
        </button>
      </div>

      <button
        type="button"
        onClick={onChooseProject}
        disabled={!onChooseProject}
        title={onChooseProject ? 'Open another project' : undefined}
        className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-900 px-3 text-left text-zinc-300 enabled:hover:bg-zinc-900 enabled:hover:text-white"
      >
        <FolderOpen aria-hidden className="size-3.5 shrink-0 text-zinc-500" />
        <span className="truncate">{projectName ?? 'Project'}</span>
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <Heading
          action={
            <button
              type="button"
              aria-label="New session"
              aria-expanded={menuOpen}
              aria-controls="new-session-menu"
              title="New session"
              onClick={() => setAdding((open) => !open)}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {menuOpen ? (
                <ChevronDown aria-hidden className="size-3.5" />
              ) : (
                <Plus aria-hidden className="size-3.5" />
              )}
            </button>
          }
        >
          Sessions
        </Heading>

        <button
          type="button"
          disabled={creating}
          onClick={onNewDefault}
          title={`New ${defaultMeta.label} ${defaultIsChat ? 'chat' : 'session'} (Ctrl+Shift+T)`}
          className="mx-2 mb-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded border border-zinc-800 px-2 text-left text-zinc-200 hover:border-zinc-600 hover:text-white disabled:opacity-50"
        >
          <Plus aria-hidden className="size-3 shrink-0" style={{ color: defaultMeta.accent }} />
          <span className="truncate">
            New {defaultMeta.label}
            {defaultIsChat ? ' chat' : ''}
          </span>
          {yolo && defaultMeta.kind !== 'shell' && (
            <span
              title="YOLO mode: agents start without asking for permission"
              className="ml-auto shrink-0 rounded border border-amber-300/40 px-1 text-[9px] text-amber-300"
            >
              YOLO
            </span>
          )}
        </button>

        {menuOpen && (
          <div id="new-session-menu" className="mx-2 mb-2 rounded border border-zinc-800 py-1">
            {[...present, ...(allKinds ? absent : [])].map(({ kind, label, accent }) => {
              const missing = absent.some((k) => k.kind === kind);
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={creating}
                  title={missing ? `${label} was not found on this computer` : undefined}
                  onClick={() => {
                    onAdd(kind);
                    setAdding(false);
                  }}
                  className={cn(
                    'flex h-6 w-full items-center gap-2 px-2 text-left hover:bg-zinc-900 hover:text-white disabled:opacity-50',
                    missing ? 'text-zinc-600' : 'text-zinc-300',
                  )}
                >
                  <Plus aria-hidden className="size-3 shrink-0" style={{ color: accent }} />
                  <span className="truncate">{label}</span>
                  {kind === defaultAgent && <span className="ml-auto text-zinc-600">default</span>}
                  {missing && <span className="ml-auto text-zinc-700">not found</span>}
                </button>
              );
            })}
            {absent.length > 0 && (
              <button
                type="button"
                onClick={() => setAllKinds((all) => !all)}
                className="flex h-6 w-full items-center px-2 text-left text-zinc-600 hover:text-zinc-200"
              >
                {allKinds ? 'Fewer agents' : `More agents (${absent.length})`}
              </button>
            )}
            {isolateOffered && (
              <label
                title="New sessions get their own git worktree and branch, so agents never step on each other"
                className="mt-1 flex h-6 cursor-pointer items-center gap-2 border-t border-zinc-900 px-2 pt-1 text-zinc-500 hover:text-zinc-200"
              >
                <input
                  type="checkbox"
                  checked={isolate}
                  onChange={(event) => onIsolate(event.target.checked)}
                  className="size-3 accent-white"
                />
                <GitBranch aria-hidden className="size-3 shrink-0" />
                {creating ? 'Creating a worktree…' : 'Isolated worktree'}
              </label>
            )}
          </div>
        )}
        {addError && (
          <p role="alert" className="mx-3 mb-2 break-words text-red-400">
            {addError}
          </p>
        )}

        <ul aria-label="Open sessions">
          {sessions.map((session) => {
            const meta = kindMeta(session.kind);
            const current = !showingRun && session.key === focused && !session.minimized;
            return (
              <li
                key={session.key}
                aria-current={current ? 'true' : undefined}
                className={cn(
                  'group flex h-7 items-center gap-2 px-3',
                  current ? 'bg-zinc-900 text-zinc-100' : 'hover:bg-zinc-950',
                )}
              >
                <button
                  type="button"
                  aria-label={
                    session.minimized ? `Restore ${session.name}` : `Go to ${session.name}`
                  }
                  onClick={() => onSelectSession(session.key)}
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 rounded-full',
                      session.minimized && 'ring-1 ring-zinc-600 ring-offset-1 ring-offset-black',
                    )}
                    style={{ background: session.live ? meta.accent : '#3f3f46' }}
                  />
                </button>
                {/* The row is one click target; the name inside turns into a field on double-click. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: the dot button is the keyboard path */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the dot button is the keyboard path */}
                <div
                  onClick={() => onSelectSession(session.key)}
                  className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
                >
                  <EditableName
                    name={session.name}
                    label={`Name of ${session.name}`}
                    onRename={(name) => onRenameSession(session.key, name)}
                    className={cn(
                      session.minimized ? 'text-zinc-500' : 'text-zinc-200',
                      !session.live && 'line-through decoration-zinc-700',
                    )}
                  />
                  {session.branch && (
                    <span className="flex min-w-0 shrink items-center gap-0.5 text-zinc-600">
                      <GitBranch aria-hidden className="size-2.5 shrink-0" />
                      <span className="truncate">{session.branch}</span>
                    </span>
                  )}
                </div>
                {session.attention && (
                  <span
                    role="img"
                    aria-label="Finished or needs you"
                    title="Finished or needs you"
                    className="size-1.5 shrink-0 rounded-full bg-zinc-100"
                  />
                )}
                {session.minimized && <span className="shrink-0 text-zinc-600">min</span>}
                <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex">
                  <RowButton
                    label={
                      session.minimized ? `Restore ${session.name}` : `Minimize ${session.name}`
                    }
                    onClick={() => onToggleMinimize(session.key)}
                  >
                    {session.minimized ? (
                      <SquareArrowOutUpRight aria-hidden className="size-3" />
                    ) : (
                      <Minus aria-hidden className="size-3" />
                    )}
                  </RowButton>
                  <RowButton
                    label={`Close ${session.name}`}
                    onClick={() => onCloseSession(session.key)}
                  >
                    <X aria-hidden className="size-3" />
                  </RowButton>
                </span>
              </li>
            );
          })}
        </ul>
        {sessions.length === 0 && <p className="px-3 text-zinc-600">No session is open.</p>}

        {chatsOffered && (
          <ChatList
            chats={chats}
            chatId={chatId}
            showingChat={showingChat}
            agents={chatAgents}
            creating={creatingChat}
            onSelect={onSelectChat}
            onNew={onNewChat}
          />
        )}

        {runsOffered && (
          <>
            <Heading
              action={
                <button
                  type="button"
                  aria-label="New orchestrator run"
                  title="New run: describe an objective for your agents"
                  onClick={onNewRun}
                  className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <Plus aria-hidden className="size-3.5" />
                </button>
              }
            >
              Orchestrator
            </Heading>
            <ul aria-label="Orchestrator runs">
              {shownRuns.map((run) => {
                const current = showingRun && run.id === runId;
                const active = isActiveRun(run);
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => onSelectRun(run.id)}
                      title={run.objective}
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-1.5 text-left',
                        current ? 'bg-zinc-900' : 'hover:bg-zinc-950',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            active ? 'animate-pulse bg-white' : 'bg-zinc-700',
                          )}
                        />
                        <span className="truncate text-zinc-200">{run.objective}</span>
                      </span>
                      <span className="flex gap-2 pl-3.5">
                        <span className={STATUS_TEXT[run.status]}>
                          {RUN_STATUS_LABEL[run.status]}
                        </span>
                        {runProgress(run) && (
                          <span className="tabular-nums text-zinc-600">{runProgress(run)}</span>
                        )}
                        {run.appliedAt && <span className="text-zinc-500">applied</span>}
                        <span className="ml-auto text-zinc-600">
                          {formatRelative(Date.parse(run.createdAt))}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {runs.length === 0 && (
              <p className="px-3 leading-relaxed text-zinc-600">
                No runs yet. Describe an objective below and your agents split the work.
              </p>
            )}
            {runs.length > RUNS_SHOWN && (
              <button
                type="button"
                onClick={() => setAllRuns((all) => !all)}
                className="px-3 py-1 text-zinc-600 hover:text-zinc-200"
              >
                {allRuns ? 'Show fewer' : `Show all ${runs.length}`}
              </button>
            )}
          </>
        )}
      </div>

      <nav aria-label="DaveCode" className="shrink-0 border-t border-zinc-800 py-1">
        {changesOffered && (
          <button
            type="button"
            onClick={onShowChanges}
            title="Review changes, commit, push and open a pull request"
            className="flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-zinc-900 hover:text-zinc-100"
          >
            <GitCompareArrows aria-hidden className="size-3.5" />
            Changes
            {changesCount > 0 && (
              <span className="ml-auto tabular-nums text-zinc-300">{changesCount}</span>
            )}
          </button>
        )}
        {(
          [
            ['/accounts', 'Connections'],
            ['/overview', 'Dashboard'],
            ['/settings', 'Settings'],
          ] as const
        ).map(([to, label]) => (
          <Link
            key={to}
            to={to}
            className="flex h-7 items-center px-3 hover:bg-zinc-900 hover:text-zinc-100"
          >
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

const CHATS_SHOWN = 8;

/** The project's agent chats, and a way to start one with any installed chat agent. */
function ChatList({
  chats,
  chatId,
  showingChat,
  agents,
  creating,
  onSelect,
  onNew,
}: {
  chats: ChatSession[];
  chatId: string | undefined;
  showingChat: boolean;
  agents: OrchestratorAgent[];
  creating: boolean;
  onSelect: (id: string) => void;
  onNew: (agent: OrchestratorAgent) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? chats : chats.slice(0, CHATS_SHOWN);
  return (
    <>
      <Heading
        action={
          agents.length > 0 && (
            <button
              type="button"
              aria-label="New chat"
              aria-expanded={picking}
              title="New chat"
              disabled={creating}
              onClick={() => setPicking((open) => !open)}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              {picking ? (
                <ChevronDown aria-hidden className="size-3.5" />
              ) : (
                <Plus aria-hidden className="size-3.5" />
              )}
            </button>
          )
        }
      >
        Chats
      </Heading>
      {picking && (
        <div className="mx-2 mb-2 rounded border border-zinc-800 py-1">
          {agents.map((agent) => {
            const meta = kindMeta(agent);
            return (
              <button
                key={agent}
                type="button"
                disabled={creating}
                onClick={() => {
                  onNew(agent);
                  setPicking(false);
                }}
                className="flex h-6 w-full items-center gap-2 px-2 text-left text-zinc-300 hover:bg-zinc-900 hover:text-white disabled:opacity-50"
              >
                <Plus aria-hidden className="size-3 shrink-0" style={{ color: meta.accent }} />
                Chat with {meta.label}
              </button>
            );
          })}
        </div>
      )}
      <ul aria-label="Chats">
        {shown.map((chat) => {
          const busy = isChatBusy(chat);
          const current = showingChat && chat.id === chatId;
          return (
            <li key={chat.id}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(chat.id)}
                title={chat.title}
                className={cn(
                  'flex h-7 w-full items-center gap-2 px-3 text-left',
                  current ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-950',
                )}
              >
                <span
                  aria-hidden
                  className={cn('size-1.5 shrink-0 rounded-full', busy && 'animate-pulse')}
                  style={{ background: kindMeta(chat.agent).accent }}
                />
                <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                <span className="shrink-0 text-zinc-600">
                  {busy ? 'working' : formatRelative(Date.parse(chat.updatedAt))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {chats.length === 0 && (
        <p className="px-3 leading-relaxed text-zinc-600">
          {agents.length > 0
            ? 'No chats yet. Start one to talk to an agent and see its edits as diffs.'
            : 'Chats need Claude Code, Codex or Antigravity installed.'}
        </p>
      )}
      {chats.length > CHATS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="px-3 py-1 text-zinc-600 hover:text-zinc-200"
        >
          {all ? 'Show fewer' : `Show all ${chats.length}`}
        </button>
      )}
    </>
  );
}
