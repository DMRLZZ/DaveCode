/**
 * Pane orchestrator: the DaveCode agent that splits one objective across the vendor CLIs the
 * user already signed in to (Claude Code, Codex, Antigravity), runs each subtask headlessly in
 * its own git worktree, merges the results into an integration branch and lets the user apply
 * it. It never touches the user's working tree until they apply, and never pushes.
 *
 * This file is the shared contract between the engine (`service.ts`), the headless runners
 * (`runners.ts`), the git workspace (`workspace.ts`), the HTTP routes and the UI. Change it
 * only together with `docs/API.md`.
 */
import { z } from 'zod';

/** The agents the orchestrator can drive. Same ids as the desktop pane kinds. */
export const ORCHESTRATOR_AGENTS = ['claude', 'codex', 'agy'] as const;
export type OrchestratorAgent = (typeof ORCHESTRATOR_AGENTS)[number];

export const ORCHESTRATOR_LIMITS = {
  objectiveMaxLength: 4000,
  /** Most tasks a plan may contain. */
  maxTasks: 8,
  /** Default when the request does not say. */
  defaultMaxTasks: 5,
  /** Most tasks running at the same time. */
  maxParallel: 3,
  /** Hard timeout for one headless agent run. */
  taskTimeoutMs: 30 * 60_000,
  /** Hard timeout for the planning run. */
  planTimeoutMs: 5 * 60_000,
  /** Longest summary kept per task (characters, head kept). */
  summaryMaxLength: 4000,
  /** Output chunks kept per task (and for the planner) in a run's transcript; oldest dropped. */
  transcriptMaxChunks: 400,
  /** Times a task's agent is started: a failure that may be transient gets one more try. */
  taskAttempts: 2,
} as const;

/**
 * What the agents of a run may do besides editing files in their worktree.
 * - `edit`: edit files only. Codex and Antigravity still run commands inside their own OS
 *   sandbox; Claude Code has no such sandbox, so it runs no shell command at all.
 * - `full`: agents may also run shell commands (tests, builds, installs) with the user's own
 *   permissions. Claude Code gets its shell tools and Codex gets network access in its sandbox.
 */
export const ORCHESTRATOR_ACCESS = ['edit', 'full'] as const;
export type OrchestratorAccess = (typeof ORCHESTRATOR_ACCESS)[number];

export type OrchestratorRunStatus =
  /** The planner agent is splitting the objective. */
  | 'planning'
  /** Tasks are running or waiting for their dependencies. */
  | 'running'
  /** Every task finished; results are on the integration branch. */
  | 'done'
  /** Planning failed, or no task succeeded. */
  | 'failed'
  | 'cancelled';

export type OrchestratorTaskStatus =
  | 'pending'
  | 'running'
  /** Finished, committed and merged into the integration branch. */
  | 'done'
  | 'failed'
  /** Finished, but its branch conflicts with the integration branch. It stays unmerged. */
  | 'conflict'
  | 'cancelled'
  /** Never ran because a dependency did not finish. */
  | 'skipped';

