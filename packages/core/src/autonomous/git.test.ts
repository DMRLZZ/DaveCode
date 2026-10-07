import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeRef, Git, GitError } from './git';
import { createTempRepo, git, writeFiles } from './test-helpers';

let repo: ReturnType<typeof createTempRepo>;
let g: Git;

beforeEach(() => {
  repo = createTempRepo({ '.davecode/STATE.md': '# state\n' });
  g = new Git(repo.root);
});

afterEach(() => repo.cleanup());

describe('Git', () => {
  it('reports branch and cleanliness, ignoring the brain when asked', async () => {
    expect(await g.isRepo()).toBe(true);
    expect(await g.currentBranch()).toBe('main');
    expect(await g.isClean()).toBe(true);
    writeFiles(repo.root, { '.davecode/STATE.md': '# changed\n' });
    expect(await g.isClean()).toBe(false);
    expect(await g.isClean({ ignoreBrain: true })).toBe(true);
    writeFiles(repo.root, { 'src/new.ts': 'export {};\n' });
    expect(await g.isClean({ ignoreBrain: true })).toBe(false);
  });

  it('creates a task branch, commits without the brain, merges --no-ff and deletes it', async () => {
    await g.createBranch('davecode/task-a', 'main');
    expect(await g.currentBranch()).toBe('davecode/task-a');
    writeFiles(repo.root, { 'src/a.ts': 'export const a = 1;\n', '.davecode/STATE.md': '# x\n' });
    expect(await g.commitAll('feat: add a')).toBe(true);
    expect(await g.commitAll('feat: nothing')).toBe(false);
    // The brain change stays uncommitted and survives checkouts.
    expect(git(repo.root, 'status', '--porcelain')).toContain('.davecode/STATE.md');

    expect(await g.diffStat('main...davecode/task-a')).toContain('src/a.ts');
    expect(await g.diff('main...davecode/task-a')).toContain('+export const a = 1;');

    await g.checkout('main');
    await g.mergeNoFf('davecode/task-a', 'Merge davecode/task-a');
    await g.deleteBranch('davecode/task-a');
    expect(await g.branchExists('davecode/task-a')).toBe(false);
    expect(readFileSync(join(repo.root, 'src/a.ts'), 'utf8')).toContain('a = 1');
    // --no-ff leaves a merge commit with two parents.
    expect(git(repo.root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);

    expect(await g.commitBrain('chore(davecode): update brain')).toBe(true);
    expect(await g.isClean()).toBe(true);
    expect(await g.commitBrain('chore(davecode): again')).toBe(false);
  });

  it('aborts a conflicting merge and restores the base branch', async () => {
    await g.createBranch('davecode/task-b', 'main');
    writeFiles(repo.root, { 'README.md': 'branch\n' });
    await g.commitAll('feat: branch change');
    await g.checkout('main');
    writeFiles(repo.root, { 'README.md': 'main\n' });
    await g.commitAll('feat: main change');
    await expect(g.mergeNoFf('davecode/task-b', 'merge')).rejects.toBeInstanceOf(GitError);
    expect(await g.isClean()).toBe(true);
    await g.restore('main');
    expect(await g.currentBranch()).toBe('main');
    expect(await g.branchExists('davecode/task-b')).toBe(true);
  });

  it('discards uncommitted work outside the brain', async () => {
    writeFiles(repo.root, { 'junk.txt': 'x', 'README.md': 'dirty\n', '.davecode/STATE.md': 'k\n' });
    await g.discardChanges();
    expect(await g.isClean({ ignoreBrain: true })).toBe(true);
    expect(readFileSync(join(repo.root, '.davecode/STATE.md'), 'utf8')).toBe('k\n');
  });

  it('falls back when there is no remote for pull requests', async () => {
    const result = await g.openPullRequest({
      branch: 'main',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(result.outcome).toBe('unavailable');
  });

  it('rejects unsafe ref names', () => {
    expect(() => assertSafeRef('--force')).toThrow(GitError);
    expect(() => assertSafeRef('a..b')).toThrow(GitError);
    expect(() => assertSafeRef('a b')).toThrow(GitError);
    expect(assertSafeRef('davecode/task-x.1')).toBe('davecode/task-x.1');
  });
});
