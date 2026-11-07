import type { OrchestratorWorkspace } from './contract';

export interface GitWorkspaceOptions {
  /** Absolute project root (a git repository). */
  projectDir: string;
  /** Worktrees live under `<worktreesDir>/<runId>/<taskId>`, outside the project. */
  worktreesDir: string;
}

/** STUB: replaced by the git worktree implementation. */
export function createGitWorkspace(_options: GitWorkspaceOptions): OrchestratorWorkspace {
  throw new Error('not implemented');
}
