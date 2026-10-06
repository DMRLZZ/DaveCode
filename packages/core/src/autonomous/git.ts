/**
 * Minimal git wrapper for the autonomous runner. Every call is `execFile('git', args)`: no
 * shell, arguments passed verbatim. The wrapper never force-pushes and never rewrites history
 * on the base branch.
 */
import { execFile } from 'node:child_process';
import { resolveOnPath } from '../providers/shared/cli';

/** Paths the runner owns (the project brain); excluded from task commits and dirty checks. */
export const BRAIN_DIR = '.davecode';
const BRAIN_FILES = [
  '.davecode/STATE.md',
  '.davecode/ARCHITECTURE.md',
  '.davecode/TASK_GRAPH.json',
];

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  /** git executable (default `git`). */
  binary?: string;
  /** Per-command timeout (default 120 s). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommitOptions {
  /** Skip commit hooks (used only for snapshots of failed attempts). */
  noVerify?: boolean;
  /** Allow a commit with no changes. */
  allowEmpty?: boolean;
}

export interface PullRequestResult {
  /** `pr`: pushed and opened with gh. `unavailable`: gh/remote missing, caller should merge. */
  outcome: 'pr' | 'unavailable';
  url?: string;
  reason?: string;
}

const SAFE_REF = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$/;

/** Rejects ref names git would refuse or that could be mistaken for options. */
export function assertSafeRef(name: string): string {
  if (!SAFE_REF.test(name) || name.startsWith('-')) {
    throw new GitError(`Unsafe git ref name: ${JSON.stringify(name)}`, [], null, '');
  }
  return name;
}

