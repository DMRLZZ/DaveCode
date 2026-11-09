import { z } from 'zod';
import { ApiError } from './api';
import type {
  ApiErrorBody,
  ChangedFile,
  ChangesDiff,
  ChangesSuggestion,
  ChangesWorkspace,
  ShipInput,
  ShipResult,
} from './types';

/**
 * Changes review client: the HTTP calls under `/api/changes` and the pure helpers the review
 * panel and the pane headers derive from them (patch parsing, labels, the one-click action).
 */

// --- Response validation ----------------------------------------------------------------------

// Loose objects: the fields the UI relies on are checked, anything else passes through.
const fileSchema = z.looseObject({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
});

const workspaceSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  isolated: z.boolean(),
  path: z.string(),
  files: z.array(fileSchema),
  additions: z.number(),
  deletions: z.number(),
  dirty: z.boolean(),
  ahead: z.number(),
  unpushed: z.number(),
  hasRemote: z.boolean(),
});

const diffSchema = z.object({ patch: z.string(), truncated: z.boolean() });

const suggestionSchema = z.object({
  message: z.string(),
  title: z.string(),
  body: z.string(),
  by: z.enum(['davecode', 'claude', 'codex', 'agy']),
});

const shipSchema = z.looseObject({
  ok: z.boolean(),
  steps: z.array(
    z.object({
      phase: z.enum(['branch', 'commit', 'push', 'pr']),
      ok: z.boolean(),
      detail: z.string(),
    }),
  ),
  workspace: workspaceSchema,
});

function parse<T>(schema: z.ZodType, json: unknown): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(0, 'bad_response', 'Unexpected changes response.');
  return parsed.data as T;
}

// --- HTTP -------------------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'DELETE';

async function call(base: string, token: string, method: Method, path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}/api/changes${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // State-changing requests always declare JSON, even without a body (the gateway requires it).
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new ApiError(0, 'network', `Gateway unreachable: ${(e as Error).message}`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, 'bad_response', 'Unexpected changes response.');
  }
  if (!response.ok) {
    const error = (json as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `The changes request failed (${response.status}).`,
    );
  }
  return json;
}

const ws = (id: string) => `/workspaces/${encodeURIComponent(id)}`;

/**
 * Every workspace of the project, or null when this gateway has no changes review (404: not a
 * project, a remote gateway, an older version). Other failures (not a repository) throw.
 */
