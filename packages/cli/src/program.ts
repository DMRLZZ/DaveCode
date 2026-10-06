import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { type CliContext, type CliIO, createContext, type GlobalOptions } from './context';
import { CliError, EXIT } from './errors';

/**
 * Command tree. Keep this module light: it only declares commands and options. Every action
 * lazy-loads its implementation, so `davecode --help` never pays for SQLite, Fastify or Ink.
 */

export interface RunOptions {
  io: CliIO;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Result of an action: an exit code, or nothing for success. */
export type ActionResult = number | undefined;

interface ProgramState {
  ctx?: CliContext;
  exitCode: number;
}

export function buildProgram(options: RunOptions, state: ProgramState = { exitCode: 0 }): Command {
  const { io } = options;
  const program = new Command('davecode');

  const context = (): CliContext => {
    if (!state.ctx) throw new Error('CLI context is not initialised');
    return state.ctx;
  };

  /** Wrap a lazily loaded action: `(ctx, ...args) => exit code`. */
  const run =
    <A extends unknown[]>(action: (ctx: CliContext, ...args: A) => Promise<ActionResult>) =>
    async (...args: A) => {
      const code = await action(context(), ...args);
      if (typeof code === 'number') state.exitCode = code;
    };

  program
    .description('Local-first AI gateway and autonomous coding engine.')
    .usage('[command] [options]')
    .option('--home <dir>', 'DaveCode home directory (sets DAVECODE_HOME)')
    .option('--json', 'machine-readable JSON output where supported')
    .option('--no-color', 'disable colours (NO_COLOR is honoured too)')
    .option('-V, --version', 'print the version and exit')
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
      outputError: (text, write) => write(text),
    })
    .exitOverride()
    .hook('preAction', (_root, action) => {
      state.ctx = createContext(action.optsWithGlobals<GlobalOptions>(), io, options);
    })
    .addHelpText(
      'after',
      `
Run \`davecode\` with no command in a terminal to open the chat TUI.
Docs: https://github.com/DMRLZZ/DaveCode#readme`,
    );

  program.action(
    run(async (ctx) => {
      const globals = program.opts<GlobalOptions & { version?: boolean }>();
      if (globals.version) {
        const { VERSION } = await import('@davecode/core');
        ctx.out(`davecode ${VERSION}`);
        return EXIT.ok;
      }
      program.outputHelp();
      return EXIT.ok;
    }),
  );

  registerCommands(program, run);
  return program;
}

type Runner = <A extends unknown[]>(
  action: (ctx: CliContext, ...args: A) => Promise<ActionResult>,
) => (...args: A) => Promise<void>;

/** Parse a TCP port (0 = pick a free one). */
export function parsePort(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new InvalidArgumentError('expected a port number between 0 and 65535');
  }
  return n;
}

/** Parse a non-negative integer (priorities, weights, limits). */
export function parseInteger(value: string): number {
  const n = Number(value);
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(n) || n < 0) {
    throw new InvalidArgumentError('expected a non-negative integer');
  }
  return n;
}

/** Repeatable option collector (`--model a --model b`, also accepts `a,b`). */
export function collect(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ];
}

/** Subcommands. Each action dynamically imports its module. */
function registerCommands(program: Command, run: Runner): void {
  program
    .command('start')
    .description('start the gateway (OpenAI-compatible /v1, dashboard API and web dashboard)')
    .addOption(new Option('-p, --port <port>', 'port to listen on').argParser(parsePort))
    .option('--host <host>', 'interface to bind (default 127.0.0.1)')
    .option('--no-dashboard', 'do not serve the web dashboard')
    .option('--project <dir>', 'repository whose project brain to serve (default: detected)')
    .option('--verbose', 'print gateway request logs')
    .option('-q, --quiet', 'do not print the live activity log')
    .action(
      run(async (ctx, opts: import('./commands/start').StartOptions) => {
        const { startCommand } = await import('./commands/start');
        return startCommand(ctx, opts);
      }),
    );

  program
    .command('status')
    .description('gateway health, accounts and 1m/5h/24h quota usage')
    .action(
      run(async (ctx) => {
        const { statusCommand } = await import('./commands/status');
        return statusCommand(ctx);
      }),
    );
}

/** Render an error for humans: `error: …` plus an optional hint, without a stack trace. */
export function describeError(err: unknown): { message: string; hint?: string; exitCode: number } {
  if (err instanceof CliError) {
    return {
      message: err.message,
      exitCode: err.exitCode,
      ...(err.hint ? { hint: err.hint } : {}),
    };
  }
  if (err instanceof Error) {
    if (err.name === 'ConfigError') {
      return {
        message: err.message,
        hint: 'Fix the file above or run `davecode config path` to see where config is read from.',
        exitCode: EXIT.failure,
      };
    }
    return { message: err.message, exitCode: EXIT.failure };
  }
  return { message: String(err), exitCode: EXIT.failure };
}

/** Parse `argv` (user arguments only) and run the matching command. Resolves to an exit code. */
export async function runCli(argv: string[], options: RunOptions): Promise<number> {
  const state: ProgramState = { exitCode: 0 };
  const program = buildProgram(options, state);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return state.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version print and exit 0; usage errors were already written by commander.
      return err.exitCode;
    }
    const { message, hint, exitCode } = describeError(err);
    const theme = state.ctx?.errTheme;
    const label = theme ? theme.error('error') : 'error';
    options.io.stderr.write(`${label}: ${message}\n`);
    if (hint) options.io.stderr.write(`${theme ? theme.dim(hint) : hint}\n`);
    if (options.env.DAVECODE_DEBUG && err instanceof Error && err.stack) {
      options.io.stderr.write(`${err.stack}\n`);
    }
    return exitCode;
  }
}
