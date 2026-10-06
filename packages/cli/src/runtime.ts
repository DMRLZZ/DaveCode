import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEngine,
  type DaveConfigInput,
  type Engine,
  ProjectBrain,
  type TaskGraph,
} from '@davecode/core';
import {
  type BrainSource,
  type GatewayOptions,
  type ProjectInfo,
  type RunnerControl,
  startGateway,
} from '@davecode/server';
import { connectHost } from './client';

/**
 * Process wiring shared by `davecode start`, `chat` (in-process gateway) and future `run`:
 * engine + project brain + gateway + (from Phase 4) the autonomous runner.
 */

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` to the first directory with `.davecode/` or `.git`. Unlike
 * `findProjectRoot` from core, a `.davecode` directory that is the DaveCode home itself
 * (`~/.davecode`) never marks a project, so running in `~/code/foo` cannot adopt `~`.
 */
export async function detectProjectRoot(
  startDir: string,
  home: string,
): Promise<string | undefined> {
  const homeDir = resolve(home);
  let dir = resolve(startDir);
  for (;;) {
    const brainDir = join(dir, '.davecode');
    if (await exists(join(dir, '.git'))) return dir;
    if (resolve(brainDir) !== homeDir && (await exists(brainDir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// BrainSource adapter
// ---------------------------------------------------------------------------

const EMPTY_GRAPH: TaskGraph = { version: 1, tasks: [] };

/**
 * Adapts a {@link ProjectBrain} to the gateway's read-only `BrainSource`. A repository whose
 * brain has not been initialised (`davecode init`) reads as an empty graph and empty markdown
 * instead of failing; an invalid TASK_GRAPH.json still throws so the problem is visible.
 */
export function createBrainSource(brain: ProjectBrain, name = basename(brain.root)): BrainSource {
  const info: ProjectInfo = { root: brain.root, name };
  const ifExists = async <T>(path: string, read: () => Promise<T>, fallback: T): Promise<T> =>
    (await exists(path)) ? read() : fallback;
  return {
    project: () => info,
    graph: () => ifExists(brain.paths.taskGraph, () => brain.readGraph(), EMPTY_GRAPH),
    state: () => ifExists(brain.paths.state, () => brain.readState(), ''),
    architecture: () => ifExists(brain.paths.architecture, () => brain.readArchitecture(), ''),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function isDashboard(dir: string | undefined): dir is string {
  return dir !== undefined && existsSync(join(dir, 'index.html'));
}

/**
 * Locate the built dashboard (`index.html` inside), in order:
 * `DAVECODE_DASHBOARD_DIR`, an installed `@davecode/ui` package's `dist/`, a `dashboard/` folder
 * shipped next to this bundle, and the monorepo layout (`packages/ui/dist`), which resolves the
 * same from `packages/cli/dist/*.js` and `packages/cli/src/runtime.ts`.
 */
export function resolveDashboardDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string | undefined {
  const candidates: Array<() => string | undefined> = [
    () => (env.DAVECODE_DASHBOARD_DIR ? resolve(env.DAVECODE_DASHBOARD_DIR) : undefined),
    () => {
      try {
        const pkg = createRequire(moduleUrl).resolve('@davecode/ui/package.json');
        return join(dirname(pkg), 'dist');
      } catch {
        return undefined;
      }
    },
    () => fileURLToPath(new URL('./dashboard', moduleUrl)),
    () => fileURLToPath(new URL('../../ui/dist', moduleUrl)),
  ];
  for (const candidate of candidates) {
    const dir = candidate();
    if (isDashboard(dir)) return dir;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Repository to serve the project brain for (default: detected from `cwd`). */
  projectDir?: string;
  /** Skip project detection entirely. */
  noProject?: boolean;
  host?: string;
  /** `0` picks a free port. */
  port?: number;
  /** Serve the dashboard when it is built (default true, and `server.dashboard` must be on). */
  dashboard?: boolean;
  logger?: GatewayOptions['logger'];
  /** Programmatic config overrides. */
  config?: DaveConfigInput;
  /** Inject a pre-built engine (tests). It is closed with the runtime. */
  engine?: Engine;
}

export interface Runtime {
  engine: Engine;
  brain: ProjectBrain | undefined;
  project: ProjectInfo | undefined;
  runner: RunnerControl | undefined;
  /** Address to connect to, e.g. `http://127.0.0.1:4040`. */
  url: string;
  host: string;
  port: number;
  /** Absolute dashboard directory when it is being served. */
  dashboardDir: string | undefined;
  close(): Promise<void>;
}

/** Create the engine, open the project brain and start the gateway. */
export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  let projectRoot: string | undefined;
  if (!options.noProject) {
    projectRoot = options.projectDir
      ? resolve(options.cwd, options.projectDir)
      : await detectProjectRoot(options.cwd, options.home);
  }

  const engine =
    options.engine ??
    createEngine({
      home: options.home,
      env: options.env,
      ...(projectRoot ? { projectRoot } : {}),
      ...(options.config ? { config: options.config } : {}),
    });

  try {
    const brain = projectRoot
      ? new ProjectBrain(projectRoot, { events: engine.events })
      : undefined;
    const brainSource = brain ? createBrainSource(brain) : undefined;

    // INTEGRATION(phase-4): construct the AutonomousRunner here and pass it to the gateway, e.g.
    //   const runner = brain ? new AutonomousRunner({ engine, brain }) : undefined;
    // It must satisfy `RunnerControl` from @davecode/server (status/start/pause/stop; start()
    // resolves once running). `/api/runner*`, `davecode run` and the TUI pick it up from here.
    const runner: RunnerControl | undefined = undefined;

    const wantDashboard = options.dashboard !== false && engine.config.server.dashboard;
    const dashboardDir = wantDashboard ? resolveDashboardDir(options.env) : undefined;

    const app = await startGateway(engine, {
      logger: options.logger ?? false,
      ...(dashboardDir ? { dashboardDir } : {}),
      ...(brainSource ? { brain: brainSource } : {}),
      ...(runner ? { runner } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
    });

    const address = app.server.address() as AddressInfo | null;
    const host = options.host ?? engine.config.server.host;
    const port = address?.port ?? options.port ?? engine.config.server.port;

    let closed = false;
    return {
      engine,
      brain,
      project: brainSource?.project() ?? undefined,
      runner,
      url: `http://${connectHost(host)}:${port}`,
      host,
      port,
      dashboardDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await app.close();
        } finally {
          engine.close();
        }
      },
    };
  } catch (err) {
    engine.close();
    throw err;
  }
}
