import { describe, expect, it } from 'vitest';
import type { PaneKind } from './desktop';
import { layoutKeys, layoutShape, paneRects, resizeAt } from './layout';
import {
  EMPTY_WORKSPACE,
  initialWorkspace,
  isShown,
  parseSavedWorkspace,
  restoreWorkspace,
  savedWorkspace,
  type WorkspaceEvent,
  type WorkspaceState,
  workspaceReducer,
} from './workspace';

const open = (kind: PaneKind, label: string, extra: object = {}): WorkspaceEvent => ({
  type: 'open',
  kind,
  label,
  ...extra,
});

const play = (events: WorkspaceEvent[], from: WorkspaceState = initialWorkspace()) =>
  events.reduce(workspaceReducer, from);

const names = (state: WorkspaceState) => state.sessions.map((s) => s.name);
const grid = (state: WorkspaceState) => layoutShape(state.layout);

describe('opening sessions', () => {
  it('starts a project with one focused shell', () => {
    const state = initialWorkspace();
    expect(names(state)).toEqual(['Shell']);
    expect(state.focused).toBe(1);
    expect(grid(state)).toBe('1');
    expect(state.nextKey).toBe(2);
  });

  it('numbers repeated kinds and focuses the new pane', () => {
    const state = play([open('claude', 'Claude Code'), open('claude', 'Claude Code')]);
    expect(names(state)).toEqual(['Shell', 'Claude Code', 'Claude Code 2']);
    expect(state.focused).toBe(3);
    expect(grid(state)).toBe('[1|[2/3]]');
  });

  it('splits next to a pane and carries the isolated workspace', () => {
    const state = play([
      open('codex', 'Codex', { workspace: 'abcd12' }),
      open('shell', 'Shell', { workspace: 'abcd12', split: { near: 2, direction: 'down' } }),
    ]);
    expect(grid(state)).toBe('[1|[2/3]]');
    expect(state.sessions[2]).toMatchObject({ name: 'Shell 2', workspace: 'abcd12' });
    expect(state.sessions[0]?.workspace).toBeUndefined();
  });

  it('never opens a pane behind a zoomed one', () => {
    const state = play([{ type: 'zoom', key: 1 }, open('codex', 'Codex')]);
    expect(state.zoomed).toBeUndefined();
    expect(isShown(state, 2)).toBe(true);
  });
});

describe('closing', () => {
  it('moves focus to a neighbour and forgets the session', () => {
    const state = play([
      open('claude', 'Claude Code'),
      open('codex', 'Codex'),
      { type: 'close', key: 3 },
    ]);
    expect(names(state)).toEqual(['Shell', 'Claude Code']);
    expect(state.focused).toBe(2);
    expect(grid(state)).toBe('[1|2]');
  });

  it('keeps focus where it was when another pane closes', () => {
    const state = play([
      open('claude', 'Claude Code'),
      { type: 'focus', key: 1 },
      { type: 'close', key: 2 },
    ]);
    expect(state.focused).toBe(1);
  });

  it('leaves an empty workspace and ignores unknown keys', () => {
    const empty = play([{ type: 'close', key: 1 }]);
    expect(empty.sessions).toEqual([]);
    expect(empty.focused).toBeUndefined();
    expect(workspaceReducer(empty, { type: 'close', key: 9 })).toBe(empty);
    // Keys are never reused, so a late event for a closed pane cannot hit a new one.
    expect(play([open('shell', 'Shell')], empty).sessions[0]?.key).toBe(2);
  });
});

describe('renaming', () => {
  it('tidies the name and keeps the old one when empty', () => {
    const renamed = play([{ type: 'rename', key: 1, name: '  api   server ' }]);
    expect(names(renamed)).toEqual(['api server']);
    expect(workspaceReducer(renamed, { type: 'rename', key: 1, name: '   ' })).toBe(renamed);
    // The freed default name is available again.
    expect(names(play([open('shell', 'Shell')], renamed))).toEqual(['api server', 'Shell']);
  });
});

describe('minimizing', () => {
  it('takes the pane off the grid but keeps the session', () => {
    const state = play([open('claude', 'Claude Code'), { type: 'minimize', key: 2 }]);
    expect(names(state)).toEqual(['Shell', 'Claude Code']);
    expect(state.sessions[1]?.minimized).toBe(true);
    expect(grid(state)).toBe('1');
    expect(state.focused).toBe(1);
    expect(isShown(state, 2)).toBe(false);
    expect(workspaceReducer(state, { type: 'minimize', key: 2 })).toBe(state);
  });

  it('restores through focus, back onto the grid', () => {
    const state = play([
      open('claude', 'Claude Code'),
      { type: 'minimize', key: 2 },
      { type: 'focus', key: 2 },
    ]);
    expect(state.sessions[1]?.minimized).toBe(false);
    expect(state.focused).toBe(2);
    expect(layoutKeys(state.layout)).toEqual([1, 2]);
  });

  it('can minimize everything', () => {
    const state = play([{ type: 'minimize', key: 1 }]);
    expect(grid(state)).toBe('');
    expect(state.focused).toBeUndefined();
    expect(play([{ type: 'restore', key: 1 }], state).focused).toBe(1);
  });

  it('drops the zoom when the zoomed pane is minimized', () => {
    const state = play([
      open('codex', 'Codex'),
      { type: 'zoom', key: 2 },
      { type: 'minimize', key: 2 },
    ]);
    expect(state.zoomed).toBeUndefined();
    expect(isShown(state, 1)).toBe(true);
  });
});

