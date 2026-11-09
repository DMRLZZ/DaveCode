import type {
  Account,
  AccountControl,
  ChangesService,
  ClearableTaskField,
  Goal,
  GoalArtifact,
  LoginService,
  NewTask,
  OrchestratorService,
  RunnerStatus,
  TaskGraph,
  TaskNode,
  TaskPatch,
} from '@davecode/core';

/** Repository the project brain belongs to. */
export interface ProjectInfo {
  root: string;
  name: string;
}

/**
 * Read-only view of the dual brain (Phase 3) used by `GET /api/tasks` and `GET /api/brain`.
 * Structural so any implementation can be passed without importing it here.
 */
export interface BrainSource {
  project(): ProjectInfo | null;
  graph(): Promise<TaskGraph>;
  /** `<repo>/.davecode/STATE.md` markdown. */
  state(): Promise<string>;
  /** `<repo>/.davecode/ARCHITECTURE.md` markdown. */
  architecture(): Promise<string>;
  /**
   * Task graph writes (`POST/PATCH/DELETE /api/tasks`). Optional: a source without them is
   * read-only and the endpoints answer `501 brain_read_only`. Implementations validate the graph
   * and throw `TaskGraphError` (core's `ProjectBrain` does, under its lock).
   */
  createTask?(input: NewTask): Promise<TaskNode>;
  updateTask?(
    id: string,
    patch: TaskPatch,
    opts?: { clear?: readonly ClearableTaskField[] },
  ): Promise<TaskNode>;
  removeTask?(id: string): Promise<TaskNode>;
}

/**
 * Control surface of the autonomous runner (Phase 4) used by `/api/runner*`.
 * `start()` must resolve once the runner has started, not when it finishes.
 */
export interface RunnerControl {
  status(): RunnerStatus;
  /** With `taskId`, work on that task first instead of the runner's own pick. */
  start(opts?: { taskId?: string }): void | Promise<void>;
  pause(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** Body of `POST /api/goals` once validated. */
export interface GoalStartInput {
  objective: string;
  maxRounds?: number;
  maxTasks?: number;
  maxTokens?: number;
  dryRun?: boolean;
}

/**
 * Goal mode control surface used by `/api/goals*` (core's `GoalService` satisfies it).
 * `start()` resolves with the new goal while it keeps running in the background.
 * Refusals throw errors carrying `statusCode` and `code` (e.g. 409 `busy`).
 */
export interface GoalControl {
  list(): Promise<Goal[]>;
  get(id: string): Promise<Goal | undefined>;
  start(input: GoalStartInput): Promise<Goal>;
  /** Executes a `planned` (dry-run) goal in the background without re-planning. */
  execute?(id: string): Promise<Goal>;
  /** Reads a task's markdown artifact content. */
  readArtifact?(id: string, taskId: string): Promise<GoalArtifact>;
  /** Resolves with the goal once it has stopped. */
  cancel(id: string): Promise<Goal>;
}

/**
 * Opens the vendor's official login for a `cli-login` account somewhere the user can finish
 * it (a terminal window on the gateway machine). Inject it only when the gateway and the user
 * share a machine; without it `POST /api/accounts/:id/connect` returns the command to run.
 */
export interface LoginLauncher {
  launch(account: Account): Promise<{ launched: boolean }>;
}

export interface GatewayOptions {
  /** Explicit OAuth service, or false to ignore login environment variables (tests/embedding). */
  login?: LoginService | false;
  /** Fastify logging: `false` (default), `true`, or `{ level }`. Bearer tokens are redacted. */
  logger?: boolean | { level?: string };
  /** Built dashboard to serve with SPA fallback (ignored when `server.dashboard` is false). */
  dashboardDir?: string;
  brain?: BrainSource;
  runner?: RunnerControl;
  goals?: GoalControl;
  /** "Connect subscription" launcher for CLI-login accounts. */
  loginLauncher?: LoginLauncher;
  /** The machine's DaveCode account. Inject it only when the gateway and the user share one. */
  account?: AccountControl;
  /**
   * Pane orchestrator for the served project (`/api/orchestrator/*`). Inject it only when the
   * gateway and the user share a machine: it drives the vendor CLIs the user is signed in to.
   */
  orchestrator?: OrchestratorService;
  /**
   * Changes review for the served project (`/api/changes/*`): isolated pane worktrees, diffs and
   * commit, push and pull request. Inject it only when the gateway and the user share a machine.
   */
  changes?: ChangesService;
  /** SSE heartbeat interval for `/api/events` (default 15 000 ms). */
  heartbeatMs?: number;
  /** Bind address, used to decide which Host headers are expected (set by `startGateway`). */
  host?: string;
  /** Dev mode: also trust the Vite dev server origins (`http://localhost:5173`). Off by default. */
  dev?: boolean;
  /** Extra origins allowed to call the gateway from a browser, with CORS and on state changes. */
  corsOrigins?: string[];
}

export interface StartGatewayOptions extends GatewayOptions {
  /** Override `server.host`. */
  host?: string;
  /** Override `server.port` (0 picks a free port). */
  port?: number;
}
