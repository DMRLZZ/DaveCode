import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Locate `command` on PATH (honouring PATHEXT on Windows, preferring `.exe` over `.cmd` shims).
 * Paths containing a separator are returned as-is when they exist.
 */
export function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isFile = (p: string) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
    return isFile(command) ? command : undefined;
  }
  const win = platform === 'win32';
  const delimiter = win ? ';' : ':';
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = win
    ? [
        '.exe',
        '.com',
        '',
        ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.toLowerCase())
          .filter((e) => e && e !== '.exe' && e !== '.com'),
      ]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Characters cmd.exe never interprets, so such arguments need no escaping. */
const SHELL_SAFE = /^[\w.:=@+\-/\\[\]]+$/;

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => {
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};

export interface InteractiveOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

/**
 * Run a command attached to this terminal (`stdio: 'inherit'`) and resolve with its exit code.
 * Windows `.cmd`/`.bat` shims (npm-installed CLIs) need a shell; their arguments must then be
 * shell-safe, which is checked rather than escaped.
 */
export function spawnInteractive(
  command: string,
  args: string[],
  options: InteractiveOptions,
): Promise<number> {
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const platform = options.platform ?? process.platform;
  const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  if (shim) {
    const unsafe = args.find((a) => !SHELL_SAFE.test(a));
    if (unsafe !== undefined) {
      return Promise.reject(
        new Error(`Argument ${JSON.stringify(unsafe)} cannot be passed safely to ${command}`),
      );
    }
  }
  return new Promise((resolve, reject) => {
    const child = shim
      ? spawn(`"${command}"`, args, {
          stdio: 'inherit',
          env: options.env,
          shell: true,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        })
      : spawn(command, args, {
          stdio: 'inherit',
          env: options.env,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}
