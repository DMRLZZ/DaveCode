import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Account,
  type AccountControl,
  type AutonomousRunner,
  createAccountControl,
  createCliAgentRunner,
  createEngine,
  createGitWorkspace,
  createGoalService,
  createOrchestratorService,
  createRunner,
  type DaveConfigInput,
  type Engine,
  type EventBus,
  type GoalService,
  type OrchestratorService,
  ProjectBrain,
  ProjectBrainSource,
  WorkspaceLock,
} from '@davecode/core';
import { type GatewayOptions, type ProjectInfo, startGateway } from '@davecode/server';
import { connectHost } from './client';
import { openBrowser } from './lib/browser';
import { launchLoginTerminal } from './lib/terminal';

export { launchLoginTerminal } from './lib/terminal';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

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
  /** Goal mode for this repository; satisfies `GoalControl`. */
  goals: GoalService;
  /** Held by the runner (`runner`) or goal mode (`goal`) while they touch the working tree. */
  lock: WorkspaceLock;
}

/**
 * Open the project brain of `root` on the engine's event bus and build its autonomous runner
 * and goal service, which share one workspace lock. The runner is created even before
 * `davecode init`: `start()`/`runOnce()` then reject with a `RunnerError` (`no_brain`,
 * `not_a_repo`...) that the CLI and the dashboard explain.
 */
export function wireProject(
  engine: Engine,
  root: string,
  options: { env?: NodeJS.ProcessEnv; name?: string } = {},
): ProjectWiring {
  const brain = new ProjectBrain(root, { events: engine.events });
  const lock = new WorkspaceLock();
  const budgetContext = () => engine.budget.context();
  return {
    brain,
    source: new ProjectBrainSource(brain, options.name),
    runner: createRunner(engine, {
      brain,
      lock: { lock, owner: 'runner' },
      contextExtras: budgetContext,
      ...(options.env ? { env: options.env } : {}),
    }),
    goals: createGoalService(engine, { brain, lock, budgetContext }),
    lock,
  };
}

// ---------------------------------------------------------------------------
// Pane orchestrator
// ---------------------------------------------------------------------------

/**
 * Where the orchestrator keeps the task worktrees of `projectDir`: under the DaveCode home,
 * outside the repository, one folder per project (first 16 hex digits of its path's SHA-256).
 */
export function orchestratorWorktreesDir(home: string, projectDir: string): string {
  const key = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 16);
  return join(home, 'worktrees', key);
}

/**
 * The pane orchestrator for `projectDir`: headless vendor CLIs (with the user's own sign-in,
 * from `env`) working in git worktrees, reporting on `events`. Throws if it cannot be built.
 */
export function createProjectOrchestrator(options: {
  projectDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  events: EventBus;
}): OrchestratorService {
  const projectDir = resolve(options.projectDir);
  return createOrchestratorService({
    projectDir,
    home: options.home,
    events: options.events,
    runner: createCliAgentRunner({ env: options.env }),
    workspace: createGitWorkspace({
      projectDir,
      worktreesDir: orchestratorWorktreesDir(options.home, projectDir),
    }),
  });
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
  /** Desktop hosts can launch official sign-in using their bundled CLI and Node runtime. */
  loginLauncher?: GatewayOptions['loginLauncher'];
  /** Programmatic config overrides. */
  config?: DaveConfigInput;
  /** Inject a pre-built engine (tests). It is closed with the runtime. */
  engine?: Engine;
  /**
   * Pane orchestrator to serve (closed with the runtime), or false for none. By default one is
   * built for the project when the gateway binds to loopback.
   */
  orchestrator?: OrchestratorService | false;
  /** Non-fatal startup problems (default: only a `log` event on the engine's bus). */
  onWarning?: (message: string) => void;
}

export interface Runtime {
  engine: Engine;
  brain: ProjectBrain | undefined;
  project: ProjectInfo | undefined;
  runner: AutonomousRunner | undefined;
  goals: GoalService | undefined;
  /** The pane orchestrator, when this runtime serves one. */
  orchestrator: OrchestratorService | undefined;
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
  let account: AccountControl | undefined;
  let orchestrator: OrchestratorService | undefined;

  try {
    const project = projectRoot
      ? wireProject(engine, projectRoot, { env: options.env })
      : undefined;
    const wantDashboard = options.dashboard !== false && engine.config.server.dashboard;
    const dashboardDir = wantDashboard ? resolveDashboardDir(options.env) : undefined;
    const bindHost = options.host ?? engine.config.server.host;
    // Only a gateway on loopback shares a screen with its user; elsewhere a login window
    // would open on a machine nobody is looking at.
    const loginLauncher = LOOPBACK_HOSTS.has(bindHost)
      ? {
          launch: async (account: Account) => ({
            launched: await launchLoginTerminal(account.id, { env: options.env }),
          }),
        }
      : undefined;

    // Same rule for the DaveCode account: the browser must open where the user is sitting.
    account = LOOPBACK_HOSTS.has(bindHost)
      ? createAccountControl({
          home: options.home,
          env: options.env,
          open: (url) => openBrowser(url),
        })
      : undefined;

    // Same rule again: the orchestrator drives the CLIs signed in on this machine. A failure to
    // build it never takes the gateway down; the routes are simply absent.
    if (options.orchestrator !== undefined) {
      orchestrator = options.orchestrator || undefined;
    } else if (projectRoot && LOOPBACK_HOSTS.has(bindHost)) {
      try {
        orchestrator = createProjectOrchestrator({
          projectDir: projectRoot,
          home: options.home,
          env: options.env,
          events: engine.events,
        });
      } catch {
        // The error may carry paths or vendor output: report that it failed, not why.
        const message = 'The pane orchestrator could not start; continuing without it.';
        engine.events.emit({ type: 'log', level: 'warn', scope: 'orchestrator', message });
        options.onWarning?.(message);
      }
    }

    const app = await startGateway(engine, {
      logger: options.logger ?? false,
      ...(account ? { account } : {}),
      ...(orchestrator ? { orchestrator } : {}),
      ...((options.loginLauncher ?? loginLauncher)
        ? { loginLauncher: options.loginLauncher ?? loginLauncher }
        : {}),
      ...(dashboardDir ? { dashboardDir } : {}),
      ...(project ? { brain: project.source, runner: project.runner, goals: project.goals } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
    });

    const address = app.server.address() as AddressInfo | null;
    const host = options.host ?? engine.config.server.host;
    const port = address?.port ?? options.port ?? engine.config.server.port;

    let closed = false;
    const runner = project?.runner;
    const goals = project?.goals;
    return {
      engine,
      brain: project?.brain,
      project: project?.source.project(),
      runner,
      goals,
      orchestrator,
      url: `http://${connectHost(host)}:${port}`,
      host,
      port,
      dashboardDir,
      async close() {
        if (closed) return;
        closed = true;
        try {
          const active = goals?.activeGoalId;
          if (active) await goals?.cancel(active);
          await runner?.stop();
          await orchestrator?.close().catch(() => undefined);
          await account?.close();
          await app.close();
        } finally {
          engine.close();
        }
      },
    };
  } catch (err) {
    await orchestrator?.close().catch(() => undefined);
    await account?.close();
    engine.close();
    throw err;
  }
}
