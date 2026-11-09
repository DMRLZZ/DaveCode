import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo, git, writeFiles } from '../autonomous/test-helpers';
import type { AgentRunner } from '../orchestrator/contract';
import type { ChangesError, ChangesService } from './contract';
import { createChangesService, paneWorkspacePath, paneWorktreesDir } from './service';

let repo: ReturnType<typeof createTempRepo>;
let home: string;
let service: ChangesService;
let gh: ReturnType<typeof vi.fn<(cwd: string, args: string[]) => Promise<string>>>;

beforeEach(() => {
  repo = createTempRepo({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
  });
  home = mkdtempSync(path.join(tmpdir(), 'davecode changes-'));
  gh = vi.fn(async () => 'https://github.com/o/r/pull/7');
  service = createChangesService({ projectDir: repo.root, home, runGh: gh });
});

afterEach(() => {
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repo.root, windowsHide: true });
  } catch {
    // ignore
  }
  repo.cleanup();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A bare repository as `origin`, with `main` pushed. */
function addOrigin(): string {
  const bare = mkdtempSync(path.join(tmpdir(), 'davecode-origin-'));
  git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
  git(repo.root, 'remote', 'add', 'origin', bare);
  git(repo.root, 'push', '--quiet', '-u', 'origin', 'main');
  return bare;
}

async function expectCode(promise: Promise<unknown>, code: ChangesError['code']) {
  await expect(promise).rejects.toMatchObject({ name: 'ChangesError', code });
}

