import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type ProjectBrain, summarize, type TaskGraph, VERSION } from '@davecode/core';
import { findGateway } from '../client';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { formatEventLine, runtimeWarnings, summarizeAccounts } from '../lib/summary';
import { detectProjectRoot, type Runtime, startRuntime } from '../runtime';
import { padEnd } from '../ui/format';

export interface StartOptions {
  port?: number;
  host?: string;
  /** commander's `--no-dashboard` sets this to false. */
  dashboard?: boolean;
  project?: string;
  verbose?: boolean;
  quiet?: boolean;
}

export interface StartDeps {
  /** Resolves when the gateway should stop (default: SIGINT/SIGTERM). */
  until?: (runtime: Runtime) => Promise<void>;
}

async function readGraphQuietly(brain: ProjectBrain): Promise<TaskGraph | undefined> {
  try {
    return (await brain.isInitialised()) ? await brain.readGraph() : undefined;
  } catch {
    return undefined;
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

export async function startCommand(
  ctx: CliContext,
  opts: StartOptions,
  deps: StartDeps = {},
): Promise<number> {
  const started = performance.now();
  const projectRoot = opts.project
    ? resolve(ctx.cwd, opts.project)
    : await detectProjectRoot(ctx.cwd, ctx.home);
  if (projectRoot && opts.project && !existsSync(projectRoot)) {
    throw new CliError(`Project directory not found: ${projectRoot}`);
  }
  const config = loadConfig({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
  });
  const port = opts.port ?? config.server.port;

  if (port !== 0) {
    const running = await findGateway(config, { port }).catch(() => undefined);
    if (running) {
      throw new CliError(`A DaveCode gateway is already running at ${running.client.baseUrl}`, {
        hint: 'Use `davecode status` to inspect it, or pick another port with --port.',
      });
    }
  }

  let runtime: Runtime;
  try {
    runtime = await startRuntime({
      home: ctx.home,
      env: ctx.env,
      cwd: ctx.cwd,
      ...(projectRoot ? { projectDir: projectRoot } : { noProject: true }),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      port,
      dashboard: opts.dashboard !== false,
      ...(opts.verbose ? { logger: { level: config.logLevel } } : {}),
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new CliError(`Port ${port} is already in use`, {
        hint: 'Stop the other process or choose a port: davecode start --port 4041',
      });
    }
    if (code === 'EACCES') {
      throw new CliError(`Permission denied binding ${opts.host ?? config.server.host}:${port}`, {
        hint: 'Use a port above 1024 or another --host.',
      });
    }
    throw err;
  }

  const { engine } = runtime;
  const accounts = engine.accounts.list();
  const warnings = runtimeWarnings(engine.config, runtime.host);
  const graph = runtime.brain ? await readGraphQuietly(runtime.brain) : undefined;

  if (ctx.json) {
    printJson(ctx, {
      status: 'running',
      version: VERSION,
      url: runtime.url,
      api: `${runtime.url}/v1`,
      dashboard: runtime.dashboardDir ? `${runtime.url}/` : null,
      project: runtime.project ?? null,
      accounts: accounts.length,
      warnings,
    });
  } else {
    const { theme } = ctx;
    const ms = Math.round(performance.now() - started);
    const row = (label: string, value: string) =>
      ctx.out(`  ${theme.dim(padEnd(label, 10))} ${value}`);
    ctx.out();
    ctx.out(
      `  ${theme.bold(theme.accent('DaveCode'))} ${theme.dim(`v${VERSION} · ready in ${ms}ms`)}`,
    );
    ctx.out();
    row('API', theme.accent(`${runtime.url}/v1`));
    row(
      'Dashboard',
      runtime.dashboardDir
        ? theme.accent(`${runtime.url}/`)
        : theme.dim(
            opts.dashboard === false || !engine.config.server.dashboard
              ? 'disabled'
              : 'not built (pnpm --filter @davecode/ui build)',
          ),
    );
    row('Events', theme.dim(`${runtime.url}/api/events`));
    if (runtime.project) {
      const done = graph ? summarize(graph) : undefined;
      const progress = done
        ? theme.dim(` · ${done.counts.SUCCESS}/${done.total} tasks done`)
        : theme.dim(' · no brain yet (davecode init)');
      row('Project', `${runtime.project.name}${progress}`);
      if (runtime.runner) {
        row(
          'Runner',
          `${runtime.runner.status().state}${theme.dim(' · start it from the dashboard or with `davecode run`')}`,
        );
      }
    } else {
      row('Project', theme.dim('none (run inside a git repository)'));
    }
    row(
      'Accounts',
      accounts.length > 0
        ? summarizeAccounts(accounts)
        : theme.warn('none yet: run `davecode accounts add`'),
    );
    for (const warning of warnings) ctx.out(`  ${theme.warn(`${theme.glyph.warn} ${warning}`)}`);
    ctx.out();
    ctx.out(theme.dim('  Press Ctrl+C to stop.'));
    ctx.out();
  }

  let unsubscribe: (() => void) | undefined;
  if (!ctx.json && !opts.quiet && !opts.verbose) {
    const labelOf = (id: string) => engine.accounts.get(id)?.label ?? id;
    unsubscribe = engine.events.subscribe((event) => {
      const line = formatEventLine(ctx.theme, event, labelOf);
      if (line) ctx.out(`  ${line}`);
    });
  }

  await (deps.until ?? waitForSignal)(runtime);
  unsubscribe?.();
  if (!ctx.json) ctx.out(ctx.theme.dim('  Stopping DaveCode…'));
  await runtime.close();
  return EXIT.ok;
}
