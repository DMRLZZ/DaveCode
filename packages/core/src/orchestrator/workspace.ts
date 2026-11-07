/**
 * Git workspace for the pane orchestrator. Every task gets its own worktree on
 * `davecode/run-<runId>-<taskId>`; finished tasks are merged into `davecode/run-<runId>` inside
 * a separate integration worktree, so the user's working tree is only touched by `apply`.
 * Nothing is ever pushed, and branches survive `cleanup` so no agent work is lost.
 */
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { assertSafeRef, Git, GitError } from '../autonomous/git';
import type { OrchestratorWorkspace, TaskWorkspace, WorkspaceResult } from './contract';

export interface GitWorkspaceOptions {
  /** Absolute project root (a git repository). */
  projectDir: string;
  /** Worktrees live under `<worktreesDir>/<runId>/<taskId>`, outside the project. */
  worktreesDir: string;
  /** Environment for git (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const INTEGRATION_DIR = 'integration';
const BRAIN_DIR = '.davecode';
const FALLBACK_IDENTITY = ['-c', 'user.name=DaveCode', '-c', 'user.email=davecode@localhost'];

function assertId(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) {
    throw new GitError(`Invalid ${kind}: ${JSON.stringify(value)}`, [], null, '');
  }
  return value;
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0);
}

/** NUL-separated `--name-only -z` output. */
function nulList(out: string): string[] {
  return out.split('\0').filter((f) => f.length > 0);
}

function errMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

/** The canonical spelling of an existing path (macOS /private/var, Windows 8.3 names). */
function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  const na = realPath(a);
  const nb = realPath(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(realPath(parent), realPath(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function createGitWorkspace(options: GitWorkspaceOptions): OrchestratorWorkspace {
  const projectDir = path.resolve(options.projectDir);
  const worktreesDir = path.resolve(options.worktreesDir);
  const gitAt = (cwd: string) => new Git(cwd, { env: options.env });
  const repo = gitAt(projectDir);

  const runDir = (runId: string) => path.join(worktreesDir, assertId('run id', runId));
  const integrationPath = (runId: string) => path.join(runDir(runId), INTEGRATION_DIR);
  const integrationBranch = (runId: string) => `davecode/run-${assertId('run id', runId)}`;
  /** Commit each task worktree started from, so agent-made commits are still reported. */
  const taskBases = new Map<string, string>();

  // Worktree creation, merges and removal all touch shared repository state; run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  let hasIdentity = false;
  /** `-c user.*` overrides, only when git has no usable identity of its own. */
  async function identityArgs(g: Git): Promise<string[]> {
    if (hasIdentity) return [];
    try {
      // Strict, like `git commit`: fails when no name/email is configured or in the environment.
      await g.run(['var', 'GIT_AUTHOR_IDENT']);
      await g.run(['var', 'GIT_COMMITTER_IDENT']);
      hasIdentity = true;
      return [];
    } catch {
      return FALLBACK_IDENTITY;
    }
  }

  async function removeWorktree(target: string): Promise<void> {
    try {
      await repo.run(['worktree', 'remove', '--force', target]);
    } catch {
      // not a registered worktree, or already gone
    }
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    try {
      await repo.run(['worktree', 'prune']);
    } catch {
      // nothing to prune
    }
  }

  /** `git worktree add -B`: creates the branch, or resets it if a previous attempt left it. */
  async function addWorktree(target: string, branch: string, base: string): Promise<void> {
    const args = ['worktree', 'add', '-B', assertSafeRef(branch), target, assertSafeRef(base)];
    try {
      await repo.run(args);
    } catch {
      // A previous attempt left the directory or its registration behind.
      await removeWorktree(target);
      await repo.run(args);
    }
  }

  /** Merges `branch` into the checkout at `g`; on failure aborts and names the conflicts. */
  async function merge(g: Git, branch: string, message: string, noVerify: boolean) {
    const args = [...(await identityArgs(g)), 'merge', '--no-ff', '--no-edit', '-m', message];
    if (noVerify) args.push('--no-verify');
    args.push(assertSafeRef(branch));
    try {
      await g.run(args);
      return { ok: true } as const;
    } catch (err) {
      let conflicts: string[] = [];
      try {
        conflicts = nulList(await g.run(['diff', '--name-only', '-z', '--diff-filter=U']));
      } catch {
        // no merge state to inspect
      }
      await g.abortMerge();
      const reason =
        conflicts.length > 0
          ? `Conflicts in ${conflicts.join(', ')}`
          : `Merge failed: ${errMessage(err)}`;
      return { ok: false, reason } as const;
    }
  }

  return {
    async check() {
      if (!(await repo.isRepo())) {
        return {
          ok: false,
          reason:
            'This folder is not a git repository. Run `git init` and commit once to orchestrate agents.',
        };
      }
      let commit: string;
      try {
        commit = (await repo.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
      } catch {
        return {
          ok: false,
          reason: 'This repository has no commits yet. Commit once to orchestrate agents.',
        };
      }
      let branch: string;
      try {
        branch = (await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
      } catch {
        return {
          ok: false,
          reason: 'HEAD is detached. Check out a branch to orchestrate agents.',
        };
      }
      return { ok: true, branch, commit };
    },

    createIntegration(runId, baseCommit) {
      return serial(async () => {
        const branch = integrationBranch(runId);
        await addWorktree(integrationPath(runId), branch, baseCommit);
        return branch;
      });
    },

    createTask(runId, taskId, base) {
      return serial(async (): Promise<TaskWorkspace> => {
        assertId('task id', taskId);
        if (taskId === INTEGRATION_DIR) {
          throw new GitError(`Invalid task id: ${JSON.stringify(taskId)}`, [], null, '');
        }
        const branch = `${integrationBranch(runId)}-${taskId}`;
        const target = path.join(runDir(runId), taskId);
        const baseCommit = (
          await repo.run(['rev-parse', '--verify', '--quiet', `${assertSafeRef(base)}^{commit}`])
        ).trim();
        await addWorktree(target, branch, baseCommit);
        taskBases.set(path.resolve(target), baseCommit);
        return { path: target, branch };
      });
    },

    commitTask(workspace, message) {
      return serial(async () => {
        const g = gitAt(workspace.path);
        await g.run(['add', '-A']);
        // The project brain belongs to the user's checkout, never to a task commit.
        await g.run(['reset', '-q', '--', BRAIN_DIR]);
        const committed = await g.hasStagedChanges();
        if (committed) {
          await g.run([
            ...(await identityArgs(g)),
            'commit',
            '--quiet',
            '--no-verify',
            '-m',
            message,
          ]);
        }
        // Diffing from the recorded base also reports commits the agent made itself. Without
        // one, only the commit just made is reported.
        const base = taskBases.get(path.resolve(workspace.path));
        if (base) return nulList(await g.run(['diff', '--name-only', '-z', base, 'HEAD']));
        if (!committed) return [];
        return nulList(await g.run(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']));
      });
    },

    mergeIntoIntegration(runId, branch, message) {
      return serial(async (): Promise<WorkspaceResult> => {
        const target = integrationPath(runId);
        if (!existsSync(target)) {
          return { ok: false, reason: `The integration worktree for run ${runId} is missing` };
        }
        // DaveCode-internal merge: the project's hooks need a full install the worktree lacks.
        return merge(gitAt(target), branch, message, true);
      });
    },

    apply(runId, baseBranch) {
      return serial(async (): Promise<WorkspaceResult> => {
        const branch = integrationBranch(runId);
        if (!(await repo.branchExists(branch))) {
          return { ok: false, reason: `Branch ${branch} does not exist` };
        }
        let current: string;
        try {
          current = (await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
        } catch {
          current = 'a detached HEAD';
        }
        if (current !== baseBranch) {
          return {
            ok: false,
            reason: `Check out ${baseBranch} first: the run started there (you are on ${current}).`,
          };
        }
        const dirty = lines(
          await repo.run(['status', '--porcelain', '--untracked-files=no']),
        ).filter((l) => {
          const file = l.slice(3).replace(/^"|"$/g, '');
          return !(file === BRAIN_DIR || file.startsWith(`${BRAIN_DIR}/`));
        });
        if (dirty.length > 0) {
          return { ok: false, reason: 'Commit or stash your changes first.' };
        }
        return merge(repo, branch, `davecode: apply run ${runId}`, false);
      });
    },

    cleanup(runId) {
      return serial(async () => {
        let dir: string;
        try {
          dir = runDir(runId);
        } catch {
          return;
        }
        try {
          const listed = lines(await repo.run(['worktree', 'list', '--porcelain']))
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length))
            .filter((p) => isInside(p, dir) && !samePath(p, projectDir));
          for (const target of listed) {
            try {
              await repo.run(['worktree', 'remove', '--force', target]);
            } catch {
              // already gone; prune below
            }
            taskBases.delete(path.resolve(target));
          }
        } catch {
          // not a repository any more: still remove the directory
        }
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          // best effort
        }
        // Prune after deleting the folder: a worktree git listed under another spelling of the
        // path (macOS /private/var, Windows 8.3 names) was not removed above and is stale now.
        try {
          await repo.run(['worktree', 'prune']);
        } catch {
          // ignore
        }
      });
    },
  };
}
