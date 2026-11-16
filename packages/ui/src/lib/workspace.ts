import type { PaneKind } from './desktop';
import {
  addPane,
  balance,
  EMPTY_LAYOUT,
  type Layout,
  layoutKeys,
  neighbour,
  removePane,
  type SplitDirection,
  splitPane,
} from './layout';
import { cleanSessionName, uniqueSessionName } from './sessions';

/**
 * State of the terminal workspace: the sessions (one pane each), where the visible ones sit,
 * which one has the keyboard and whether one is zoomed. A pure reducer, so every rule about
 * minimizing, zooming and closing can be tested without a terminal.
 */

export interface WorkspaceSession {
  key: number;
  kind: PaneKind;
  name: string;
  /** Isolated workspace (own worktree and branch) the pane runs in. */
  workspace?: string;
  /** Still running, but off the grid; found again in the sidebar. */
  minimized: boolean;
}

export interface WorkspaceState {
  sessions: WorkspaceSession[];
  /** Only the sessions that are not minimized. */
  layout: Layout;
  focused: number | undefined;
  /** The one pane filling the area, when zoomed. */
  zoomed: number | undefined;
  nextKey: number;
}

export type WorkspaceEvent =
  | {
      type: 'open';
      kind: PaneKind;
      /** Default name of the kind; numbered when taken. */
      label: string;
      workspace?: string | undefined;
      /** Put it next to this pane instead of where the grid has room. */
      split?: { near: number; direction: SplitDirection } | undefined;
    }
  | { type: 'close'; key: number }
  | { type: 'rename'; key: number; name: string }
  | { type: 'minimize'; key: number }
  | { type: 'restore'; key: number }
  /** Gives a pane the keyboard; a minimized one comes back first. */
  | { type: 'focus'; key: number }
  /** Zooms the pane, or back to the grid when it already is. */
  | { type: 'zoom'; key: number }
  /** A border was dragged. */
  | { type: 'layout'; layout: Layout }
  | { type: 'balance' };

export const EMPTY_WORKSPACE: WorkspaceState = {
  sessions: [],
  layout: EMPTY_LAYOUT,
  focused: undefined,
  zoomed: undefined,
  nextKey: 1,
};

/** The workspace a project opens with: one shell. */
export function initialWorkspace(): WorkspaceState {
  return workspaceReducer(EMPTY_WORKSPACE, { type: 'open', kind: 'shell', label: 'Shell' });
}

function has(state: WorkspaceState, key: number): boolean {
  return state.sessions.some((s) => s.key === key);
}

/** Takes a pane off the grid and moves focus and zoom off it. */
function leave(state: WorkspaceState, key: number): WorkspaceState {
  const next = state.focused === key ? neighbour(state.layout, key) : state.focused;
  const layout = removePane(state.layout, key);
  return {
    ...state,
    layout,
    focused: next !== undefined && layoutKeys(layout).includes(next) ? next : layoutKeys(layout)[0],
    zoomed: state.zoomed === key ? undefined : state.zoomed,
  };
}

export function workspaceReducer(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'open': {
      const key = state.nextKey;
      const name = uniqueSessionName(
        event.label,
        state.sessions.map((s) => s.name),
      );
      const session: WorkspaceSession = {
        key,
        kind: event.kind,
        name,
        minimized: false,
        ...(event.workspace ? { workspace: event.workspace } : {}),
      };
      const layout = event.split
        ? splitPane(state.layout, event.split.near, key, event.split.direction)
        : addPane(state.layout, key);
      return {
        sessions: [...state.sessions, session],
        layout,
        focused: key,
        // A new pane must be seen: it never opens behind a zoomed one.
        zoomed: undefined,
        nextKey: key + 1,
      };
    }
    case 'close': {
      if (!has(state, event.key)) return state;
      const left = leave(state, event.key);
      return { ...left, sessions: state.sessions.filter((s) => s.key !== event.key) };
    }
    case 'rename': {
      const current = state.sessions.find((s) => s.key === event.key);
      if (!current) return state;
      const name = cleanSessionName(event.name, current.name);
      if (name === current.name) return state;
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.key === event.key ? { ...s, name } : s)),
      };
    }
    case 'minimize': {
      const current = state.sessions.find((s) => s.key === event.key);
      if (!current || current.minimized) return state;
      const left = leave(state, event.key);
      return {
        ...left,
        sessions: state.sessions.map((s) => (s.key === event.key ? { ...s, minimized: true } : s)),
      };
    }
    case 'restore':
    case 'focus': {
      const current = state.sessions.find((s) => s.key === event.key);
      if (!current) return state;
      if (!current.minimized) {
        if (event.type === 'restore') return state;
        // With a pane zoomed, picking another one swaps which pane fills the area.
        const zoomed = state.zoomed === undefined ? undefined : event.key;
        if (state.focused === event.key && state.zoomed === zoomed) return state;
        return { ...state, focused: event.key, zoomed };
      }
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.key === event.key ? { ...s, minimized: false } : s)),
        layout: addPane(state.layout, event.key),
        focused: event.key,
        zoomed: state.zoomed === undefined ? undefined : event.key,
      };
    }
    case 'zoom': {
      const current = state.sessions.find((s) => s.key === event.key);
      if (!current || current.minimized) return state;
      return {
        ...state,
        focused: event.key,
        zoomed: state.zoomed === event.key ? undefined : event.key,
      };
    }
    case 'layout':
      return { ...state, layout: event.layout };
    case 'balance':
      return { ...state, layout: balance(state.layout) };
  }
}

/** Whether a pane is on screen: on the grid, and not behind a zoomed one. */
export function isShown(state: WorkspaceState, key: number): boolean {
  if (state.zoomed !== undefined) return state.zoomed === key;
  return layoutKeys(state.layout).includes(key);
}
