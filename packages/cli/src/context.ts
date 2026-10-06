import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Theme, themeFor } from './ui/theme';

/** Minimal writable surface the CLI prints to (process streams in production, buffers in tests). */
export interface OutStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface InStream {
  isTTY?: boolean;
}

export interface CliIO {
  stdout: OutStream;
  stderr: OutStream;
  stdin: InStream;
}

/** Options shared by every command (`--home`, `--json`, `--no-color`). */
export interface GlobalOptions {
  home?: string;
  json?: boolean;
  color?: boolean;
}

/** Everything a command needs; built once per invocation from the global flags. */
export interface CliContext {
  /** Effective environment (`DAVECODE_HOME` reflects `--home`). */
  env: NodeJS.ProcessEnv;
  /** Resolved DaveCode home. */
  home: string;
  cwd: string;
  json: boolean;
  theme: Theme;
  /** Theme for stderr (it can be a TTY while stdout is piped). */
  errTheme: Theme;
  io: CliIO;
  /** Both stdin and stdout are terminals and `--json` is off. */
  interactive: boolean;
  /** Terminal width (80 when unknown). */
  columns: number;
  /** Print a line to stdout. */
  out(line?: string): void;
  /** Print a line to stderr. */
  err(line?: string): void;
}

export function resolveHome(env: NodeJS.ProcessEnv, flag?: string, cwd = process.cwd()): string {
  if (flag) return resolve(cwd, flag);
  return env.DAVECODE_HOME ? resolve(cwd, env.DAVECODE_HOME) : join(homedir(), '.davecode');
}

export function createContext(
  options: GlobalOptions,
  io: CliIO,
  base: { env: NodeJS.ProcessEnv; cwd: string },
): CliContext {
  const home = resolveHome(base.env, options.home, base.cwd);
  const env = { ...base.env, DAVECODE_HOME: home };
  const json = options.json === true;
  const theme = themeFor(env, io.stdout, json ? false : options.color);
  const errTheme = themeFor(env, io.stderr, options.color);
  return {
    env,
    home,
    cwd: base.cwd,
    json,
    theme,
    errTheme,
    io,
    interactive: io.stdin.isTTY === true && io.stdout.isTTY === true && !json,
    columns: io.stdout.columns && io.stdout.columns > 0 ? io.stdout.columns : 80,
    out: (line = '') => {
      io.stdout.write(`${line}\n`);
    },
    err: (line = '') => {
      io.stderr.write(`${line}\n`);
    },
  };
}

/** Print a value as pretty JSON on stdout (the `--json` contract). */
export function printJson(ctx: CliContext, value: unknown): void {
  ctx.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
