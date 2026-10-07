/**
 * Safe child-process helpers for the autonomous runner: quote-aware command splitting, PATH
 * resolution with Windows `.cmd` shim rules, and bounded (tail-first) output capture.
 * Nothing here ever goes through a shell with untrusted text.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { isShellSafeArg, needsShell, resolveOnPath } from '../providers/shared/cli';

/** Thrown when a command cannot be parsed or would be unsafe to start. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * Splits a command line into argv. Supports single quotes (literal), double quotes (with `\"`
 * and `\\` escapes) and backslash escapes of whitespace and quotes outside quotes. Backslashes
 * before any other character are kept, so Windows paths survive. No globbing, no variables,
 * no operators: `&&`, `|` or `>` are ordinary arguments.
 */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        current += command[i + 1];
        i++;
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inArg = true;
      continue;
    }
    if (ch === '\\' && /[\s"'\\]/.test(command[i + 1] ?? '')) {
      current += command[i + 1];
      inArg = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
      continue;
    }
    current += ch;
    inArg = true;
  }
  if (quote) throw new CommandError(`Unterminated ${quote} quote in command: ${command}`);
  if (inArg) args.push(current);
  return args;
}

/**
 * Keeps the last `max` characters of `text` (the end of a log is where the error usually is),
 * prefixed with a marker saying how much was dropped.
 */
export function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[… ${dropped} earlier characters truncated]\n${text.slice(-max)}`;
}

/** Keeps the first `max` characters of `text`, with a trailing marker. */
export function truncateHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters truncated]`;
}

/** PATH with `<cwd>/node_modules/.bin` first, so project-local tools resolve. */
export function projectEnv(cwd: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const bin = path.join(cwd, 'node_modules', '.bin');
  env[key] = env[key] ? `${bin}${path.delimiter}${env[key]}` : bin;
  return env;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Kill the process tree after this many milliseconds. */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Characters of stdout/stderr retained (tail). Default 64 KiB each. */
  maxOutputChars?: number;
  stdin?: string;
}

export interface ProcessResult {
  /** Exit code, or `null` when killed or not started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      // The child leads its own process group (detached), so this also reaches grandchildren.
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Appends to a rolling buffer that never grows far beyond `max` characters. */
class TailBuffer {
  private text = '';
  private dropped = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.max * 2) {
      const cut = this.text.length - this.max;
      this.dropped += cut;
      this.text = this.text.slice(cut);
    }
  }
  toString(): string {
    const full = this.text.length > this.max ? this.text.slice(-this.max) : this.text;
    const dropped = this.dropped + (this.text.length - full.length);
    return dropped > 0 ? `[… ${dropped} earlier characters truncated]\n${full}` : full;
  }
}

/**
 * Resolves `command` through PATH (`env`), and decides how to start it. Windows `.cmd`/`.bat`
 * shims need cmd.exe, so for those every argument must be trivially shell-safe; anything else
 * is refused rather than escaped (mirrors `providers/shared/cli.ts`).
 */
export function prepareCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; shell: boolean } {
  const resolved = resolveOnPath(command, env);
  if (!needsShell(resolved)) return { file: resolved, args, shell: false };
  const unsafe = args.find((a) => !isShellSafeArg(a));
  if (unsafe !== undefined || /["%!^&|<>]/.test(resolved)) {
    throw new CommandError(
      `Refusing to run "${command}" through the Windows shell with argument ${JSON.stringify(
        unsafe ?? resolved,
      )}: only letters, digits and . : = @ + - / \\ [ ] are allowed for .cmd shims`,
    );
  }
  const file = isShellSafeArg(resolved) ? resolved : `"${resolved}"`;
  return { file: [file, ...args].join(' '), args: [], shell: true };
}

/** Runs a process without a shell (except vetted `.cmd` shims), with timeout and abort. */
export function runProcess(opts: RunProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const max = opts.maxOutputChars ?? 64 * 1024;
  const env = opts.env ?? process.env;
  const stdout = new TailBuffer(max);
  const stderr = new TailBuffer(max);

  return new Promise<ProcessResult>((resolvePromise) => {
    let prepared: ReturnType<typeof prepareCommand>;
    try {
      prepared = prepareCommand(opts.command, opts.args, env);
    } catch (err) {
      resolvePromise({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        timedOut: false,
        aborted: false,
      });
      return;
    }
    if (opts.signal?.aborted) {
      resolvePromise({
        exitCode: null,
        stdout: '',
        stderr: 'aborted before start',
        durationMs: 0,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    const child = spawn(prepared.file, prepared.args, {
      cwd: opts.cwd,
      env,
      shell: prepared.shell,
      // POSIX: own process group so a timeout kills the whole tree (see killTree).
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let aborted = false;
    let settled = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => stdout.push(d));
    child.stderr?.on('data', (d: string) => stderr.push(d));
    child.stdin?.on('error', () => {
      // the child exited before reading stdin
    });
    child.stdin?.end(opts.stdin ?? '');

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (extraErr) stderr.push(extraErr);
      resolvePromise({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
      });
    };
    child.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(null, `failed to start "${opts.command}": ${code ?? err.message}`);
    });
    child.once('close', (code) => finish(timedOut || aborted ? null : code));
  });
}