export async function listWorkspaces(
  base: string,
  token: string,
): Promise<ChangesWorkspace[] | null> {
  try {
    const json = await call(base, token, 'GET', '/workspaces');
    return parse<{ workspaces: ChangesWorkspace[] }>(
      z.object({ workspaces: z.array(workspaceSchema) }),
      json,
    ).workspaces;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function createWorkspace(
  base: string,
  token: string,
  label: string,
): Promise<ChangesWorkspace> {
  return parse(workspaceSchema, await call(base, token, 'POST', '/workspaces', { label }));
}

export async function fetchDiff(
  base: string,
  token: string,
  id: string,
  file?: string,
): Promise<ChangesDiff> {
  const query = file === undefined ? '' : `?path=${encodeURIComponent(file)}`;
  return parse(diffSchema, await call(base, token, 'GET', `${ws(id)}/diff${query}`));
}

export async function suggestText(
  base: string,
  token: string,
  id: string,
  agent?: ChangesSuggestion['by'],
): Promise<ChangesSuggestion> {
  const body = agent && agent !== 'davecode' ? { agent } : {};
  return parse(suggestionSchema, await call(base, token, 'POST', `${ws(id)}/suggest`, body));
}

export async function shipWorkspace(
  base: string,
  token: string,
  id: string,
  input: ShipInput,
): Promise<ShipResult> {
  return parse(shipSchema, await call(base, token, 'POST', `${ws(id)}/ship`, input));
}

export async function mergeWorkspace(
  base: string,
  token: string,
  id: string,
  message?: string,
): Promise<ChangesWorkspace> {
  return parse(
    workspaceSchema,
    await call(base, token, 'POST', `${ws(id)}/merge`, message ? { message } : {}),
  );
}

export async function removeWorkspace(
  base: string,
  token: string,
  id: string,
  deleteBranch: boolean,
) {
  await call(base, token, 'DELETE', `${ws(id)}${deleteBranch ? '?deleteBranch=true' : ''}`);
}

// --- Patch parsing ----------------------------------------------------------------------------

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'note';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function stripPrefix(path: string): string {
  return path.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

/** Splits a unified git patch into files, hunks and numbered lines. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = { path: match?.[2] ?? line.slice(11), binary: false, hunks: [] };
      const oldPath = match?.[1];
      if (oldPath && oldPath !== file.path) file.oldPath = oldPath;
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    const head = HUNK.exec(line);
    if (head) {
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('rename from ')) file.oldPath = line.slice('rename from '.length);
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null')
        file.path = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-'))
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith('\\')) hunk.lines.push({ kind: 'note', text: line.slice(1).trim() });
    // Context lines always start with a space; an empty line is the patch's final newline.
    else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

// --- Labels and actions -----------------------------------------------------------------------

export const FILE_STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

export type ShipAction = 'commit' | 'commit_push' | 'commit_push_pr';

export const SHIP_ACTION_LABEL: Record<ShipAction, string> = {
  commit: 'Commit',
  commit_push: 'Commit & push',
  commit_push_pr: 'Commit, push & open PR',
};

/** What the main button does by default: a PR when there is a remote, else a commit. */
export function defaultShipAction(workspace: ChangesWorkspace): ShipAction {
  return workspace.hasRemote ? 'commit_push_pr' : 'commit';
}

/** Actions that make sense for the workspace (push needs a remote). */
export function shipActions(workspace: ChangesWorkspace): ShipAction[] {
  return workspace.hasRemote ? ['commit', 'commit_push', 'commit_push_pr'] : ['commit'];
}

/** The request one click sends. Without changes, only the push and PR parts remain. */
export function shipRequest(
  action: ShipAction,
  text: { message: string; title: string; body: string; draft: boolean },
  dirty: boolean,
): ShipInput {
  const message = text.message.trim();
  const input: ShipInput = {};
  if (dirty && message) input.message = message;
  if (action !== 'commit') input.push = true;
  if (action === 'commit_push_pr') {
    input.pr = { title: text.title.trim() || message, body: text.body, draft: text.draft };
  }
  return input;
}

/** True when the click would do something: commit changes, or push/open a PR for commits. */
export function canShip(
  workspace: ChangesWorkspace,
  action: ShipAction,
  message: string,
  title: string,
): boolean {
  const hasMessage = message.trim().length > 0;
  if (action === 'commit') return workspace.dirty && hasMessage;
  if (workspace.dirty && !hasMessage) return false;
  if (action === 'commit_push_pr' && !(title.trim() || message.trim())) return false;
  return workspace.dirty || workspace.unpushed > 0 || action === 'commit_push_pr';
}

/** `+12 −3` (or nothing for a clean workspace). */
export function lineCounts(
  workspace: Pick<ChangesWorkspace, 'additions' | 'deletions' | 'files'>,
): string {
  if (workspace.files.length === 0) return '';
  return `+${workspace.additions} −${workspace.deletions}`;
}

/** `davecode/pane-ab12cd` → `pane-ab12cd`; other branches unchanged. */
export function shortBranch(branch: string | undefined): string {
  if (!branch) return 'detached';
  return branch.startsWith('davecode/') ? branch.slice('davecode/'.length) : branch;
}

/** Total changed files across workspaces, for the toolbar badge. */
export function changedFileCount(
  workspaces: readonly ChangesWorkspace[] | null | undefined,
): number {
  return (workspaces ?? []).reduce((sum, w) => sum + w.files.length, 0);
}
