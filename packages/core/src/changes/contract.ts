/**
 * Changes: review what the agents changed and ship it. Every pane can work in the project's own
 * checkout (`main`) or in an isolated git worktree on its own branch (`davecode/pane-<id>`).
 * For each workspace the user sees the changed files and their diff, and can commit, push and
 * open a pull request in one step, or merge an isolated branch back into the checkout.
 *
 * This file is the shared contract between the service (`service.ts`), the HTTP routes, the
 * desktop app and the UI. Change it only together with `docs/API.md`.
 */
import { z } from 'zod';

export const CHANGES_LIMITS = {
  /** Most isolated workspaces per project. */
  maxWorkspaces: 12,
  labelMaxLength: 60,
  messageMaxLength: 5000,
  titleMaxLength: 200,
  bodyMaxLength: 20_000,
  /** Largest patch returned by `diff` (characters); longer patches are cut and flagged. */
  diffMaxLength: 1_000_000,
  /** Largest untracked file rendered as a patch (bytes); bigger ones are listed as binary. */
  untrackedMaxBytes: 512 * 1024,
  /** Largest patch handed to an agent to write the commit message (characters). */
  suggestDiffMaxLength: 40_000,
  /** Hard timeout for an agent writing the commit message. */
  suggestTimeoutMs: 3 * 60_000,
} as const;

/** The id of the project's own checkout. Isolated workspaces use short lowercase ids. */
export const MAIN_WORKSPACE_ID = 'main';
export const WORKSPACE_ID_PATTERN = /^[a-z0-9]{4,24}$/;
/** Branch prefix of isolated workspaces before they get a name from their pull request. */
export const PANE_BRANCH_PREFIX = 'davecode/pane-';

export const workspaceIdSchema = z
  .string()
  .refine((id) => id === MAIN_WORKSPACE_ID || WORKSPACE_ID_PATTERN.test(id), 'invalid workspace');

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  /** Path relative to the workspace root, with `/` separators. */
  path: string;
  /** Previous path of a renamed file. */
  oldPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesWorkspace {
  /** `main` for the project checkout, or the isolated workspace's id. */
  id: string;
  /** What the user called it (the agent's name for panes), or the project folder's name. */
  label: string;
  /** True for a git worktree on its own branch; false for the project checkout. */
  isolated: boolean;
  /** Absolute path of the working tree. */
  path: string;
  /** Checked-out branch; absent when HEAD is detached. */
  branch?: string;
  /** Branch an isolated workspace started from, and the default base of its pull request. */
  baseBranch?: string;
  /**
   * Files that differ: for the checkout, uncommitted changes against HEAD; for an isolated
   * workspace, everything since it left `baseBranch` (its commits plus uncommitted work).
   */
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** Uncommitted changes exist (tracked or untracked). */
  dirty: boolean;
  /** Commits not yet in `baseBranch` (isolated) or not yet pushed (checkout with upstream). */
  ahead: number;
  /** `origin/<branch>` when the branch tracks a remote branch. */
  upstream?: string;
  /** Commits on this branch that its upstream lacks; equals `ahead` without an upstream. */
  unpushed: number;
  /** The repository has an `origin` remote. */
  hasRemote: boolean;
  createdAt?: string;
}

export interface ChangesDiff {
  /** Unified patch (git format), untracked files included as new files. */
  patch: string;
  /** The patch was longer than `diffMaxLength` and was cut. */
  truncated: boolean;
}

/** A commit message and pull request text, written by an agent or derived from the file list. */
export interface ChangesSuggestion {
  message: string;
  title: string;
  body: string;
  /** Who wrote it: an agent id, or `davecode` for the deterministic fallback. */
  by: 'davecode' | 'claude' | 'codex' | 'agy';
}

export type ShipPhase = 'branch' | 'commit' | 'push' | 'pr';

export interface ShipStep {
  phase: ShipPhase;
  ok: boolean;
  /** What happened: the new branch, the commit, the pull request URL, or why it failed. */
  detail: string;
}

export interface ShipResult {
  /** Every requested step succeeded. */
  ok: boolean;
  steps: ShipStep[];
  /** Short commit id when a commit was made. */
  commit?: string;
  /** Branch the work ended up on. */
  branch?: string;
  prUrl?: string;
  /** The workspace after shipping. */
  workspace: ChangesWorkspace;
}

const safeRef = z
  .string()
  .regex(/^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)(?!-)[A-Za-z0-9._/-]{1,200}$/);

export const createWorkspaceSchema = z.object({
  label: z.string().trim().min(1).max(CHANGES_LIMITS.labelMaxLength).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const suggestSchema = z.object({
  /** Agent that writes the text; without one, DaveCode derives it from the file list. */
  agent: z.enum(['claude', 'codex', 'agy']).optional(),
});
export type SuggestInput = z.infer<typeof suggestSchema>;

/**
 * One click from the review panel. Steps run in order and stop at the first failure:
 * `branch` (only for a pull request from the default branch, or to name a pane branch),
 * `commit` (when `message` is given and there are changes), `push` (when `push` or `pr`),
 * then `pr`.
 */
export const shipSchema = z.object({
  message: z.string().trim().min(1).max(CHANGES_LIMITS.messageMaxLength).optional(),
  push: z.boolean().default(false),
  pr: z
    .object({
      title: z.string().trim().min(1).max(CHANGES_LIMITS.titleMaxLength),
      body: z.string().max(CHANGES_LIMITS.bodyMaxLength).default(''),
      draft: z.boolean().default(false),
      /** Default: `baseBranch` for isolated workspaces, the remote's default branch otherwise. */
      base: safeRef.optional(),
    })
    .optional(),
});
export type ShipInput = z.input<typeof shipSchema>;

export const mergeSchema = z.object({
  /** Commits uncommitted work in the isolated workspace with this message before merging. */
  message: z.string().trim().min(1).max(CHANGES_LIMITS.messageMaxLength).optional(),
});
export type MergeInput = z.infer<typeof mergeSchema>;

export const removeSchema = z.object({
  /** Also delete the workspace's branch. By default it stays, so no work is lost. */
  deleteBranch: z.boolean().default(false),
});
export type RemoveInput = z.input<typeof removeSchema>;

export interface ChangesService {
  /** The checkout first, then isolated workspaces, oldest first. */
  list(): Promise<ChangesWorkspace[]>;
  get(id: string): Promise<ChangesWorkspace>;
  /** A new worktree on `davecode/pane-<id>`, branched from the checkout's current commit. */
  create(input?: CreateWorkspaceInput): Promise<ChangesWorkspace>;
  /** Patch of the workspace's changes, or of one file. */
  diff(id: string, file?: string): Promise<ChangesDiff>;
  /** Commit message and pull request text for the workspace's changes. */
  suggest(id: string, input?: SuggestInput): Promise<ChangesSuggestion>;
  ship(id: string, input: ShipInput): Promise<ShipResult>;
  /** Merges an isolated workspace's branch into the checkout's current branch. */
  merge(id: string, input?: MergeInput): Promise<ChangesWorkspace>;
  /** Removes an isolated workspace's worktree (and its branch with `deleteBranch`). */
  remove(id: string, input?: RemoveInput): Promise<void>;
}

export type ChangesErrorCode =
  | 'not_found'
  | 'not_a_repository'
  | 'invalid'
  | 'limit'
  | 'nothing_to_commit'
  | 'dirty'
  | 'conflict'
  | 'unavailable';

export class ChangesError extends Error {
  constructor(
    readonly code: ChangesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChangesError';
  }
}
