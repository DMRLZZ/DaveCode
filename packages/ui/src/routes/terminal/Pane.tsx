import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Columns2, GitBranch, Maximize2, Minimize2, Minus, Rows2, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { lineCounts, shortBranch } from '../../lib/changes';
import { cn } from '../../lib/cn';
import type { PaneKind, TerminalBridge } from '../../lib/desktop';
import type { SplitDirection } from '../../lib/layout';
import { isWorkspaceShortcut } from '../../lib/sessions';
import type { ChangesWorkspace } from '../../lib/types';
import { kindMeta } from './kinds';

export interface PaneSession {
  key: number;
  kind: PaneKind;
  name: string;
  /** Isolated workspace (own worktree and branch) the pane runs in. */
  workspace?: string;
}

function isCopy(e: KeyboardEvent, selection: boolean): boolean {
  if (e.key.toLowerCase() !== 'c' || !(e.ctrlKey || e.metaKey)) return false;
  return e.shiftKey || selection;
}

function isPaste(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey);
}

/** The pane's name; double-click (or F2 on it) turns it into a field. */
export function EditableName({
  name,
  label,
  onRename,
  className,
}: {
  name: string;
  /** What the field is called for assistive technology. */
  label: string;
  onRename: (name: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== undefined;
  // Selects the name once, when the field appears; not on every keystroke.
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (draft === undefined) {
    return (
      <button
        type="button"
        title="Double-click to rename"
        onDoubleClick={() => setDraft(name)}
        onKeyDown={(event) => {
          if (event.key === 'F2') setDraft(name);
        }}
        className={cn('min-w-0 truncate text-left outline-none focus-visible:underline', className)}
      >
        {name}
      </button>
    );
  }
  const commit = () => {
    onRename(draft);
    setDraft(undefined);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') setDraft(undefined);
  };
  return (
    <input
      ref={input}
      aria-label={label}
      value={draft}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      className={cn(
        'h-5 min-w-0 flex-1 rounded-sm border border-zinc-600 bg-black px-1 text-zinc-100 outline-none',
        className,
      )}
    />
  );
}

function HeaderButton({
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
      // Keeps the click from first moving focus (and the terminal cursor) to this pane.
      onMouseDown={(event) => event.stopPropagation()}
      className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

export function Pane({
  session,
  bridge,
  visible,
  focused,
  zoomed,
  workspace,
  onFocus,
  onClose,
  onRename,
  onSplit,
  onMinimize,
  onZoom,
  onWriter,
  onLive,
  onShowChanges,
}: {
  session: PaneSession;
  bridge: TerminalBridge;
  /** Shown on screen right now (not minimized, not behind a zoomed pane or another view). */
  visible: boolean;
  focused: boolean;
  zoomed: boolean;
  /** Live state of the pane's isolated workspace, once known. */
  workspace: ChangesWorkspace | undefined;
  onFocus: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onSplit: (direction: SplitDirection) => void;
  onMinimize: () => void;
  onZoom: () => void;
  onWriter: (key: number, writer: ((data: string) => void) | undefined) => void;
  onLive: (key: number, live: boolean) => void;
  onShowChanges: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const refit = useRef<() => void>(() => {});
  const [live, setLive] = useState(false);
  const meta = kindMeta(session.kind);

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
      // Workspace shortcuts (split, minimize…) belong to the window, not to the shell.
      if (isWorkspaceShortcut(event)) return false;
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
    const alive = (value: boolean) => {
      setLive(value);
      onLive(session.key, value);
    };
    // Output can arrive before `open` resolves, so nothing is matched to this pane yet.
    const early: [string, string][] = [];
    const offData = bridge.onData((from, data) => {
      if (starting) early.push([from, data]);
      else if (from === id) term.write(data);
    });
    const offExit = bridge.onExit((from, code) => {
      if (from !== id) return;
      id = undefined;
      alive(false);
      onWriter(session.key, undefined);
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    });
    const typed = term.onData((data) => {
      if (id !== undefined) void bridge.write({ id, data });
    });

    let frame = 0;
    refit.current = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      // When a pane narrows (a split, a panel opening), the first fit can measure the old,
      // wider screen and overflow the pane; fitting again once it has rendered settles it.
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
      .open({
        kind: session.kind,
        cols: term.cols,
        rows: term.rows,
        ...(session.workspace ? { workspace: session.workspace } : {}),
      })
      .then((opened) => {
        if (disposed) {
          void bridge.close(opened);
          return;
        }
        id = opened;
        starting = false;
        for (const [from, data] of early) if (from === opened) term.write(data);
        early.length = 0;
        alive(true);
        onWriter(session.key, (data) => void bridge.write({ id: opened, data }));
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
      onWriter(session.key, undefined);
      if (id !== undefined) void bridge.close(id);
      term.dispose();
    };
  }, []);

  // A hidden pane has no size; fit again when it comes back.
  useEffect(() => {
    if (visible) refit.current();
    if (visible && focused) terminal.current?.focus();
  }, [visible, focused]);

  return (
    <section
      data-pane-live={live}
      data-pane-key={session.key}
      aria-label={session.name}
      onMouseDown={onFocus}
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col border bg-black',
        focused ? 'border-zinc-500' : 'border-zinc-800',
      )}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-800 px-2 font-mono text-[11px] text-zinc-400">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: meta.accent }}
        />
        <EditableName
          name={session.name}
          label={`Name of the ${meta.label} pane`}
          onRename={onRename}
          className="max-w-[45%] text-zinc-300"
        />
        {session.name !== meta.label && (
          <span className="shrink-0 text-zinc-600">{meta.label}</span>
        )}
        {session.workspace && (
          <button
            type="button"
            onClick={onShowChanges}
            title={
              workspace?.branch
                ? `Isolated on ${workspace.branch}: review its changes`
                : 'Isolated workspace'
            }
            className="flex min-w-0 items-center gap-1 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {workspace ? shortBranch(workspace.branch) : 'isolated'}
            </span>
            {workspace && workspace.files.length > 0 && (
              <span className="shrink-0 tabular-nums text-zinc-400">{lineCounts(workspace)}</span>
            )}
          </button>
        )}
        {!live && <span className="shrink-0 text-zinc-600">stopped</span>}
        {/* The empty part of the bar zooms on double-click, like a window's title bar. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onDoubleClick={onZoom}
          className="h-full min-w-2 flex-1 cursor-default"
        />
        <span className="flex shrink-0 items-center gap-0.5">
          {!zoomed && (
            <>
              <HeaderButton label="Split right (Ctrl+Shift+D)" onClick={() => onSplit('right')}>
                <Columns2 aria-hidden className="size-3" />
              </HeaderButton>
              <HeaderButton label="Split down (Ctrl+Shift+E)" onClick={() => onSplit('down')}>
                <Rows2 aria-hidden className="size-3" />
              </HeaderButton>
            </>
          )}
          <HeaderButton
            label="Minimize: keeps running in the sidebar (Ctrl+Shift+M)"
            onClick={onMinimize}
          >
            <Minus aria-hidden className="size-3" />
          </HeaderButton>
          <HeaderButton
            label={zoomed ? 'Restore size (Ctrl+Shift+Enter)' : 'Maximize (Ctrl+Shift+Enter)'}
            onClick={onZoom}
          >
            {zoomed ? (
              <Minimize2 aria-hidden className="size-3" />
            ) : (
              <Maximize2 aria-hidden className="size-3" />
            )}
          </HeaderButton>
          <HeaderButton label={`Close ${session.name} (Ctrl+Shift+W)`} onClick={onClose}>
            <X aria-hidden className="size-3" />
          </HeaderButton>
        </span>
      </header>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden p-1.5" />
    </section>
  );
}