describe('status of the project checkout', () => {
  it('is clean right after a commit', async () => {
    const [main] = await service.list();
    expect(main).toMatchObject({
      id: 'main',
      isolated: false,
      branch: 'main',
      files: [],
      dirty: false,
      ahead: 0,
      unpushed: 0,
      hasRemote: false,
    });
  });

  it('lists modified, deleted, renamed and untracked files with line counts', async () => {
    writeFiles(repo.root, {
      'src/a.ts': 'export const a = 2;\nexport const c = 3;\n',
      'new.txt': 'x\ny\n',
    });
    unlinkSync(path.join(repo.root, 'src', 'b.ts'));
    const main = await service.get('main');
    expect(main.files).toEqual([
      { path: 'new.txt', status: 'untracked', additions: 2, deletions: 0, binary: false },
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'src/b.ts', status: 'deleted', additions: 0, deletions: 1, binary: false },
    ]);
    expect(main).toMatchObject({ dirty: true, additions: 4, deletions: 2 });
  });

  it('returns the patch, untracked files included, and one file on request', async () => {
    writeFiles(repo.root, { 'src/a.ts': 'export const a = 2;\n', 'new.txt': 'hello\n' });
    const all = await service.diff('main');
    expect(all.truncated).toBe(false);
    expect(all.patch).toContain('-export const a = 1;');
    expect(all.patch).toContain('+export const a = 2;');
    expect(all.patch).toContain('+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello');
    const one = await service.diff('main', 'new.txt');
    expect(one.patch).not.toContain('src/a.ts');
    await expectCode(service.diff('main', 'src/b.ts'), 'not_found');
  });

  it('refuses a folder that is not a repository', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'davecode-plain-'));
    try {
      await expectCode(
        createChangesService({ projectDir: plain, home }).list(),
        'not_a_repository',
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('isolated workspaces', () => {
  it('creates a worktree on its own branch outside the repository', async () => {
    const ws = await service.create({ label: 'Claude Code' });
    expect(ws).toMatchObject({
      label: 'Claude Code',
      isolated: true,
      baseBranch: 'main',
      files: [],
    });
    expect(ws.branch).toBe(`davecode/pane-${ws.id}`);
    expect(ws.path).toBe(paneWorkspacePath(home, repo.root, ws.id));
    expect(ws.path.startsWith(paneWorktreesDir(home, repo.root))).toBe(true);
    expect(readFileSync(path.join(ws.path, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect((await service.list()).map((w) => w.id)).toEqual(['main', ws.id]);
  });

  it('reports committed and uncommitted work since it left its base', async () => {
    const ws = await service.create({ label: 'Codex' });
    writeFiles(ws.path, { 'src/a.ts': 'export const a = 9;\n' });
    git(ws.path, 'commit', '--quiet', '-am', 'feat: nine');
    writeFiles(ws.path, { 'extra.ts': 'export {};\n' });
    const state = await service.get(ws.id);
    expect(state.files.map((f) => [f.path, f.status])).toEqual([
      ['extra.ts', 'untracked'],
      ['src/a.ts', 'modified'],
    ]);
    expect(state).toMatchObject({ ahead: 1, unpushed: 1, dirty: true });
    // The checkout itself is untouched.
    expect((await service.get('main')).files).toEqual([]);
  });

  it('merges into the checkout, committing pending work when given a message', async () => {
    const ws = await service.create({ label: 'Codex' });
    writeFiles(ws.path, { 'src/a.ts': 'export const a = 5;\n' });
    await expectCode(service.merge(ws.id), 'dirty');
    const main = await service.merge(ws.id, { message: 'feat: five' });
    expect(main.id).toBe('main');
    expect(readFileSync(path.join(repo.root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 5;\n');
    expect(git(repo.root, 'log', '-1', '--pretty=%s')).toBe(
      `Merge Codex (davecode/pane-${ws.id}) into main`,
    );
    await expectCode(service.merge(ws.id), 'nothing_to_commit');
  });

  it('aborts a conflicting merge and names the files', async () => {
    const ws = await service.create();
    writeFiles(ws.path, { 'src/a.ts': 'export const a = "pane";\n' });
    writeFiles(repo.root, { 'src/a.ts': 'export const a = "main";\n' });
    git(repo.root, 'commit', '--quiet', '-am', 'main change');
    await expect(service.merge(ws.id, { message: 'pane change' })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('src/a.ts'),
    });
    expect(git(repo.root, 'status', '--porcelain')).toBe('');
  });

  it('removes the worktree and keeps the branch unless told otherwise', async () => {
    const kept = await service.create();
    await service.remove(kept.id);
    expect(existsSync(kept.path)).toBe(false);
    expect(git(repo.root, 'branch', '--list', `davecode/pane-${kept.id}`)).not.toBe('');
    const gone = await service.create();
    await service.remove(gone.id, { deleteBranch: true });
    expect(git(repo.root, 'branch', '--list', `davecode/pane-${gone.id}`)).toBe('');
    expect((await service.list()).map((w) => w.id)).toEqual(['main']);
    await expectCode(service.get(gone.id), 'not_found');
    await expectCode(service.remove('main'), 'invalid');
  });

  it('rejects ids that could escape the panes folder', async () => {
    await expectCode(service.get('../etc'), 'not_found');
    expect(paneWorkspacePath(home, repo.root, '../x')).toBeUndefined();
  });
});

describe('ship', () => {
  it('commits in the checkout', async () => {
    writeFiles(repo.root, { 'src/a.ts': 'export const a = 3;\n' });
    const result = await service.ship('main', { message: 'fix: three' });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.phase)).toEqual(['commit']);
    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.workspace.dirty).toBe(false);
    expect(git(repo.root, 'log', '-1', '--pretty=%s')).toBe('fix: three');
    await expectCode(service.ship('main', { message: 'again' }), 'nothing_to_commit');
  });

  it('opens a pull request from the default branch on a new branch', async () => {
    const bare = addOrigin();
    try {
      writeFiles(repo.root, { 'src/a.ts': 'export const a = 4;\n' });
      const result = await service.ship('main', {
        message: 'feat: four',
        pr: { title: 'feat: make a four', body: 'Body', draft: true },
      });
      expect(result.steps.map((s) => [s.phase, s.ok])).toEqual([
        ['branch', true],
        ['commit', true],
        ['push', true],
        ['pr', true],
      ]);
      expect(result).toMatchObject({
        ok: true,
        branch: 'davecode/make-a-four',
        prUrl: 'https://github.com/o/r/pull/7',
      });
      expect(git(bare, 'branch', '--list', 'davecode/make-a-four')).not.toBe('');
      expect(gh).toHaveBeenCalledWith(repo.root, [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        'davecode/make-a-four',
        '--title',
        'feat: make a four',
        '--body',
        'Body',
        '--draft',
      ]);
      expect(result.workspace).toMatchObject({
        upstream: 'origin/davecode/make-a-four',
        unpushed: 0,
      });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('names a pane branch after its pull request and targets the pane base', async () => {
    const bare = addOrigin();
    try {
      const ws = await service.create({ label: 'Claude Code' });
      writeFiles(ws.path, { 'src/b.ts': 'export const b = 2;\n' });
      const result = await service.ship(ws.id, {
        message: 'feat: b two',
        pr: { title: 'Make b two' },
      });
      expect(result.ok).toBe(true);
      expect(result.steps[0]).toMatchObject({ phase: 'branch', ok: true });
      expect(result.branch).toBe('davecode/make-b-two');
      expect(gh.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([
          '--base',
          'main',
          '--head',
          'davecode/make-b-two',
          '--body',
          'Make b two',
        ]),
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('reuses an existing pull request', async () => {
    const bare = addOrigin();
    gh.mockRejectedValueOnce(new Error('a pull request for branch "x" already exists'));
    gh.mockResolvedValueOnce('https://github.com/o/r/pull/3');
    try {
      writeFiles(repo.root, { 'src/a.ts': 'export const a = 8;\n' });
      const result = await service.ship('main', { message: 'feat: eight', pr: { title: 'Eight' } });
      expect(result).toMatchObject({ ok: true, prUrl: 'https://github.com/o/r/pull/3' });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('stops at a failed step and reports it without throwing', async () => {
    writeFiles(repo.root, { 'src/a.ts': 'export const a = 6;\n' });
    const result = await service.ship('main', { message: 'feat: six', push: true });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({ phase: 'commit', ok: true }),
      { phase: 'push', ok: false, detail: 'This repository has no "origin" remote.' },
    ]);
  });

  it('validates the request', async () => {
    await expectCode(service.ship('main', {}), 'invalid');
    expect(() => service.ship('main', { pr: { title: '' } })).toThrow();
  });
});

describe('suggest', () => {
  it('derives a message from the files without an agent', async () => {
    writeFiles(repo.root, { 'docs/x.md': '# x\n' });
    expect(await service.suggest('main')).toMatchObject({
      message: 'docs: add x.md',
      by: 'davecode',
    });
  });

  it('asks the chosen agent in read-only mode, with the patch', async () => {
    const run = vi.fn<AgentRunner['run']>(async () => ({
      ok: true,
      text: '{"message":"feat: greet","title":"Greet people","body":"Adds a greeting."}',
    }));
    const writer: AgentRunner = { availability: async () => [], run };
    const withAgent = createChangesService({ projectDir: repo.root, home, writer });
    writeFiles(repo.root, { 'src/hello.ts': 'export const hi = "hi";\n' });
    const suggestion = await withAgent.suggest('main', { agent: 'claude' });
    expect(suggestion).toEqual({
      message: 'feat: greet',
      title: 'Greet people',
      body: 'Adds a greeting.',
      by: 'claude',
    });
    const request = run.mock.calls[0]?.[0];
    expect(request).toMatchObject({ agent: 'claude', mode: 'plan', cwd: repo.root });
    expect(request?.prompt).toContain('+export const hi = "hi";');
  });

  it('reports an agent that did not answer properly', async () => {
    const writer: AgentRunner = {
      availability: async () => [],
      run: async () => ({ ok: true, text: 'no' }),
    };
    const withAgent = createChangesService({ projectDir: repo.root, home, writer });
    writeFiles(repo.root, { 'a.txt': 'a\n' });
    await expectCode(withAgent.suggest('main', { agent: 'codex' }), 'unavailable');
    await expectCode(service.suggest('main', { agent: 'codex' }), 'unavailable');
  });

  it('has nothing to say about a clean tree', async () => {
    await expectCode(service.suggest('main'), 'nothing_to_commit');
  });
});

describe('creation limits', () => {
  it('refuses a repository without commits', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'davecode-empty-'));
    try {
      git(empty, 'init', '--quiet');
      writeFileSync(path.join(empty, 'a'), 'a');
      await expectCode(
        createChangesService({ projectDir: empty, home }).create(),
        'not_a_repository',
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
