/**
 * Changes service: isolated pane worktrees, their status and diff, and the one-click
 * commit → push → pull request flow. Every git call goes through `Git` (`execFile`, no shell);
 * `gh` is run the same way. Nothing is ever force-pushed and no history is rewritten.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertSafeRef, Git, GitError } from '../autonomous/git';
import type { AgentRunner } from '../orchestrator/contract';
import { scrubSecrets } from '../orchestrator/runners';
import { resolveOnPath } from '../providers/shared/cli';
import {
  CHANGES_LIMITS,
  type ChangedFile,
  ChangesError,
  type ChangesService,
  type ChangesSuggestion,
  type ChangesWorkspace,
  MAIN_WORKSPACE_ID,
  mergeSchema,
  PANE_BRANCH_PREFIX,
  removeSchema,
  type ShipResult,
  type ShipStep,
  shipSchema,
  suggestSchema,
  WORKSPACE_ID_PATTERN,
} from './contract';
import {
  countLines,
  looksBinary,
  mergeFileLists,
  newFilePatch,
  parseNameStatus,
  parseNumStat,
  scrubUrls,
  slugify,
} from './parse';
import { agentPrompt, fallbackSuggestion, parseAgentSuggestion } from './suggest';

/** The hash of the empty tree: the diff base of a repository without commits. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FALLBACK_IDENTITY = ['-c', 'user.name=DaveCode', '-c', 'user.email=davecode@localhost'];
/** Commit hooks and pushes can be slow; status calls use the default 2 minutes. */
const SLOW_MS = 10 * 60_000;

/**
 * Where the isolated pane worktrees of `projectDir` live: under the DaveCode home, outside the
 * repository, one folder per project (first 16 hex digits of its path's SHA-256).
 */
export function paneWorktreesDir(home: string, projectDir: string): string {
  const key = createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 16);
  return path.join(home, 'panes', key);
}

/** The worktree of pane workspace `id`, or undefined when the id is not a valid one. */
export function paneWorkspacePath(
  home: string,
  projectDir: string,
  id: string,
): string | undefined {
  if (!WORKSPACE_ID_PATTERN.test(id)) return undefined;
  return path.join(paneWorktreesDir(home, projectDir), id);
}

export interface ChangesServiceOptions {
  /** Absolute project root (the user's checkout). */
  projectDir: string;
  /** DaveCode home; isolated worktrees go under `<home>/panes/<project key>/`. */
  home: string;
  /** Environment for git and gh (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Writes commit messages from the patch. Without it only the file-list suggestion exists. */
  writer?: AgentRunner;
  /** GitHub CLI executable (default `gh`). */
  gh?: string;
  /** Runs `gh <args>` in `cwd` and returns stdout (tests). Default: the `gh` executable. */
  runGh?: (cwd: string, args: string[]) => Promise<string>;
  now?: () => Date;
}

const metaSchema = z.object({
  id: z.string().regex(WORKSPACE_ID_PATTERN),
  label: z.string(),
  baseBranch: z.string().optional(),
  baseCommit: z.string(),
  createdAt: z.string(),
});
type Meta = z.infer<typeof metaSchema>;

interface Target {
  id: string;
  label: string;
  path: string;
  isolated: boolean;
  meta?: Meta;
}

