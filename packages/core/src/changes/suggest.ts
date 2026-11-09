/**
 * Commit message and pull request text. The deterministic version reads only the file list, so
 * it is free and instant; an agent can do better from the patch itself (`agentPrompt` and
 * `parseAgentSuggestion`).
 */
import { z } from 'zod';
import { CHANGES_LIMITS, type ChangedFile, type ChangesSuggestion } from './contract';

const DOC = /(^|\/)docs?\/|\.(md|mdx|txt|rst)$/i;
const TEST = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z0-9]+$/i;
const PACKAGE = /^(?:packages|apps|libs|services)\/([^/]+)\//;
const MAX_LISTED = 30;

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/** `docs`, `test` or `chore`: the file list cannot tell a feature from a fix. */
function commitType(files: ChangedFile[]): string {
  if (files.every((f) => DOC.test(f.path))) return 'docs';
  if (files.every((f) => TEST.test(f.path))) return 'test';
  return 'chore';
}

/** The package every file belongs to, if they share one. */
function commitScope(files: ChangedFile[]): string | undefined {
  const scopes = new Set(files.map((f) => PACKAGE.exec(f.path)?.[1]));
  if (scopes.size !== 1) return undefined;
  const [scope] = scopes;
  return scope;
}

function subject(files: ChangedFile[]): string {
  if (files.length === 1) {
    const [file] = files as [ChangedFile];
    const verb =
      file.status === 'added' || file.status === 'untracked'
        ? 'add'
        : file.status === 'deleted'
          ? 'remove'
          : file.status === 'renamed'
            ? 'rename'
            : 'update';
    return `${verb} ${basename(file.path)}`;
  }
  return `update ${files.length} files`;
}

function fileLine(file: ChangedFile): string {
  const counts = file.binary ? 'binary' : `+${file.additions} −${file.deletions}`;
  const from = file.oldPath ? ` (from \`${file.oldPath}\`)` : '';
  return `- \`${file.path}\`${from} — ${counts}`;
}

/** A Conventional Commits message and pull request text derived from the changed files. */
export function fallbackSuggestion(files: ChangedFile[]): ChangesSuggestion {
  if (files.length === 0) {
    return { message: 'chore: update', title: 'chore: update', body: '', by: 'davecode' };
  }
  const scope = commitScope(files);
  const message = `${commitType(files)}${scope ? `(${scope})` : ''}: ${subject(files)}`;
  const listed = files.slice(0, MAX_LISTED).map(fileLine);
  if (files.length > MAX_LISTED) listed.push(`- …and ${files.length - MAX_LISTED} more`);
  const body = `## Changes\n\n${listed.join('\n')}\n`;
  return { message, title: message, body, by: 'davecode' };
}

/** What an agent is asked: metadata only, from the file list and the (possibly cut) patch. */
export function agentPrompt(input: {
  branch?: string;
  files: ChangedFile[];
  patch: string;
}): string {
  const max = CHANGES_LIMITS.suggestDiffMaxLength;
  const patch =
    input.patch.length > max ? `${input.patch.slice(0, max)}\n[patch truncated]` : input.patch;
  const files = input.files
    .map(
      (f) =>
        `${f.status} ${f.path}${f.binary ? ' (binary)' : ` (+${f.additions} -${f.deletions})`}`,
    )
    .join('\n');
  return [
    'Write the git commit message and pull request text for the changes below.',
    'Do not modify any file and do not run any command: only read the patch.',
    'Reply with a single JSON object and nothing else (no code fence):',
    '{"message": "<Conventional Commits subject, imperative mood, at most 72 characters>",',
    ' "title": "<pull request title, at most 72 characters>",',
    ' "body": "<pull request description in Markdown: one short paragraph, then a bullet list of the main changes>"}',
    'Write in the same language as the code comments; default to English.',
    '',
    `Branch: ${input.branch ?? '(detached)'}`,
    'Changed files:',
    files,
    '',
    'Patch:',
    patch,
  ].join('\n');
}

const agentReplySchema = z.object({
  message: z.string().trim().min(1).max(CHANGES_LIMITS.messageMaxLength),
  title: z.string().trim().min(1).max(CHANGES_LIMITS.titleMaxLength),
  body: z.string().max(CHANGES_LIMITS.bodyMaxLength).default(''),
});

/** The JSON object in an agent's reply (code fences and chatter around it are tolerated). */
export function parseAgentSuggestion(text: string): Omit<ChangesSuggestion, 'by'> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = agentReplySchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
