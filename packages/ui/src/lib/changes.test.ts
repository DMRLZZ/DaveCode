import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  canShip,
  changedFileCount,
  createWorkspace,
  defaultShipAction,
  fetchDiff,
  lineCounts,
  listWorkspaces,
  parsePatch,
  removeWorkspace,
  shipActions,
  shipRequest,
  shortBranch,
} from './changes';
import type { ChangesWorkspace } from './types';

function workspace(overrides: Partial<ChangesWorkspace> = {}): ChangesWorkspace {
  return {
    id: 'main',
    label: 'project',
    isolated: false,
    path: '/p',
    branch: 'main',
    files: [{ path: 'a.ts', status: 'modified', additions: 2, deletions: 1, binary: false }],
    additions: 2,
    deletions: 1,
    dirty: true,
    ahead: 0,
    unpushed: 0,
    hasRemote: true,
    ...overrides,
  };
}

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@ export function a() {
 const keep = 1;
-const old = 2;
+const now = 3;
 const tail = 4;
diff --git a/old name.ts b/new name.ts
similarity index 90%
rename from old name.ts
rename to new name.ts
diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
diff --git a/n.txt b/n.txt
new file mode 100644
--- /dev/null
+++ b/n.txt
@@ -0,0 +1 @@
+one
\\ No newline at end of file
`;

describe('parsePatch', () => {
  const files = parsePatch(PATCH);

  it('splits files and keeps paths with spaces', () => {
    expect(files.map((f) => [f.path, f.oldPath, f.binary])).toEqual([
      ['src/a.ts', undefined, false],
      ['new name.ts', 'old name.ts', false],
      ['img.png', undefined, true],
      ['n.txt', undefined, false],
    ]);
  });

  it('numbers context, removed and added lines', () => {
    const [hunk] = files[0]?.hunks ?? [];
    expect(hunk?.header).toBe('@@ -1,3 +1,3 @@ export function a() {');
    expect(hunk?.lines).toEqual([
      { kind: 'ctx', text: 'const keep = 1;', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'const old = 2;', oldNo: 2 },
      { kind: 'add', text: 'const now = 3;', newNo: 2 },
      { kind: 'ctx', text: 'const tail = 4;', oldNo: 3, newNo: 3 },
    ]);
  });

  it('keeps git notes and ignores the trailing newline', () => {
    expect(files[3]?.hunks[0]?.lines).toEqual([
      { kind: 'add', text: 'one', newNo: 1 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('is empty for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('ship helpers', () => {
  const text = { message: 'fix: a', title: 'Fix a', body: 'Body', draft: true };

  it('offers push and PR only with a remote', () => {
    expect(shipActions(workspace())).toEqual(['commit', 'commit_push', 'commit_push_pr']);
    expect(shipActions(workspace({ hasRemote: false }))).toEqual(['commit']);
    expect(defaultShipAction(workspace({ hasRemote: false }))).toBe('commit');
    expect(defaultShipAction(workspace())).toBe('commit_push_pr');
  });

  it('builds the request for each action', () => {
    expect(shipRequest('commit', text, true)).toEqual({ message: 'fix: a' });
    expect(shipRequest('commit_push', text, true)).toEqual({ message: 'fix: a', push: true });
    expect(shipRequest('commit_push_pr', text, true)).toEqual({
      message: 'fix: a',
      push: true,
      pr: { title: 'Fix a', body: 'Body', draft: true },
    });
    // Nothing to commit: only push and the PR remain; an empty title falls back to the message.
    expect(shipRequest('commit_push_pr', { ...text, title: ' ' }, false)).toEqual({
      push: true,
      pr: { title: 'fix: a', body: 'Body', draft: true },
    });
  });

  it('enables the button only when the click would do something', () => {
    expect(canShip(workspace(), 'commit', 'fix: a', '')).toBe(true);
    expect(canShip(workspace(), 'commit', ' ', '')).toBe(false);
    expect(canShip(workspace({ dirty: false, files: [] }), 'commit', 'x', '')).toBe(false);
    expect(canShip(workspace({ dirty: false, unpushed: 2 }), 'commit_push', '', '')).toBe(true);
    expect(canShip(workspace({ dirty: false, unpushed: 0 }), 'commit_push', '', '')).toBe(false);
    expect(canShip(workspace({ dirty: false }), 'commit_push_pr', '', 'Title')).toBe(true);
    expect(canShip(workspace({ dirty: false }), 'commit_push_pr', '', '')).toBe(false);
  });

  it('formats counts and branches', () => {
    expect(lineCounts(workspace())).toBe('+2 −1');
    expect(lineCounts(workspace({ files: [] }))).toBe('');
    expect(shortBranch('davecode/pane-ab12cd')).toBe('pane-ab12cd');
    expect(shortBranch('feature/x')).toBe('feature/x');
    expect(shortBranch(undefined)).toBe('detached');
    expect(changedFileCount([workspace(), workspace({ id: 'x' })])).toBe(2);
    expect(changedFileCount(null)).toBe(0);
  });
});

describe('HTTP', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(status: number, body: unknown) {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('lists workspaces, or null when the gateway has no changes review', async () => {
    stub(200, { workspaces: [workspace()] });
    expect(await listWorkspaces('http://g/', 't')).toHaveLength(1);
    stub(404, { error: { code: 'not_found', message: 'nope' } });
    expect(await listWorkspaces('http://g', 't')).toBeNull();
  });

  it('surfaces other refusals with the gateway message', async () => {
    stub(409, {
      error: { code: 'not_a_repository', message: 'This folder is not a git repository.' },
    });
    await expect(listWorkspaces('http://g', 't')).rejects.toMatchObject({
      code: 'not_a_repository',
      message: 'This folder is not a git repository.',
    });
  });

  it('sends JSON with the token on state changes', async () => {
    const fetchMock = stub(201, workspace({ id: 'ab12cd', isolated: true }));
    await createWorkspace('http://g', 'tok', 'Codex');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://g/api/changes/workspaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'Codex' }),
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('encodes file paths and the delete flag', async () => {
    const fetchMock = stub(200, { patch: '', truncated: false });
    await fetchDiff('http://g', '', 'main', 'a dir/x&y.ts');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://g/api/changes/workspaces/main/diff?path=a%20dir%2Fx%26y.ts',
    );
    const del = stub(204, undefined);
    await removeWorkspace('http://g', '', 'ab12cd', true);
    expect(del.mock.calls[0]?.[0]).toBe('http://g/api/changes/workspaces/ab12cd?deleteBranch=true');
  });

  it('rejects malformed responses', async () => {
    stub(200, { workspaces: [{ id: 1 }] });
    await expect(listWorkspaces('http://g', '')).rejects.toBeInstanceOf(ApiError);
  });
});