export class Git {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly cwd: string,
    opts: GitOptions = {},
  ) {
    this.env = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0' };
    this.binary = resolveOnPath(opts.binary ?? 'git', this.env);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** Runs `git <args>` and returns stdout. Throws {@link GitError} on a non-zero exit. */
  run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          cwd: this.cwd,
          env: this.env,
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) {
            const code = typeof err.code === 'number' ? err.code : null;
            const detail = (stderr || stdout || err.message).trim().slice(0, 2000);
            reject(new GitError(`git ${args[0] ?? ''} failed: ${detail}`, args, code, stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /** True when `cwd` is inside a git work tree. */
  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Absolute path of the work tree root. */
  async topLevel(): Promise<string> {
    return (await this.run(['rev-parse', '--show-toplevel'])).trim();
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${assertSafeRef(name)}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Porcelain status entries (`XY path`). With `ignoreBrain`, changes under `.davecode/` are
   * left out: the runner and the dashboard write there continuously.
   */
  async status(opts: { ignoreBrain?: boolean } = {}): Promise<string[]> {
    const out = await this.run(['status', '--porcelain', '--untracked-files=all']);
    return out
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim().length > 0)
      .filter((l) => {
        if (!opts.ignoreBrain) return true;
        const file = l.slice(3).replace(/^"|"$/g, '');
        return !(file === BRAIN_DIR || file.startsWith(`${BRAIN_DIR}/`));
      });
  }

  async isClean(opts: { ignoreBrain?: boolean } = {}): Promise<boolean> {
    return (await this.status(opts)).length === 0;
  }

  async checkout(branch: string): Promise<void> {
    await this.run(['checkout', '--quiet', assertSafeRef(branch)]);
  }

  /** Creates `branch` from `base` and checks it out. */
  async createBranch(branch: string, base: string): Promise<void> {
    await this.run(['checkout', '--quiet', '-b', assertSafeRef(branch), assertSafeRef(base)]);
  }

  async renameBranch(from: string, to: string): Promise<void> {
    await this.run(['branch', '-m', assertSafeRef(from), assertSafeRef(to)]);
  }

  /** Deletes a fully merged branch (`-d`, never `-D`). */
  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-d', assertSafeRef(branch)]);
  }

  /** Stages every change except the project brain. */
  async stageAll(): Promise<void> {
    await this.run(['add', '--all', '--', '.', `:(exclude)${BRAIN_DIR}`]);
  }

  /** True when the index differs from HEAD. */
  async hasStagedChanges(): Promise<boolean> {
    try {
      await this.run(['diff', '--cached', '--quiet']);
      return false;
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return true;
      throw err;
    }
  }

  /** Stages everything (brain excluded) and commits. Returns false when there was nothing. */
  async commitAll(message: string, opts: CommitOptions = {}): Promise<boolean> {
    await this.stageAll();
    if (!opts.allowEmpty && !(await this.hasStagedChanges())) return false;
    const args = ['commit', '--quiet', '-m', message];
    if (opts.noVerify) args.push('--no-verify');
    if (opts.allowEmpty) args.push('--allow-empty');
    await this.run(args);
    return true;
  }

  /**
   * Commits pending STATE.md / ARCHITECTURE.md / TASK_GRAPH.json changes on the current branch.
   * Ignored or untracked-and-ignored brain files are skipped. Returns false when nothing changed.
   */
  async commitBrain(message: string): Promise<boolean> {
    const out = await this.run(['status', '--porcelain', '--', ...BRAIN_FILES]);
    const changed = out
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim().length > 0)
      .map((l) => l.slice(3).replace(/^"|"$/g, ''))
      .filter((f) => BRAIN_FILES.includes(f));
    if (changed.length === 0) return false;
    await this.run(['add', '--', ...changed]);
    if (!(await this.hasStagedChanges())) return false;
    await this.run(['commit', '--quiet', '-m', message, '--', ...changed]);
    return true;
  }

  /** `git merge --no-ff` of `branch` into the current branch; aborts the merge on conflict. */
  async mergeNoFf(branch: string, message: string): Promise<void> {
    try {
      await this.run(['merge', '--no-ff', '--no-edit', '-m', message, assertSafeRef(branch)]);
    } catch (err) {
      await this.abortMerge();
      throw err;
    }
  }

  /** Aborts an in-progress merge, if any. */
  async abortMerge(): Promise<void> {
    try {
      await this.run(['merge', '--abort']);
    } catch {
      // no merge in progress
    }
  }

  /**
   * Restores a usable state after a failure on a task branch: aborts a pending merge, then
   * checks out `base`. Uncommitted work must have been committed (or discarded) first.
   */
  async restore(base: string): Promise<void> {
    await this.abortMerge();
    if ((await this.currentBranch()) !== base) await this.checkout(base);
  }

  /** Discards uncommitted changes outside the brain (tracked and untracked). */
  async discardChanges(): Promise<void> {
    const outsideBrain = ['--', '.', `:(exclude)${BRAIN_DIR}`];
    await this.run(['reset', '--quiet', 'HEAD', ...outsideBrain]);
    await this.run(['checkout', '--quiet', ...outsideBrain]);
    await this.run(['clean', '-fd', '--quiet', ...outsideBrain]);
  }

  /** `git diff --stat` of `range` (e.g. `main...branch`) or of the index with `cached`. */
  async diffStat(range?: string, opts: { cached?: boolean } = {}): Promise<string> {
    const args = ['diff', '--stat'];
    if (opts.cached) args.push('--cached');
    if (range) args.push(range);
    args.push('--', '.', `:(exclude)${BRAIN_DIR}`);
    return (await this.run(args)).trim();
  }

  /** Full patch for `range` or the index. */
  async diff(range?: string, opts: { cached?: boolean } = {}): Promise<string> {
    const args = ['diff'];
    if (opts.cached) args.push('--cached');
    if (range) args.push(range);
    args.push('--', '.', `:(exclude)${BRAIN_DIR}`);
    return this.run(args);
  }

  async hasRemote(name = 'origin'): Promise<boolean> {
    try {
      await this.run(['remote', 'get-url', name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pushes `branch` (never with `--force`) and opens a PR with `gh`. Returns `unavailable` when
   * `gh` or the remote is missing so the caller can fall back to a local merge.
   */
  async openPullRequest(opts: {
    branch: string;
    base: string;
    title: string;
    body: string;
    gh?: string;
  }): Promise<PullRequestResult> {
    if (!(await this.hasRemote())) return { outcome: 'unavailable', reason: 'no "origin" remote' };
    const gh = resolveOnPath(opts.gh ?? 'gh', this.env);
    if (/\.(cmd|bat)$/i.test(gh)) {
      return { outcome: 'unavailable', reason: 'gh is a shell shim; refusing to pass text args' };
    }
    const runGh = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          gh,
          args,
          { cwd: this.cwd, env: this.env, timeout: this.timeoutMs, windowsHide: true },
          (err, stdout, stderr) =>
            err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim()),
        );
      });
    try {
      await runGh(['--version']);
    } catch {
      return { outcome: 'unavailable', reason: 'gh CLI not found' };
    }
    await this.run(['push', '--set-upstream', 'origin', assertSafeRef(opts.branch)]);
    const url = await runGh([
      'pr',
      'create',
      '--base',
      assertSafeRef(opts.base),
      '--head',
      assertSafeRef(opts.branch),
      '--title',
      opts.title,
      '--body',
      opts.body,
    ]);
    return { outcome: 'pr', url: url.split('\n').at(-1) ?? url };
  }
}
