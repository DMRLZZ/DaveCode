import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, git, writeFiles } from '../autonomous/test-helpers';
import type { OrchestratorWorkspace } from './contract';
import { createGitWorkspace } from './workspace';

let repo: ReturnType<typeof createTempRepo>;
let scratch: string;
let worktreesDir: string;
let ws: OrchestratorWorkspace;

/** git without the machine's global/system config, so identity fallbacks are testable. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const globalConfig = path.join(scratch, 'isolated gitconfig');
  // useConfigOnly stops git guessing an identity from the host name, as it does on macOS runners.
  writeFileSync(globalConfig, '[user]\n\tuseConfigOnly = true\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of [
    'EMAIL',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete env[key];
  }
  return env;
}

beforeEach(() => {
  repo = createTempRepo({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
  });
  scratch = mkdtempSync(path.join(tmpdir(), 'davecode orchestrator ws-'));
  worktreesDir = path.join(scratch, 'work trees');
  ws = createGitWorkspace({ projectDir: repo.root, worktreesDir, env: isolatedEnv() });
});

afterEach(async () => {
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repo.root, windowsHide: true });
  } catch {
    // ignore
  }
  repo.cleanup();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function startRun(runId: string) {
  const head = await ws.check();
  if (!head.ok) throw new Error(head.reason);
  const integration = await ws.createIntegration(runId, head.commit);
  return { ...head, integration };
}

describe('createGitWorkspace.check', () => {
  it('reports the branch and commit of HEAD', async () => {
    const res = await ws.check();
    expect(res).toEqual({ ok: true, branch: 'main', commit: git(repo.root, 'rev-parse', 'HEAD') });
  });

  it('explains a folder that is not a repository, has no commits, or a detached HEAD', async () => {
    const plain = path.join(scratch, 'plain folder');
    mkdirSync(plain);
    const notRepo = await createGitWorkspace({
      projectDir: plain,
      worktreesDir,
      env: { ...isolatedEnv(), GIT_CEILING_DIRECTORIES: scratch },
    }).check();
    expect(notRepo).toEqual({
      ok: false,
      reason:
        'This folder is not a git repository. Run `git init` and commit once to orchestrate agents.',
    });

    const empty = path.join(scratch, 'empty repo');
    mkdirSync(empty);
    git(empty, 'init', '--quiet');
    const noCommits = await createGitWorkspace({ projectDir: empty, worktreesDir }).check();
    expect(noCommits.ok).toBe(false);
    if (!noCommits.ok) expect(noCommits.reason).toContain('no commits');

    git(repo.root, 'checkout', '--quiet', '--detach');
    const detached = await ws.check();
    expect(detached.ok).toBe(false);
    if (!detached.ok) expect(detached.reason).toContain('detached');
  });
});

// Many git processes per test; Windows process start-up is slow under a loaded test run.
describe('createGitWorkspace run flow', { timeout: 40_000 }, () => {
  it('merges two tasks, reports a conflict, applies and cleans up keeping branches', async () => {
    const run = await startRun('r1');
    expect(run.integration).toBe('davecode/run-r1');
    expect(existsSync(path.join(worktreesDir, 'r1', 'integration'))).toBe(true);

    const t1 = await ws.createTask('r1', 't1', run.integration);
    const t2 = await ws.createTask('r1', 't2', run.integration);
    const t3 = await ws.createTask('r1', 't3', run.integration);
    expect(t1).toEqual({ path: path.join(worktreesDir, 'r1', 't1'), branch: 'davecode/run-r1-t1' });
    expect(readFileSync(path.join(t1.path, 'src', 'a.ts'), 'utf8')).toContain('a = 1');

    writeFiles(t1.path, {
      'src/a.ts': 'export const a = 2;\n',
      'src/new file.ts': 'export {};\n',
      '.davecode/STATE.md': '# agent scribbles\n',
    });
    writeFiles(t2.path, { 'src/b.ts': 'export const b = 2;\n' });
    writeFiles(t3.path, { 'src/a.ts': 'export const a = 3;\n' });

    expect((await ws.commitTask(t1, 'feat: t1')).sort()).toEqual(['src/a.ts', 'src/new file.ts']);
    expect(await ws.commitTask(t2, 'feat: t2')).toEqual(['src/b.ts']);
    expect(await ws.commitTask(t3, 'feat: t3')).toEqual(['src/a.ts']);
    // The brain never lands in a task commit, and the configured identity is used.
    expect(git(t1.path, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('.davecode');
    expect(git(t1.path, 'log', '-1', '--format=%an <%ae>')).toBe(
      'DaveCode Test <test@davecode.invalid>',
    );

    expect(await ws.mergeIntoIntegration('r1', t1.branch, 'merge t1')).toEqual({ ok: true });
    expect(await ws.mergeIntoIntegration('r1', t2.branch, 'merge t2')).toEqual({ ok: true });
    expect(await ws.mergeIntoIntegration('r1', t3.branch, 'merge t3')).toEqual({
      ok: false,
      reason: 'Conflicts in src/a.ts',
    });
    const integrationDir = path.join(worktreesDir, 'r1', 'integration');
    expect(git(integrationDir, 'status', '--porcelain')).toBe('');

    // The user's checkout is untouched until apply.
    expect(readFileSync(path.join(repo.root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect(await ws.apply('r1', 'main')).toEqual({ ok: true });
    expect(readFileSync(path.join(repo.root, 'src', 'a.ts'), 'utf8')).toContain('a = 2');
    expect(readFileSync(path.join(repo.root, 'src', 'b.ts'), 'utf8')).toContain('b = 2');
    expect(git(repo.root, 'log', '-1', '--format=%s')).toBe('davecode: apply run r1');

    await ws.cleanup('r1');
    expect(existsSync(path.join(worktreesDir, 'r1'))).toBe(false);
    expect(git(repo.root, 'worktree', 'list')).not.toContain('r1');
    const branches = git(repo.root, 'branch', '--format=%(refname:short)').split('\n');
    expect(branches).toEqual(
      expect.arrayContaining([
        'davecode/run-r1',
        'davecode/run-r1-t1',
        'davecode/run-r1-t2',
        'davecode/run-r1-t3',
      ]),
    );
    // Cleaning up twice, or an unknown run, never throws.
    await ws.cleanup('r1');
    await ws.cleanup('never-existed');
  });

  it('returns no files when the agent changed nothing, and reports agent-made commits', async () => {
    const run = await startRun('r2');
    const t1 = await ws.createTask('r2', 't1', run.integration);
    expect(await ws.commitTask(t1, 'feat: nothing')).toEqual([]);
    writeFiles(t1.path, { '.davecode/STATE.md': '# only the brain\n' });
    expect(await ws.commitTask(t1, 'feat: brain only')).toEqual([]);

    const t2 = await ws.createTask('r2', 't2', run.integration);
    writeFiles(t2.path, { 'c.ts': 'export {};\n' });
    git(t2.path, 'add', '-A');
    git(t2.path, 'commit', '--quiet', '-m', 'agent committed on its own');
    writeFiles(t2.path, { 'd.ts': 'export {};\n' });
    expect((await ws.commitTask(t2, 'feat: t2')).sort()).toEqual(['c.ts', 'd.ts']);
  });

  it('resets a task branch and worktree left by a previous attempt', async () => {
    const run = await startRun('r3');
    const first = await ws.createTask('r3', 't1', run.integration);
    writeFiles(first.path, { 'src/a.ts': 'export const a = 9;\n', 'junk.txt': 'x' });
    await ws.commitTask(first, 'feat: first attempt');

    const again = await ws.createTask('r3', 't1', run.integration);
    expect(again.branch).toBe(first.branch);
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(run.commit);
    expect(existsSync(path.join(again.path, 'junk.txt'))).toBe(false);
  });

  it('commits with a fallback identity only when git has none', async () => {
    git(repo.root, 'config', '--unset', 'user.name');
    git(repo.root, 'config', '--unset', 'user.email');
    const run = await startRun('r4');
    const t1 = await ws.createTask('r4', 't1', run.integration);
    writeFiles(t1.path, { 'e.ts': 'export {};\n' });
    expect(await ws.commitTask(t1, 'feat: e')).toEqual(['e.ts']);
    expect(git(t1.path, 'log', '-1', '--format=%an <%ae>')).toBe('DaveCode <davecode@localhost>');
    expect(await ws.mergeIntoIntegration('r4', t1.branch, 'merge t1')).toEqual({ ok: true });
  });

  it('refuses to apply on another branch or with a dirty tracked tree', async () => {
    const run = await startRun('r5');
    const t1 = await ws.createTask('r5', 't1', run.integration);
    writeFiles(t1.path, { 'src/b.ts': 'export const b = 5;\n' });
    await ws.commitTask(t1, 'feat: b');
    await ws.mergeIntoIntegration('r5', t1.branch, 'merge t1');

    git(repo.root, 'checkout', '--quiet', '-b', 'other');
    const wrong = await ws.apply('r5', 'main');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('Check out main first');
    git(repo.root, 'checkout', '--quiet', 'main');

    writeFiles(repo.root, { 'README.md': '# edited by the user\n' });
    expect(await ws.apply('r5', 'main')).toEqual({
      ok: false,
      reason: 'Commit or stash your changes first.',
    });
    // Untracked files do not block apply.
    git(repo.root, 'checkout', '--quiet', '--', 'README.md');
    writeFiles(repo.root, { 'notes.txt': 'scratch\n' });
    expect(await ws.apply('r5', 'main')).toEqual({ ok: true });
    expect(readFileSync(path.join(repo.root, 'src', 'b.ts'), 'utf8')).toContain('b = 5');

    expect((await ws.apply('missing', 'main')).ok).toBe(false);
  });

  it('aborts an apply that conflicts with the base branch', async () => {
    const run = await startRun('r6');
    const t1 = await ws.createTask('r6', 't1', run.integration);
    writeFiles(t1.path, { 'src/a.ts': 'export const a = 6;\n' });
    await ws.commitTask(t1, 'feat: a');
    await ws.mergeIntoIntegration('r6', t1.branch, 'merge t1');

    writeFiles(repo.root, { 'src/a.ts': 'export const a = 7;\n' });
    git(repo.root, 'commit', '--quiet', '-am', 'user change');
    expect(await ws.apply('r6', 'main')).toEqual({ ok: false, reason: 'Conflicts in src/a.ts' });
    expect(git(repo.root, 'status', '--porcelain')).toBe('');
  });

  it('rejects unsafe run and task ids', async () => {
    const run = await startRun('r7');
    await expect(ws.createTask('r7', '../escape', run.integration)).rejects.toThrow(/task id/);
    await expect(ws.createTask('r7', 'integration', run.integration)).rejects.toThrow(/task id/);
    await expect(ws.createIntegration('bad id', run.commit)).rejects.toThrow(/run id/);
    await expect(ws.createTask('r7', 't1', '--upload-pack=x')).rejects.toThrow(/Unsafe/);
  });
});
