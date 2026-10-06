/** Wires an {@link AutonomousRunner} from a core {@link Engine}: the entry point for the CLI. */
import { GlobalBrain } from '../brain/global';
import type { ProjectBrain } from '../brain/project';
import type { Engine } from '../engine';
import { ClaudeCliExecutor } from './claude-cli-executor';
import { BuiltinExecutor, type Executor } from './executor';
import { Git } from './git';
import { createJudge, type Judge } from './judge';
import { AutonomousRunner, type RunnerConfig } from './runner';
import { Validator } from './validator';

type EngineDeps = Pick<Engine, 'config' | 'router' | 'accounts' | 'sandboxes' | 'events' | 'paths'>;

/** Builds the executor selected by `runner.executor`. */
export function createExecutor(engine: Omit<EngineDeps, 'events' | 'paths'>): Executor {
  const cfg: RunnerConfig = engine.config.runner;
  if (cfg.executor === 'claude-cli') {
    return new ClaudeCliExecutor({
      accounts: engine.accounts,
      sandboxes: engine.sandboxes,
      allowedTools: cfg.claudeCli.allowedTools,
      timeoutMs: cfg.claudeCli.timeoutMs,
      maxTaskTokens: cfg.maxTaskTokens,
      ...(cfg.claudeCli.accountId ? { accountId: cfg.claudeCli.accountId } : {}),
      ...(cfg.claudeCli.model ? { model: cfg.claudeCli.model } : {}),
    });
  }
  return new BuiltinExecutor({
    router: engine.router,
    route: cfg.route,
    maxIterations: cfg.maxIterations,
    maxTaskTokens: cfg.maxTaskTokens,
    allowedCommands: cfg.allowedCommands,
    commandTimeoutMs: cfg.commandTimeoutMs,
  });
}

export interface CreateRunnerOptions {
  /** Brain of the repository to work on (construct it with `{ events: engine.events }`). */
  brain: ProjectBrain;
  /** Global brain (default: `~/.davecode/brain`); `false` to leave it out of the context. */
  global?: GlobalBrain | false;
  /** Override the executor chosen by `runner.executor`. */
  executor?: Executor;
  /** Override the judge chosen by `runner.judge`. */
  judge?: Judge;
  /** Environment for the judge's API key lookup (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/** An {@link AutonomousRunner} for `brain.root` using the engine's config, router and events. */
export function createRunner(engine: EngineDeps, opts: CreateRunnerOptions): AutonomousRunner {
  const cfg = engine.config.runner;
  const global =
    opts.global === false ? undefined : (opts.global ?? new GlobalBrain(engine.paths.brain));
  return new AutonomousRunner({
    brain: opts.brain,
    config: cfg,
    executor: opts.executor ?? createExecutor(engine),
    judge:
      opts.judge ??
      createJudge(cfg.judge, {
        router: engine.router,
        defaultRoute: cfg.route,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }),
    validator: new Validator({
      root: opts.brain.root,
      commands: cfg.validate,
      timeoutMs: cfg.commandTimeoutMs,
    }),
    git: new Git(opts.brain.root),
    events: engine.events,
    ...(global ? { global } : {}),
  });
}
