/**
 * Pure helpers for the changes service: parsing `git diff -z` output and rendering untracked
 * files as patches. No I/O here, so every case is unit-testable.
 */
import type { ChangedFile, ChangedFileStatus } from './contract';

/** NUL-separated tokens without the trailing empty one. */
function tokens(out: string): string[] {
  const parts = out.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function statusOf(letter: string): ChangedFileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    default:
      // M, T (type change) and U (unmerged) all read as "modified" in a review.
      return 'modified';
  }
}

/** `git diff --name-status -z -M`: `M\0path\0`, `R100\0old\0new\0`. */
export function parseNameStatus(
  out: string,
): { path: string; oldPath?: string; status: ChangedFileStatus }[] {
  const parts = tokens(out);
  const files: { path: string; oldPath?: string; status: ChangedFileStatus }[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? '';
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      files.push(
        code[0] === 'R' ? { path, oldPath, status: 'renamed' } : { path, status: 'added' },
      );
    } else {
      files.push({ path: parts[i++] ?? '', status: statusOf(code) });
    }
  }
  return files.filter((f) => f.path.length > 0);
}

export interface NumStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * `git diff --numstat -z -M`: `3\t1\tpath\0` for a plain change, `3\t1\t\0old\0new\0` for a
 * rename, and `-\t-\t…` for a binary file. Keyed by the new path.
 */
export function parseNumStat(out: string): Map<string, NumStat> {
  const parts = tokens(out);
  const stats = new Map<string, NumStat>();
  for (let i = 0; i < parts.length; ) {
    const head = parts[i++] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!match) continue;
    const [, added = '0', deleted = '0', inline = ''] = match;
    let path = inline;
    if (inline === '') {
      i++; // old path
      path = parts[i++] ?? '';
    }
    const binary = added === '-' || deleted === '-';
    stats.set(path, {
      additions: binary ? 0 : Number(added),
      deletions: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return stats;
}

export function mergeFileLists(
  tracked: { path: string; oldPath?: string; status: ChangedFileStatus }[],
  stats: Map<string, NumStat>,
  untracked: ChangedFile[],
): ChangedFile[] {
  const files: ChangedFile[] = tracked.map((file) => {
    const stat = stats.get(file.path) ?? { additions: 0, deletions: 0, binary: false };
    return { ...file, ...stat };
  });
  const seen = new Set(files.map((f) => f.path));
  for (const file of untracked) if (!seen.has(file.path)) files.push(file);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** True when the buffer looks binary (a NUL byte in its first 8 KB, like git's heuristic). */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

/** Lines a text file adds when it is new: a final line without `\n` still counts. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** A git-style patch that creates `path` with `content` (or marks it binary). */
export function newFilePatch(path: string, content: Buffer | undefined): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  if (!content || looksBinary(content)) {
    return `${header}Binary files /dev/null and b/${path} differ\n`;
  }
  const text = content.toString('utf8');
  if (text.length === 0) return header;
  const lines = text.split('\n');
  const trailingNewline = text.endsWith('\n');
  if (trailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  return `${header}--- /dev/null\n+++ b/${path}\n${hunk}${trailingNewline ? '' : '\\ No newline at end of file\n'}`;
}

/** Lowercase, dash-separated branch fragment from a title; never empty. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // A Conventional Commits prefix ("feat(ui): …") says nothing about the branch.
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'changes';
}

/** Removes credentials from URLs (`https://user:token@host`) in git or gh output. */
export function scrubUrls(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}