export interface OrchestratorTask {
  /** `t1`, `t2`, … in plan order. */
  id: string;
  title: string;
  agent: OrchestratorAgent;
  /** The full instruction the agent receives. */
  prompt: string;
  /** Ids of tasks whose results this one builds on. */
  dependsOn: string[];
  status: OrchestratorTaskStatus;
  /** Git branch holding this task's commit. */
  branch?: string;
  /** The agent's final reply, truncated to `summaryMaxLength`. */
  summary?: string;
  /** Files the task changed, relative to the project root. */
  changedFiles?: string[];
  /** Short, redacted reason for `failed`, `conflict` or `skipped`. Never a secret. */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface OrchestratorRun {
  id: string;
  objective: string;
  status: OrchestratorRunStatus;
  /** Agents the user allowed for this run. */
  agents: OrchestratorAgent[];
  /** The agent that wrote the plan. */
  planner?: OrchestratorAgent;
  /** What the task agents may do. Missing on runs recorded before 0.8 (they ran as `edit`). */
  access?: OrchestratorAccess;
  /** Branch and commit the run started from. */
  baseBranch?: string;
  baseCommit?: string;
  /** `davecode/run-<id>`: every successful task merged together. */
  integrationBranch?: string;
  tasks: OrchestratorTask[];
  /** One-paragraph outcome written when the run ends. */
  summary?: string;
  /** Short, redacted reason when the run failed. */
  error?: string;
  /** Set once the integration branch was merged into `baseBranch`. */
  appliedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A piece of an agent's live activity, already reduced to plain text for display. */
export interface AgentOutput {
  kind: 'text' | 'tool' | 'status' | 'error';
  text: string;
}

/** The kept part of one task's output: `chunks[0]` was the stream's chunk number `from`. */
export interface AgentTranscript {
  from: number;
  chunks: AgentOutput[];
}

/** Every stream of a run, keyed by task id (`plan` for the planner). */
export type RunTranscript = Record<string, AgentTranscript>;

export interface AgentAvailability {
  agent: OrchestratorAgent;
  /** Its CLI is on PATH. Sign-in is not checked: a signed-out CLI fails its task. */
  available: boolean;
}

// --- Headless agent runs (runners.ts) ---------------------------------------------------------

export interface AgentRunRequest {
  agent: OrchestratorAgent;
  /** Working directory: a task worktree, or the project root for planning. */
  cwd: string;
  /** Sent on stdin, never on the command line. */
  prompt: string;
  /** `plan` must not modify files; `edit` may edit files inside `cwd`. */
  mode: 'plan' | 'edit';
  /** Only for `edit` runs; defaults to `edit` (no shell for Claude Code). */
  access?: OrchestratorAccess;
  /** Continue this conversation of the agent (an id an earlier result returned as `session`). */
  resume?: string;
  signal: AbortSignal;
  timeoutMs: number;
  onOutput(chunk: AgentOutput): void;
}

export interface AgentRunResult {
  ok: boolean;
  /** The agent's final reply. */
  text: string;
  /** Short, redacted reason when `ok` is false. */
  error?: string;
  /**
   * The failure may not happen again (a dropped connection, a CLI that died mid-turn). False for
   * what a retry cannot fix: not signed in, out of quota, rate limited, timed out, not installed.
   */
  retryable?: boolean;
  tokens?: number;
  /** The agent's own id for this conversation, to continue it with `resume`. */
  session?: string;
}

export interface AgentRunner {
  availability(): Promise<AgentAvailability[]>;
  /** Resolves (never rejects) unless the signal aborted, which rejects with an AbortError. */
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

// --- Git workspace (workspace.ts) -------------------------------------------------------------

export interface TaskWorkspace {
  /** Absolute path of the task's worktree. */
  path: string;
  branch: string;
}

export type WorkspaceResult = { ok: true } | { ok: false; reason: string };

export interface OrchestratorWorkspace {
  /** The project is a git repository with at least one commit; returns where HEAD is. */
  check(): Promise<{ ok: true; branch: string; commit: string } | { ok: false; reason: string }>;
  /** Creates `davecode/run-<runId>` at `baseCommit` and returns its name. */
  createIntegration(runId: string, baseCommit: string): Promise<string>;
  /** A fresh worktree on `davecode/run-<runId>-<taskId>`, branched from `base` (branch/commit). */
  createTask(runId: string, taskId: string, base: string): Promise<TaskWorkspace>;
  /** Commits everything the agent changed in the worktree; returns the changed files. */
  commitTask(workspace: TaskWorkspace, message: string): Promise<string[]>;
  /** Merges a task branch into the integration branch; aborts and reports on conflict. */
  mergeIntoIntegration(runId: string, branch: string, message: string): Promise<WorkspaceResult>;
  /** Merges the integration branch into the branch the run started from, if the tree is clean. */
  apply(runId: string, baseBranch: string): Promise<WorkspaceResult>;
  /** Removes the run's worktrees. Branches stay, so nothing the agents did is lost. */
  cleanup(runId: string): Promise<void>;
}

// --- Service (service.ts) ---------------------------------------------------------------------

export const startRunSchema = z.object({
  objective: z.string().trim().min(1).max(ORCHESTRATOR_LIMITS.objectiveMaxLength),
  /** Defaults to every available agent. */
  agents: z.array(z.enum(ORCHESTRATOR_AGENTS)).min(1).max(3).optional(),
  maxTasks: z.number().int().min(1).max(ORCHESTRATOR_LIMITS.maxTasks).optional(),
  /** The agent that splits the objective. It must be installed, but need not take tasks.
   * Defaults to the first allowed agent in the order claude, codex, agy. */
  planner: z.enum(ORCHESTRATOR_AGENTS).optional(),
  /** Defaults to `edit`. */
  access: z.enum(ORCHESTRATOR_ACCESS).optional(),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

export type OrchestratorErrorCode =
  | 'not_found'
  | 'no_agents'
  | 'not_a_repository'
  | 'busy'
  | 'not_appliable';

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export interface OrchestratorService {
  agents(): Promise<AgentAvailability[]>;
  /**
   * Validates, records and returns the run in `planning`; the work continues in the background.
   * Rejects with `OrchestratorError`: `no_agents`, `not_a_repository`, or `busy` (one active run
   * per project).
   */
  start(input: StartRunInput): Promise<OrchestratorRun>;
  get(id: string): OrchestratorRun | undefined;
  /** Newest first. */
  list(): OrchestratorRun[];
  /** What every agent of a run printed, live or from disk. Undefined for an unknown run. */
  transcript(id: string): RunTranscript | undefined;
  /** Stops the agents of an active run. False when the run is unknown or already over. */
  cancel(id: string): boolean;
  /** Rejects with `not_found` or `not_appliable` (not `done`, already applied, dirty tree…). */
  apply(id: string): Promise<OrchestratorRun>;
  /** Cancels active runs and waits for their agents to stop. */
  close(): Promise<void>;
}
