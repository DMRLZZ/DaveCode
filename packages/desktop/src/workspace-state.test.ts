import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readWorkspaceState,
  WORKSPACE_STATE_MAX_BYTES,
  type WorkspaceState,
  workspaceStateFile,
  workspaceStateSchema,
  writeWorkspaceState,
} from './workspace-state';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'davecode-workspace-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const state = (): WorkspaceState => ({
  version: 1,
  sessions: [
    { key: 1, kind: 'shell', name: 'api server', minimized: false },
    { key: 2, kind: 'claude', name: 'Claude Code', workspace: 'abcd12', minimized: false },
    { key: 3, kind: 'codex', name: 'Codex', minimized: true },
  ],
  layout: {
    root: {
      kind: 'split',
      direction: 'row',
      children: [
        { node: { kind: 'pane', key: 1 }, weight: 1.4 },
        { node: { kind: 'pane', key: 2 }, weight: 0.6 },
      ],
    },
  },
  focused: 2,
  sidebar: true,
  access: 'edit',
});

describe('workspaceStateFile', () => {
  it('gives each project its own file under the app data folder', () => {
    const a = workspaceStateFile(dir, join(dir, 'project-a'));
    const b = workspaceStateFile(dir, join(dir, 'project-b'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/workspaces[\\/][a-f0-9]{16}\.json$/);
    expect(a.startsWith(join(dir, 'workspaces'))).toBe(true);
    // The same folder spelled twice is one project.
    expect(workspaceStateFile(dir, join(dir, 'project-a', '.'))).toBe(a);
  });
});

describe('reading and writing', () => {
  it('round-trips a state', () => {
    const file = workspaceStateFile(dir, 'project');
    expect(readWorkspaceState(file)).toBeUndefined();
    expect(writeWorkspaceState(file, state())).toBe(true);
    expect(readWorkspaceState(file)).toEqual(state());
  });

  it('writes only the fields it knows', () => {
    const file = join(dir, 'state.json');
    expect(writeWorkspaceState(file, { ...state(), typed: 'rm -rf /', token: 'secret' })).toBe(
      true,
    );
    expect(readFileSync(file, 'utf8')).not.toMatch(/secret|rm -rf/);
  });

  it('refuses what is not a workspace state and writes nothing', () => {
    const file = join(dir, 'state.json');
    const bad: unknown[] = [
      null,
      'text',
      { ...state(), version: 2 },
      { ...state(), access: 'everything' },
      { ...state(), sessions: [{ key: 1, kind: 'rm -rf /', name: 'x', minimized: false }] },
      { ...state(), sessions: [{ key: 1, kind: 'shell', name: 'x'.repeat(41), minimized: false }] },
      // An isolated workspace is an id, never a path.
      {
        ...state(),
        sessions: [{ key: 1, kind: 'shell', name: 'x', workspace: '../../etc', minimized: false }],
      },
      { ...state(), sessions: Array.from({ length: 65 }, () => state().sessions[0]) },
      { ...state(), layout: { root: { kind: 'pane', key: 0 } } },
      {
        ...state(),
        layout: { root: { kind: 'split', direction: 'diagonal', children: [] } },
      },
    ];
    for (const value of bad) expect(writeWorkspaceState(file, value)).toBe(false);
    expect(readWorkspaceState(file)).toBeUndefined();
  });

  it('refuses a layout nested deeper than any real one', () => {
    let node: unknown = { kind: 'pane', key: 1 };
    for (let i = 0; i < 20; i++) {
      node = { kind: 'split', direction: 'row', children: [{ node, weight: 1 }] };
    }
    expect(workspaceStateSchema.safeParse({ ...state(), layout: { root: node } }).success).toBe(
      false,
    );
  });

  it('ignores a corrupt or foreign file', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, '{{{');
    expect(readWorkspaceState(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ version: 1, sessions: 'nope' }));
    expect(readWorkspaceState(file)).toBeUndefined();
  });

  it('keeps the size bound far above a full workspace', () => {
    const full = {
      ...state(),
      sessions: Array.from({ length: 64 }, (_, i) => ({
        key: i + 1,
        kind: 'claude' as const,
        name: 'x'.repeat(40),
        workspace: 'a'.repeat(24),
        minimized: false,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(WORKSPACE_STATE_MAX_BYTES / 4);
    expect(writeWorkspaceState(join(dir, 'full.json'), full)).toBe(true);
  });
});
