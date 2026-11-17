import { z } from 'zod';
import { AGENT_IDS } from './agents';
import type { PaneKind } from './desktop';
import {
  addPane,
  balance,
  EMPTY_LAYOUT,
  type Layout,
  type LayoutNode,
  layoutKeys,
  neighbour,
  removePane,
  type SplitDirection,
  splitPane,
} from './layout';
import { cleanSessionName, SESSION_NAME_MAX_LENGTH, uniqueSessionName } from './sessions';

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

// --- Keeping the workspace across launches ----------------------------------------------------

/** Most sessions kept for a project; the app refuses a larger state. */
export const SAVED_SESSIONS_MAX = 64;
const LAYOUT_DEPTH_MAX = 12;

export interface SavedWorkspace {
  version: 1;
  sessions: WorkspaceSession[];
  layout: Layout;
  focused?: number | undefined;
  zoomed?: number | undefined;
  /** The sidebar is shown. */
  sidebar: boolean;
  /** What the agents of the next orchestrator run may do. */
  access: 'edit' | 'full';
}

const savedKey = z.number().int().min(1).max(1_000_000);

function savedNode(depth: number): z.ZodType<LayoutNode> {
  const pane = z.object({ kind: z.literal('pane'), key: savedKey });
  if (depth >= LAYOUT_DEPTH_MAX) return pane;
  return z.union([
    pane,
    z.object({
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      children: z
        .array(
          z.object({
            node: z.lazy(() => savedNode(depth + 1)),
            weight: z.number().positive().max(1_000_000),
          }),
        )
        .min(1)
        .max(SAVED_SESSIONS_MAX),
    }),
  ]);
}

const savedSchema = z.object({
  version: z.literal(1),
  sessions: z
    .array(
      z.object({
        key: savedKey,
        kind: z.enum(['shell', ...AGENT_IDS] as [PaneKind, ...PaneKind[]]),
        name: z.string().min(1).max(SESSION_NAME_MAX_LENGTH),
        workspace: z
          .string()
          .regex(/^[a-z0-9]{4,24}$/)
          .optional(),
        minimized: z.boolean(),
      }),
    )
    .max(SAVED_SESSIONS_MAX),
  layout: z.object({ root: savedNode(0).optional() }),
  focused: savedKey.optional(),
  zoomed: savedKey.optional(),
  sidebar: z.boolean(),
  access: z.enum(['edit', 'full']),
});

/** What the app handed back, if it is a saved workspace; anything else is ignored. */
export function parseSavedWorkspace(value: unknown): SavedWorkspace | undefined {
  const parsed = savedSchema.safeParse(value);
  return parsed.success ? (parsed.data as SavedWorkspace) : undefined;
}

/** What is worth keeping of the workspace, in the shape the app stores. */
export function savedWorkspace(
  state: WorkspaceState,
  prefs: Pick<SavedWorkspace, 'sidebar' | 'access'>,
): SavedWorkspace {
  return {
    version: 1,
    sessions: state.sessions.slice(0, SAVED_SESSIONS_MAX).map((s) => ({
      key: s.key,
      kind: s.kind,
      name: s.name,
      minimized: s.minimized,
      ...(s.workspace ? { workspace: s.workspace } : {}),
    })),
    layout: state.layout,
    ...(state.focused !== undefined ? { focused: state.focused } : {}),
    ...(state.zoomed !== undefined ? { zoomed: state.zoomed } : {}),
    sidebar: prefs.sidebar,
    access: prefs.access,
  };
}

/**
 * The workspace a saved state describes, repaired where it disagrees with itself: repeated
 * sessions are dropped, the grid holds exactly the sessions that are not minimized, and focus and
 * zoom point at a pane that is on it. Undefined when nothing is left to open.
 */
export function restoreWorkspace(saved: SavedWorkspace): WorkspaceState | undefined {
  const seen = new Set<number>();
  const sessions = saved.sessions.filter((session) => {
    if (seen.has(session.key)) return false;
    seen.add(session.key);
    return true;
  });
  if (sessions.length === 0) return undefined;
  const onGrid = new Set(sessions.filter((s) => !s.minimized).map((s) => s.key));
  const keys = layoutKeys(saved.layout);
  // A pane listed twice means the layout cannot be trusted: lay the grid out again.
  let layout = new Set(keys).size === keys.length ? saved.layout : EMPTY_LAYOUT;
  for (const key of layoutKeys(layout)) if (!onGrid.has(key)) layout = removePane(layout, key);
  for (const key of onGrid) layout = addPane(layout, key);
  const placed = new Set(layoutKeys(layout));
  const zoomed = saved.zoomed !== undefined && placed.has(saved.zoomed) ? saved.zoomed : undefined;
  const focused =
    zoomed ??
    (saved.focused !== undefined && placed.has(saved.focused)
      ? saved.focused
      : layoutKeys(layout)[0]);
  return {
    sessions,
    layout,
    focused,
    zoomed,
    nextKey: Math.max(...sessions.map((s) => s.key)) + 1,
  };
}
