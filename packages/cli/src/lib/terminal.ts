import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { which } from './proc';

export type DetachedSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
};

export interface TerminalOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: DetachedSpawn;
}

/** A program and its arguments, run in a new terminal window. */
export interface TerminalCommand {
  command: string;
  args: string[];
}

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `davecode accounts login <id> --hold`, using this same Node binary and CLI entry point. */
export function loginInvocation(
  accountId: string,
  argv: readonly string[] = process.argv,
): string[] {
  if (!SAFE_ACCOUNT_ID.test(accountId)) throw new Error('Invalid account id');
  const entry = argv[1];
  if (!entry) throw new Error('Cannot locate the davecode entry point');
  return [process.execPath, entry, 'accounts', 'login', accountId, '--hold'];
}

function posixQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Linux terminal emulators and how each takes a command to run. */
const LINUX_TERMINALS: Array<{ bin: string; flag: string[] }> = [
  { bin: 'x-terminal-emulator', flag: ['-e'] },
  { bin: 'gnome-terminal', flag: ['--'] },
  { bin: 'konsole', flag: ['-e'] },
  { bin: 'xfce4-terminal', flag: ['-x'] },
  { bin: 'xterm', flag: ['-e'] },
];

/**
 * How to open `argv` in a new terminal window on this platform, or `undefined` when no
 * terminal can be opened (headless Linux, unsafe characters for cmd.exe).
 */
export function terminalCommand(
  argv: readonly string[],
  options: Pick<TerminalOptions, 'platform' | 'env'> = {},
): TerminalCommand | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32') {
    // cmd.exe expands %VAR% even inside quotes and quotes cannot be escaped, so refuse both.
    if (argv.some((a) => /["%\r\n]/.test(a))) return undefined;
    const line = argv.map((a) => `"${a}"`).join(' ');
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/c', `start "DaveCode login" ${line}`],
    };
  }
  if (platform === 'darwin') {
    const script = argv.map(posixQuote).join(' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      command: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "${script}"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
    };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return undefined;
  for (const terminal of LINUX_TERMINALS) {
    if (which(terminal.bin, env, platform)) {
      return { command: terminal.bin, args: [...terminal.flag, ...argv] };
    }
  }
  return undefined;
}

/**
 * Open a terminal window on this machine running the official vendor login for an account
 * (via `davecode accounts login`). Resolves `false` when no window could be opened.
 */
export function launchLoginTerminal(
  accountId: string,
  options: TerminalOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const target = terminalCommand(loginInvocation(accountId), options);
  if (!target) return Promise.resolve(false);
  const spawn = options.spawn ?? (nodeSpawn as unknown as DetachedSpawn);
  return new Promise((resolve) => {
    try {
      const child = spawn(target.command, target.args, {
        detached: true,
        stdio: 'ignore',
        env: options.env ?? process.env,
        ...(platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
      });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
