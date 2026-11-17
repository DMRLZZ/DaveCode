/**
 * What one chat turn changed, from git. Before the turn `git stash create` records the working
 * tree as a commit without touching it (or HEAD when nothing is pending); after the turn the
 * diff from that commit is exactly what the agent did, plus the files it created.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newFilePatch } from '../changes/parse';
import type { ChatFileChange } from './contract';

/** Git's empty tree: the base for a repository without any commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** A new file bigger than this is listed but not shown line by line. */
const NEW_FILE_MAX_BYTES = 200_000;

export interface TreeSnapshot {
  base: string;
  untracked: Set<string>;
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve({ ok: !error, stdout: stdout ?? '' }),
    );
  });
}

async function untracked(cwd: string): Promise<Set<string>> {
  const out = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return new Set(out.stdout.split('\0').filter(Boolean));
}

/** The tree before a turn, or undefined when the folder is not a git repository. */
export async function takeSnapshot(cwd: string): Promise<TreeSnapshot | undefined> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return undefined;
  const stash = await git(cwd, ['stash', 'create']);
  let base = stash.ok ? stash.stdout.trim() : '';
  if (!base) {
    const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    base = head.ok ? head.stdout.trim() : EMPTY_TREE;
  }
  return { base, untracked: await untracked(cwd) };
}

export interface TurnChanges {
  files: ChatFileChange[];
  patch: string;
  truncated: boolean;
}

/** Everything that changed since `snapshot`. */
export async function changesSince(
  cwd: string,
  snapshot: TreeSnapshot,
  maxBytes: number,
): Promise<TurnChanges> {
  const files: ChatFileChange[] = [];
  const parts: string[] = [];

  const status = await git(cwd, ['diff', '--name-status', '--no-renames', snapshot.base, '--']);
  const counts = await git(cwd, ['diff', '--numstat', '--no-renames', snapshot.base, '--']);
  const numbers = new Map<string, { additions: number; deletions: number }>();
  for (const line of counts.stdout.split('\n')) {
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    numbers.set(path, {
      additions: Number.parseInt(add ?? '', 10) || 0,
      deletions: Number.parseInt(del ?? '', 10) || 0,
    });
  }
  for (const line of status.stdout.split('\n')) {
    const [code, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!code || !path) continue;
    const kind = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    files.push({ path, status: kind, ...(numbers.get(path) ?? { additions: 0, deletions: 0 }) });
  }
  const tracked = await git(cwd, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    snapshot.base,
    '--',
  ]);
  if (tracked.stdout) parts.push(tracked.stdout);

  for (const path of [...(await untracked(cwd))].sort()) {
    if (snapshot.untracked.has(path)) continue;
    let content: Buffer | undefined;
    try {
      content = await readFile(join(cwd, path));
    } catch {
      continue;
    }
    const big = content.length > NEW_FILE_MAX_BYTES;
    const text = big ? undefined : content;
    const additions = text && !text.subarray(0, 8000).includes(0) ? countLines(text) : 0;
    files.push({ path, status: 'added', additions, deletions: 0 });
    parts.push(newFilePatch(path, text));
  }

  let patch = parts.join('');
  let truncated = false;
  if (Buffer.byteLength(patch) > maxBytes) {
    patch = Buffer.from(patch).subarray(0, maxBytes).toString('utf8');
    // Never end in the middle of a line: the diff view reads whole lines.
    patch = patch.slice(0, patch.lastIndexOf('\n') + 1);
    truncated = true;
  }
  return { files, patch, truncated };
}

function countLines(content: Buffer): number {
  const text = content.toString('utf8');
  if (!text) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}
