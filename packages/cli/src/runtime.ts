import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AutonomousRunner,
  createEngine,
  createRunner,
  type DaveConfigInput,
  type Engine,
  ProjectBrain,
  ProjectBrainSource,
} from '@davecode/core';
import { type GatewayOptions, type ProjectInfo, startGateway } from '@davecode/server';
import { connectHost } from './client';

/**
 * Process wiring shared by `davecode start`, `chat` (in-process gateway) and `run`:
 * engine + project brain + autonomous runner + gateway.
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
// Project brain + runner
// ---------------------------------------------------------------------------

export interface ProjectWiring {
  brain: ProjectBrain;
  /** Read-only view for `/api/tasks` and `/api/brain` (missing files read as empty). */
  source: ProjectBrainSource;
  /** The Phase 4 autonomous runner for this repository; satisfies `RunnerControl`. */
  runner: AutonomousRunner;
}

/**
 * Open the project brain of `root` on the engine's event bus and build its autonomous runner.
 * The runner is created even before `davecode init`: `start()`/`runOnce()` then reject with a
 * `RunnerError` (`no_brain`, `not_a_repo`...) that the CLI and the dashboard explain.
 */
export function wireProject(
  engine: Engine,
  root: string,
  options: { env?: NodeJS.ProcessEnv; name?: string } = {},
): ProjectWiring {
  const brain = new ProjectBrain(root, { events: engine.events });
  return {
    brain,
    source: new ProjectBrainSource(brain, options.name),
    runner: createRunner(engine, { brain, ...(options.env ? { env: options.env } : {}) }),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function isDashboard(dir: string | undefined): dir is string {
  return dir !== undefined && existsSync(join(dir, 'index.html'));
}

/**
 * Locate the built dashboard (`index.html` inside), in order: `DAVECODE_DASHBOARD_DIR`, a
 * `dashboard/` folder shipped next to this bundle, the monorepo layout (`packages/ui/dist`, which
 * resolves the same from `packages/cli/dist/*.js` and `packages/cli/src/runtime.ts`) and finally
 * an installed `@davecode/ui` package's `dist/` (`lookupPackage: false` skips that step).
 */
export function resolveDashboardDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
  lookupPackage = true,
): string | undefined {
  const candidates: Array<() => string | undefined> = [
    () => (env.DAVECODE_DASHBOARD_DIR ? resolve(env.DAVECODE_DASHBOARD_DIR) : undefined),
    () => fileURLToPath(new URL('./dashboard', moduleUrl)),
    () => fileURLToPath(new URL('../../ui/dist', moduleUrl)),
    () => {
      if (!lookupPackage) return undefined;
      try {
        const pkg = createRequire(moduleUrl).resolve('@davecode/ui/package.json');
        return join(dirname(pkg), 'dist');
      } catch {
        return undefined;
      }
    },
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
  /** Skip project detection entirely (no brain, no runner). */
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
  runner: AutonomousRunner | undefined;
  /** Address to connect to, e.g. `http://127.0.0.1:4040`. */
  url: string;
  host: string;
  port: number;
  /** Absolute dashboard directory when it is being served. */
  dashboardDir: string | undefined;
  /** Stop the runner (safely parking any task), the gateway and the engine. */
  close(): Promise<void>;
}

/** Resolve the project root for `projectDir` (relative to `cwd`) or detect it from `cwd`. */
export async function resolveProjectRoot(
  options: Pick<RuntimeOptions, 'cwd' | 'home' | 'projectDir' | 'noProject'>,
): Promise<string | undefined> {
  if (options.noProject) return undefined;
  return options.projectDir
    ? resolve(options.cwd, options.projectDir)
    : detectProjectRoot(options.cwd, options.home);
}

/** Create the engine, open the project brain and runner, and start the gateway. */
export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const projectRoot = await resolveProjectRoot(options);
  const engine =
    options.engine ??
    createEngine({
      home: options.home,
      env: options.env,
      ...(projectRoot ? { projectRoot } : {}),
      ...(options.config ? { config: options.config } : {}),
    });

  try {
    const project = projectRoot
      ? wireProject(engine, projectRoot, { env: options.env })
      : undefined;
    const wantDashboard = options.dashboard !== false && engine.config.server.dashboard;
    const dashboardDir = wantDashboard ? resolveDashboardDir(options.env) : undefined;

    const app = await startGateway(engine, {
      logger: options.logger ?? false,
      ...(dashboardDir ? { dashboardDir } : {}),
      ...(project ? { brain: project.source, runner: project.runner } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
    });

    const address = app.server.address() as AddressInfo | null;
    const host = options.host ?? engine.config.server.host;
    const port = address?.port ?? options.port ?? engine.config.server.port;

    let closed = false;
    const runner = project?.runner;
    return {
      engine,
      brain: project?.brain,
      project: project?.source.project(),
      runner,
      url: `http://${connectHost(host)}:${port}`,
      host,
      port,
      dashboardDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await runner?.stop();
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