describe('zooming', () => {
  it('toggles one pane over the whole area', () => {
    const zoomed = play([open('codex', 'Codex'), { type: 'zoom', key: 1 }]);
    expect(zoomed.zoomed).toBe(1);
    expect(zoomed.focused).toBe(1);
    expect(isShown(zoomed, 1)).toBe(true);
    expect(isShown(zoomed, 2)).toBe(false);
    // The grid underneath is untouched.
    expect(grid(zoomed)).toBe('[1|2]');
    expect(workspaceReducer(zoomed, { type: 'zoom', key: 1 }).zoomed).toBeUndefined();
  });

  it('swaps the zoomed pane when another one is picked', () => {
    const state = play([
      open('codex', 'Codex'),
      { type: 'zoom', key: 1 },
      { type: 'focus', key: 2 },
    ]);
    expect(state.zoomed).toBe(2);
    expect(state.focused).toBe(2);
  });

  it('brings a minimized pane back zoomed when the workspace is zoomed', () => {
    const state = play([
      open('codex', 'Codex'),
      { type: 'minimize', key: 2 },
      { type: 'zoom', key: 1 },
      { type: 'focus', key: 2 },
    ]);
    expect(state.zoomed).toBe(2);
    expect(state.sessions[1]?.minimized).toBe(false);
  });

  it('does not zoom a minimized pane', () => {
    const state = play([{ type: 'minimize', key: 1 }]);
    expect(workspaceReducer(state, { type: 'zoom', key: 1 })).toBe(state);
  });
});

describe('layout', () => {
  it('takes a dragged border and evens it out on balance', () => {
    const two = play([open('codex', 'Codex')]);
    const dragged = play([{ type: 'layout', layout: resizeAt(two.layout, [], 0, 0.2) }], two);
    expect(paneRects(dragged.layout).get(1)?.width).toBeCloseTo(0.7);
    expect(paneRects(play([{ type: 'balance' }], dragged).layout).get(1)?.width).toBeCloseTo(0.5);
  });

  it('focusing the focused pane changes nothing', () => {
    const state = initialWorkspace();
    expect(workspaceReducer(state, { type: 'focus', key: 1 })).toBe(state);
    expect(workspaceReducer(EMPTY_WORKSPACE, { type: 'focus', key: 1 })).toBe(EMPTY_WORKSPACE);
  });
});

describe('keeping the workspace across launches', () => {
  const prefs = { sidebar: false, access: 'full' as const };

  it('saves what a later launch needs and restores the same workspace', () => {
    const state = play([
      open('claude', 'Claude Code', { workspace: 'abcd12' }),
      open('codex', 'Codex', { split: { near: 2, direction: 'down' } }),
      { type: 'rename', key: 1, name: 'api server' },
      { type: 'minimize', key: 3 },
      { type: 'zoom', key: 2 },
    ]);
    const saved = savedWorkspace(state, prefs);
    expect(saved).toMatchObject({
      version: 1,
      sidebar: false,
      access: 'full',
      focused: 2,
      zoomed: 2,
    });
    // Through the app and back, as plain data.
    const parsed = parseSavedWorkspace(JSON.parse(JSON.stringify(saved)));
    expect(parsed).toEqual(saved);
    const restored = restoreWorkspace(parsed as NonNullable<typeof parsed>);
    expect(restored).toEqual(state);
    // New sessions never reuse a key from the last launch.
    expect(restored?.nextKey).toBe(4);
  });

  it('starts over with nothing to restore', () => {
    expect(restoreWorkspace(savedWorkspace(EMPTY_WORKSPACE, prefs))).toBeUndefined();
  });

  it('puts every pane that is not minimized on the grid, and only those', () => {
    const saved = savedWorkspace(play([open('codex', 'Codex')]), prefs);
    // The layout lost pane 2 and holds a pane with no session.
    const broken = {
      ...saved,
      layout: {
        root: {
          kind: 'split' as const,
          direction: 'row' as const,
          children: [
            { node: { kind: 'pane' as const, key: 1 }, weight: 1 },
            { node: { kind: 'pane' as const, key: 9 }, weight: 1 },
          ],
        },
      },
      focused: 9,
    };
    const restored = restoreWorkspace(broken);
    expect(layoutShape(restored?.layout ?? EMPTY_WORKSPACE.layout)).toBe('[1|2]');
    expect(restored?.focused).toBe(1);
  });

  it('lays the grid out again when a pane is listed twice, and drops repeated sessions', () => {
    const saved = savedWorkspace(play([open('codex', 'Codex')]), prefs);
    const restored = restoreWorkspace({
      ...saved,
      sessions: [...saved.sessions, { ...saved.sessions[0]!, name: 'copy' }],
      layout: {
        root: {
          kind: 'split',
          direction: 'row',
          children: [
            { node: { kind: 'pane', key: 1 }, weight: 1 },
            { node: { kind: 'pane', key: 1 }, weight: 1 },
          ],
        },
      },
      zoomed: 5,
    });
    expect(names(restored ?? EMPTY_WORKSPACE)).toEqual(['Shell', 'Codex']);
    expect(layoutShape(restored?.layout ?? EMPTY_WORKSPACE.layout)).toBe('[1|2]');
    expect(restored?.zoomed).toBeUndefined();
  });

  it('ignores anything that is not a saved workspace', () => {
    const good = savedWorkspace(initialWorkspace(), prefs);
    for (const value of [
      undefined,
      null,
      'x',
      { ...good, version: 2 },
      { ...good, access: 'root' },
      { ...good, sessions: [{ ...good.sessions[0], kind: 'rm -rf /' }] },
      { ...good, sessions: [{ ...good.sessions[0], workspace: '../etc' }] },
      { ...good, sessions: [{ ...good.sessions[0], name: '' }] },
    ]) {
      expect(parseSavedWorkspace(value)).toBeUndefined();
    }
  });
});