function short(err: unknown): string {
  const raw =
    err instanceof GitError
      ? err.stderr || err.message
      : err instanceof Error
        ? err.message
        : String(err);
  const text = scrubSecrets(scrubUrls(raw));
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

function nul(out: string): string[] {
  return out.split('\0').filter((f) => f.length > 0);
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function createChangesService(options: ChangesServiceOptions): ChangesService {
  const projectDir = path.resolve(options.projectDir);
  const panesDir = paneWorktreesDir(options.home, projectDir);
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const gitAt = (cwd: string, slow = false) =>
    new Git(cwd, { env, ...(slow ? { timeoutMs: SLOW_MS } : {}) });
  const repo = gitAt(projectDir);

  // Worktree creation, commits, merges and removal touch shared repository state.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const identity = new Map<string, boolean>();
  /** `-c user.*` overrides, only when git has no usable identity of its own. */
  async function identityArgs(g: Git): Promise<string[]> {
    if (identity.get(g.cwd)) return [];
    try {
      await g.run(['var', 'GIT_AUTHOR_IDENT']);
      await g.run(['var', 'GIT_COMMITTER_IDENT']);
      identity.set(g.cwd, true);
      return [];
    } catch {
      return FALLBACK_IDENTITY;
    }
  }

  async function assertRepo(): Promise<string> {
    if (!(await repo.isRepo())) {
      throw new ChangesError('not_a_repository', 'This folder is not a git repository.');
    }
    try {
      return (await repo.run(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
    } catch {
      throw new ChangesError('not_a_repository', 'This repository has no commits yet.');
    }
  }

  const metaFile = (id: string) => path.join(panesDir, `${id}.json`);

  function readMeta(id: string): Meta | undefined {
    try {
      const parsed = metaSchema.safeParse(JSON.parse(readFileSync(metaFile(id), 'utf8')));
      return parsed.success && parsed.data.id === id ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  function isolatedIds(): string[] {
    if (!existsSync(panesDir)) return [];
    return readdirSync(panesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => WORKSPACE_ID_PATTERN.test(id) && existsSync(path.join(panesDir, id)));
  }

  function target(id: string): Target {
    if (id === MAIN_WORKSPACE_ID) {
      return { id, label: path.basename(projectDir), path: projectDir, isolated: false };
    }
    const meta = WORKSPACE_ID_PATTERN.test(id) ? readMeta(id) : undefined;
    const dir = path.join(panesDir, id);
    if (!meta || !existsSync(dir)) throw new ChangesError('not_found', `unknown workspace "${id}"`);
    return { id, label: meta.label, path: dir, isolated: true, meta };
  }

  async function optional(g: Git, args: string[]): Promise<string | undefined> {
    try {
      const out = (await g.run(args)).trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  }

  async function count(g: Git, range: string[]): Promise<number> {
    const out = await optional(g, ['rev-list', '--count', ...range]);
    return out ? Number(out) || 0 : 0;
  }

  /** What the workspace's changes are measured against. */
  async function diffBase(g: Git, t: Target): Promise<string> {
    const head = await optional(g, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!head) return EMPTY_TREE;
    if (!t.isolated || !t.meta) return head;
    if (t.meta.baseBranch) {
      const base = await optional(g, ['merge-base', `refs/heads/${t.meta.baseBranch}`, 'HEAD']);
      if (base) return base;
    }
    return (await optional(g, ['merge-base', t.meta.baseCommit, 'HEAD'])) ?? t.meta.baseCommit;
  }

  async function untrackedFiles(g: Git, root: string): Promise<ChangedFile[]> {
    const paths = nul(await g.run(['ls-files', '--others', '--exclude-standard', '-z']));
    return paths.map((rel) => {
      const content = readUntracked(root, rel);
      const binary = !content || looksBinary(content);
      return {
        path: rel,
        status: 'untracked',
        additions: binary ? 0 : countLines(content.toString('utf8')),
        deletions: 0,
        binary,
      };
    });
  }

  /** The file's bytes, or undefined when it is too large to render (or vanished). */
  function readUntracked(root: string, rel: string): Buffer | undefined {
    const file = path.join(root, rel);
    try {
      if (statSync(file).size > CHANGES_LIMITS.untrackedMaxBytes) return undefined;
      return readFileSync(file);
    } catch {
      return undefined;
    }
  }

  async function changedFiles(g: Git, t: Target): Promise<{ base: string; files: ChangedFile[] }> {
    const base = await diffBase(g, t);
    const common = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '-M', '-z'];
    const [names, stats, untracked] = await Promise.all([
      g.run([...common, '--name-status', base]),
      g.run([...common, '--numstat', base]),
      untrackedFiles(g, t.path),
    ]);
    return { base, files: mergeFileLists(parseNameStatus(names), parseNumStat(stats), untracked) };
  }

  async function describe(t: Target): Promise<ChangesWorkspace> {
    const g = gitAt(t.path);
    const [branch, { files }, porcelain, hasRemote] = await Promise.all([
      optional(g, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      changedFiles(g, t),
      g.run(['status', '--porcelain', '-z', '--untracked-files=all']),
      g.hasRemote(),
    ]);
    const upstream = branch
      ? await optional(g, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      : undefined;
    let ahead = 0;
    let unpushed = 0;
    if (t.isolated && t.meta) {
      const base = t.meta.baseBranch ? `refs/heads/${t.meta.baseBranch}` : t.meta.baseCommit;
      ahead = await count(g, [`${base}..HEAD`]);
    }
    if (upstream) unpushed = await count(g, ['@{u}..HEAD']);
    else if (t.isolated) unpushed = ahead;
    else if (hasRemote) unpushed = await count(g, ['HEAD', '--not', '--remotes']);
    if (!t.isolated) ahead = unpushed;
    return {
      id: t.id,
      label: t.label,
      isolated: t.isolated,
      path: t.path,
      ...(branch ? { branch } : {}),
      ...(t.meta?.baseBranch ? { baseBranch: t.meta.baseBranch } : {}),
      files,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      dirty: porcelain.length > 0,
      ahead,
      ...(upstream ? { upstream } : {}),
      unpushed,
      hasRemote,
      ...(t.meta ? { createdAt: t.meta.createdAt } : {}),
    };
  }

  async function uniqueBranch(g: Git, wanted: string): Promise<string> {
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? wanted : `${wanted}-${n}`;
      if (!(await g.branchExists(name))) return name;
    }
    return `${wanted}-${randomBytes(3).toString('hex')}`;
  }

  /** The remote's default branch, else `main` or `master` if present, else undefined. */
  async function defaultBranch(g: Git): Promise<string | undefined> {
    const head = await optional(g, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    if (head?.startsWith('origin/')) return head.slice('origin/'.length);
    for (const name of ['main', 'master']) if (await g.branchExists(name)) return name;
    return undefined;
  }

  function runGh(cwd: string, args: string[]): Promise<string> {
    if (options.runGh) return options.runGh(cwd, args);
    const gh = resolveOnPath(options.gh ?? 'gh', env);
    if (/\.(cmd|bat)$/i.test(gh)) {
      return Promise.reject(new Error('gh is a shell shim; DaveCode will not pass text to it'));
    }
    return new Promise((resolve, reject) => {
      execFile(
        gh,
        args,
        {
          cwd,
          env: { ...env, GH_PROMPT_DISABLED: '1' },
          timeout: SLOW_MS,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
            reject(
              new Error(
                missing
                  ? 'GitHub CLI (gh) is not installed. Install it and run `gh auth login`.'
                  : (stderr || err.message).trim(),
              ),
            );
          } else resolve(stdout.trim());
        },
      );
    });
  }

  async function commitAll(g: Git, message: string): Promise<string | undefined> {
    await g.run(['add', '-A']);
    if (!(await g.hasStagedChanges())) return undefined;
    await g.run([...(await identityArgs(g)), 'commit', '--quiet', '-m', message]);
    return (await g.run(['rev-parse', '--short', 'HEAD'])).trim();
  }

  function writeMeta(meta: Meta): void {
    mkdirSync(panesDir, { recursive: true });
    writeFileSync(metaFile(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async function removeWorktree(dir: string): Promise<void> {
    try {
      await repo.run(['worktree', 'remove', '--force', dir]);
    } catch {
      // not registered, or already gone
    }
    if (existsSync(dir))
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try {
      await repo.run(['worktree', 'prune']);
    } catch {
      // nothing to prune
    }
  }

  const service: ChangesService = {
    async list() {
      await assertRepo();
      const isolated = isolatedIds()
        .map((id) => target(id))
        .sort((a, b) => (a.meta?.createdAt ?? '').localeCompare(b.meta?.createdAt ?? ''));
      return Promise.all([target(MAIN_WORKSPACE_ID), ...isolated].map(describe));
    },

    async get(id) {
      await assertRepo();
      return describe(target(id));
    },

    create(input = {}) {
      return serial(async () => {
        const head = await assertRepo();
        if (isolatedIds().length >= CHANGES_LIMITS.maxWorkspaces) {
          throw new ChangesError(
            'limit',
            `At most ${CHANGES_LIMITS.maxWorkspaces} isolated workspaces per project. Remove one first.`,
          );
        }
        const id = randomBytes(4).toString('hex').slice(0, 6);
        const dir = path.join(panesDir, id);
        const baseBranch = await optional(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const branch = await uniqueBranch(repo, `${PANE_BRANCH_PREFIX}${id}`);
        mkdirSync(panesDir, { recursive: true });
        await repo.run(['worktree', 'add', '-b', assertSafeRef(branch), dir, head]);
        writeMeta({
          id,
          label: input.label ?? 'Isolated',
          ...(baseBranch ? { baseBranch } : {}),
          baseCommit: head,
          createdAt: now().toISOString(),
        });
        return describe(target(id));
      });
    },

    async diff(id, file) {
      await assertRepo();
      const t = target(id);
      const g = gitAt(t.path);
      const { base, files } = await changedFiles(g, t);
      let selected = files;
      if (file !== undefined) {
        selected = files.filter((f) => f.path === file || f.oldPath === file);
        if (selected.length === 0) throw new ChangesError('not_found', `"${file}" has no changes`);
      }
      const tracked = selected.filter((f) => f.status !== 'untracked');
      let patch = '';
      if (tracked.length > 0) {
        const paths = tracked.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
        patch = await g.run([
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M',
          base,
          '--',
          ...(file === undefined ? [] : paths),
        ]);
      }
      for (const f of selected) {
        if (f.status === 'untracked') patch += newFilePatch(f.path, readUntracked(t.path, f.path));
      }
      const truncated = patch.length > CHANGES_LIMITS.diffMaxLength;
      return { patch: truncated ? patch.slice(0, CHANGES_LIMITS.diffMaxLength) : patch, truncated };
    },

    async suggest(id, input = {}) {
      const { agent } = suggestSchema.parse(input);
      await assertRepo();
      const t = target(id);
      const workspace = await describe(t);
      if (workspace.files.length === 0) {
        throw new ChangesError('nothing_to_commit', 'There are no changes to describe.');
      }
      const fallback = fallbackSuggestion(workspace.files);
      if (!agent) return fallback;
      if (!options.writer) {
        throw new ChangesError('unavailable', 'No agent can write the message on this gateway.');
      }
      const { patch } = await service.diff(id);
      const controller = new AbortController();
      const result = await options.writer.run({
        agent,
        cwd: t.path,
        prompt: agentPrompt({
          ...(workspace.branch ? { branch: workspace.branch } : {}),
          files: workspace.files,
          patch,
        }),
        mode: 'plan',
        signal: controller.signal,
        timeoutMs: CHANGES_LIMITS.suggestTimeoutMs,
        onOutput: () => {},
      });
      const parsed = result.ok ? parseAgentSuggestion(result.text) : undefined;
      if (!parsed) {
        const why = result.ok
          ? 'it did not reply with the expected JSON'
          : (result.error ?? 'it failed');
        throw new ChangesError('unavailable', `${agent} could not write the message: ${why}`);
      }
      return { ...parsed, by: agent } satisfies ChangesSuggestion;
    },

    ship(id, input) {
      const request = shipSchema.parse(input);
      return serial(async (): Promise<ShipResult> => {
        await assertRepo();
        const t = target(id);
        const g = gitAt(t.path, true);
        const steps: ShipStep[] = [];
        let branch = await optional(g, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        let commit: string | undefined;
        let prUrl: string | undefined;
        const wantPush = request.push || request.pr !== undefined;
        if (!branch && (wantPush || request.pr)) {
          throw new ChangesError('invalid', 'HEAD is detached. Check out a branch first.');
        }
        const finish = async (ok: boolean): Promise<ShipResult> => ({
          ok,
          steps,
          ...(commit ? { commit } : {}),
          ...(branch ? { branch } : {}),
          ...(prUrl ? { prUrl } : {}),
          workspace: await describe(t),
        });
        const step = async (phase: ShipStep['phase'], work: () => Promise<string>) => {
          try {
            steps.push({ phase, ok: true, detail: await work() });
            return true;
          } catch (err) {
            steps.push({ phase, ok: false, detail: short(err) });
            return false;
          }
        };

        const before = await describe(t);
        if (request.message && !before.dirty && !wantPush) {
          throw new ChangesError('nothing_to_commit', 'There is nothing to commit.');
        }
        if (!request.message && !wantPush) {
          throw new ChangesError('invalid', 'Give a commit message, push or a pull request.');
        }

        // branch: a pull request needs its own branch; pane branches get a readable name.
        const base =
          request.pr?.base ??
          (t.isolated ? t.meta?.baseBranch : undefined) ??
          (request.pr ? await defaultBranch(g) : undefined);
        if (request.pr && branch) {
          const current = branch;
          const slug = slugify(request.pr.title);
          if (!t.isolated && current === base) {
            const ok = await step('branch', async () => {
              const name = await uniqueBranch(g, `davecode/${slug}`);
              await g.run(['switch', '--quiet', '-c', assertSafeRef(name)]);
              branch = name;
              return `Created ${name} from ${current}`;
            });
            if (!ok) return finish(false);
          } else if (t.isolated && current.startsWith(PANE_BRANCH_PREFIX) && !before.upstream) {
            const ok = await step('branch', async () => {
              const name = await uniqueBranch(g, `davecode/${slug}`);
              await g.run(['branch', '-m', assertSafeRef(current), assertSafeRef(name)]);
              branch = name;
              return `Renamed ${current} to ${name}`;
            });
            if (!ok) return finish(false);
          }
        }

        if (request.message && before.dirty) {
          const message = request.message;
          const ok = await step('commit', async () => {
            commit = await commitAll(g, message);
            if (!commit) throw new Error('Nothing was staged.');
            return `Committed ${commit}`;
          });
          if (!ok) return finish(false);
        }

        if (wantPush && branch) {
          const name = branch;
          const ok = await step('push', async () => {
            if (!(await g.hasRemote())) throw new Error('This repository has no "origin" remote.');
            await g.run(['push', '--quiet', '--set-upstream', 'origin', assertSafeRef(name)]);
            return `Pushed ${name} to origin`;
          });
          if (!ok) return finish(false);
        }

        if (request.pr && branch) {
          const pr = request.pr;
          const head = branch;
          const ok = await step('pr', async () => {
            if (!base) throw new Error('Could not tell which branch the pull request targets.');
            if (base === head) throw new Error(`The pull request would merge ${head} into itself.`);
            const args = [
              'pr',
              'create',
              '--base',
              assertSafeRef(base),
              '--head',
              assertSafeRef(head),
            ];
            args.push('--title', pr.title, '--body', pr.body || pr.title);
            if (pr.draft) args.push('--draft');
            try {
              const out = await runGh(t.path, args);
              prUrl = out.split('\n').at(-1)?.trim() || out;
            } catch (err) {
              const text = err instanceof Error ? err.message : String(err);
              if (!/already exists/i.test(text)) throw err;
              prUrl = await runGh(t.path, ['pr', 'view', head, '--json', 'url', '--jq', '.url']);
            }
            return prUrl;
          });
          if (!ok) return finish(false);
        }
        return finish(true);
      });
    },

    merge(id, input = {}) {
      const { message } = mergeSchema.parse(input);
      return serial(async () => {
        await assertRepo();
        const t = target(id);
        if (!t.isolated)
          throw new ChangesError('invalid', 'Only an isolated workspace can be merged.');
        const g = gitAt(t.path, true);
        const branch = await optional(g, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (!branch) throw new ChangesError('invalid', 'The workspace has no branch checked out.');
        let state = await describe(t);
        if (state.dirty) {
          if (!message) {
            throw new ChangesError(
              'dirty',
              'The workspace has uncommitted changes. Commit them first.',
            );
          }
          await commitAll(g, message);
          state = await describe(t);
        }
        if (state.ahead === 0)
          throw new ChangesError('nothing_to_commit', 'There is nothing to merge.');
        const into = await optional(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (!into) throw new ChangesError('invalid', 'The project checkout is on a detached HEAD.');
        if (samePath(t.path, projectDir))
          throw new ChangesError('invalid', 'Cannot merge into itself.');
        const main = gitAt(projectDir, true);
        try {
          await main.run([
            ...(await identityArgs(main)),
            'merge',
            '--no-ff',
            '--no-edit',
            '-m',
            `Merge ${t.label} (${branch}) into ${into}`,
            assertSafeRef(branch),
          ]);
        } catch (err) {
          const conflicts = nul(
            (await optional(main, ['diff', '--name-only', '-z', '--diff-filter=U'])) ?? '',
          );
          await main.abortMerge();
          throw new ChangesError(
            'conflict',
            conflicts.length > 0
              ? `The merge conflicts in ${conflicts.join(', ')}. Nothing was changed.`
              : `The merge failed: ${short(err)}`,
          );
        }
        return describe(target(MAIN_WORKSPACE_ID));
      });
    },

    remove(id, input = {}) {
      const { deleteBranch } = removeSchema.parse(input);
      return serial(async () => {
        const t = target(id);
        if (!t.isolated)
          throw new ChangesError('invalid', 'The project checkout cannot be removed.');
        const branch = await optional(gitAt(t.path), [
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ]);
        await removeWorktree(t.path);
        rmSync(metaFile(id), { force: true });
        if (deleteBranch && branch) {
          try {
            await repo.run(['branch', '-D', assertSafeRef(branch)]);
          } catch {
            // already gone
          }
        }
      });
    },
  };
  return service;
}
