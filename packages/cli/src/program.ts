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

  registerAccounts(program, run);
  registerProject(program, run);
}

function registerProject(program: Command, run: Runner): void {
  program
    .command('init')
    .description('scaffold the project brain (.davecode/) in this repository')
    .option('--name <name>', 'project name used in STATE.md and ARCHITECTURE.md')
    .option('--config', 'write a starter .davecode/config.json without asking')
    .option('--no-config', 'do not write .davecode/config.json')
    .action(
      run(async (ctx, opts: { name?: string; config?: boolean }) => {
        const { initCommand } = await import('./commands/init');
        return initCommand(ctx, opts);
      }),
    );

  const tasks = program.command('tasks').description('show and edit the task graph');
  tasks
    .command('list', { isDefault: true })
    .alias('ls')
    .description('task tree with status and blocked reasons')
    .action(
      run(async (ctx) => {
        const { tasksList } = await import('./commands/tasks');
        return tasksList(ctx);
      }),
    );
  tasks
    .command('next')
    .description('the task the runner would pick next')
    .action(
      run(async (ctx) => {
        const { tasksNext } = await import('./commands/tasks');
        return tasksNext(ctx);
      }),
    );
  tasks
    .command('add <id> <title...>')
    .description('add a PENDING task')
    .option('-d, --depends <ids>', 'dependencies (repeatable or comma-separated)', collect)
    .addOption(new Option('-p, --priority <n>', 'higher runs first').argParser(parseInteger))
    .option('--description <text>', 'longer description')
    .option(
      '-a, --acceptance <criterion>',
      'acceptance criterion (repeatable)',
      (v, prev: string[] = []) => [...prev, v],
    )
    .action(
      run(
        async (
          ctx,
          id: string,
          title: string[],
          opts: import('./commands/tasks').AddTaskOptions,
        ) => {
          const { tasksAdd } = await import('./commands/tasks');
          return tasksAdd(ctx, id, title, opts);
        },
      ),
    );
  tasks
    .command('status <id> <status>')
    .description('move a task to PENDING | IN_PROGRESS | SUCCESS | FAILED')
    .option('--notes <text>', 'note stored on the task')
    .action(
      run(async (ctx, id: string, status: string, opts: { notes?: string }) => {
        const { tasksStatus } = await import('./commands/tasks');
        return tasksStatus(ctx, id, status, opts);
      }),
    );

  const config = program.command('config').description('show the resolved configuration');
  config
    .command('show', { isDefault: true })
    .description('resolved config as JSON (secrets redacted)')
    .action(
      run(async (ctx) => {
        const { configShow } = await import('./commands/config');
        return configShow(ctx);
      }),
    );
  config
    .command('path')
    .description('where config, state and brains live')
    .action(
      run(async (ctx) => {
        const { configPath } = await import('./commands/config');
        return configPath(ctx);
      }),
    );
  config
    .command('get <key>')
    .description('one value by dotted key, e.g. server.port')
    .action(
      run(async (ctx, key: string) => {
        const { configGet } = await import('./commands/config');
        return configGet(ctx, key);
      }),
    );
}

type AddOpts = import('./commands/accounts').AddCommandFlags;

function addAccountOptions(command: Command, run: Runner): Command {
  return command
    .option(
      '--provider <kind>',
      'anthropic | openai | gemini | openai-compatible | claude-cli | codex-cli | gemini-web',
    )
    .option('--label <name>', 'human-friendly name')
    .addOption(
      new Option('--priority <n>', 'lower is tried first (default 100)').argParser(parseInteger),
    )
    .addOption(
      new Option('--weight <n>', 'traffic share among equal priorities').argParser(parseInteger),
    )
    .option('--secret-env <var>', 'read the API key from this environment variable')
    .option('--secret-stdin', 'read the API key from stdin')
    .option('--secret <value>', 'API key (discouraged: visible in shell history)')
    .option('--base-url <url>', 'endpoint for openai-compatible accounts')
    .option('--model <id>', 'advertised model (repeatable or comma-separated)', collect)
    .option('--default-model <id>', 'model used for davecode/auto without a route')
    .option('--binary-path <path>', 'CLI binary for claude-cli / codex-cli')
    .option('--limit <key=value>', 'quota limit, e.g. tokens5h=500000 (repeatable)', collect)
    .option('--disabled', 'add the account disabled')
    .option('-y, --yes', 'never prompt: take everything from flags')
    .option('--no-login', 'do not offer to log in after adding a CLI account')
    .option('--local', 'write to the local database even if a gateway is running')
    .addHelpText(
      'after',
      `
Examples:
  davecode accounts add                                   # interactive
  davecode accounts add --provider anthropic --label work --secret-env ANTHROPIC_API_KEY --yes
  echo "$OPENROUTER_KEY" | davecode accounts add --provider openai-compatible \\
      --base-url https://openrouter.ai/api/v1 --model openai/gpt-5.5 --secret-stdin
  davecode accounts add --provider claude-cli --label "Claude Pro" --yes`,
    )
    .action(
      run(async (ctx, opts: AddOpts) => {
        const { accountsAdd } = await import('./commands/accounts');
        return accountsAdd(ctx, opts);
      }),
    );
}

function registerAccounts(program: Command, run: Runner): void {
  const accounts = program.command('accounts').description('manage provider accounts');

  accounts
    .command('list', { isDefault: true })
    .alias('ls')
    .description('list accounts')
    .option('--local', 'read the local database even if a gateway is running')
    .action(
      run(async (ctx, opts: { local?: boolean }) => {
        const { accountsList } = await import('./commands/accounts');
        return accountsList(ctx, opts);
      }),
    );

  addAccountOptions(
    accounts.command('add').description('add an account (interactive in a terminal)'),
    run,
  );

  accounts
    .command('remove <id>')
    .alias('rm')
    .description('remove an account, its secret and its sandbox')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--local', 'write to the local database even if a gateway is running')
    .action(
      run(async (ctx, id: string, opts: { yes?: boolean; local?: boolean }) => {
        const { accountsRemove } = await import('./commands/accounts');
        return accountsRemove(ctx, id, opts);
      }),
    );

  for (const [name, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    accounts
      .command(`${name} <id>`)
      .description(`${name} an account${enabled ? ' (also clears error and cooldown state)' : ''}`)
      .option('--local', 'write to the local database even if a gateway is running')
      .action(
        run(async (ctx, id: string, opts: { local?: boolean }) => {
          const { accountsSetEnabled } = await import('./commands/accounts');
          return accountsSetEnabled(ctx, id, enabled, opts);
        }),
      );
  }

  accounts
    .command('login <id> [args...]')
    .description('log a claude-cli / codex-cli account in, inside its own isolated config dir')
    .allowUnknownOption()
    .option('--local', 'read the local database even if a gateway is running')
    .addHelpText(
      'after',
      `
Launches the real CLI with CLAUDE_CONFIG_DIR / CODEX_HOME pointing at the account's sandbox,
so every account keeps a separate login. Extra arguments after -- replace the default ones.`,
    )
    .action(
      run(async (ctx, id: string, args: string[], opts: { local?: boolean }) => {
        const { accountsLogin } = await import('./commands/accounts');
        return accountsLogin(ctx, id, args, opts);
      }),
    );

  addAccountOptions(program.command('add-account').description('alias of `accounts add`'), run);
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
