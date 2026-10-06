import type { RunnerStatus, TaskGraph } from '@davecode/core';

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
}

/**
 * Control surface of the autonomous runner (Phase 4) used by `/api/runner*`.
 * `start()` must resolve once the runner has started, not when it finishes.
 */
export interface RunnerControl {
  status(): RunnerStatus;
  start(): void | Promise<void>;
  pause(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface GatewayOptions {
  /** Fastify logging: `false` (default), `true`, or `{ level }`. Bearer tokens are redacted. */
  logger?: boolean | { level?: string };
  /** Built dashboard to serve with SPA fallback (ignored when `server.dashboard` is false). */
  dashboardDir?: string;
  brain?: BrainSource;
  runner?: RunnerControl;
  /** SSE heartbeat interval for `/api/events` (default 15 000 ms). */
  heartbeatMs?: number;
  /** Extra CORS origins on top of the Vite dev server (`http://localhost:5173`). */
  corsOrigins?: string[];
}

export interface StartGatewayOptions extends GatewayOptions {
  /** Override `server.host`. */
  host?: string;
  /** Override `server.port` (0 picks a free port). */
  port?: number;
}
