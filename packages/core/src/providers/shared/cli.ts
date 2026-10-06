/** Child-process helpers shared by the `claude-cli` and `codex-cli` adapters. */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ProviderError } from '../../errors';
import type {
  ChatMessage,
  ProviderCallContext,
  ProviderErrorKind,
  ProviderKind,
} from '../../types';
import { classifyMessage } from './errors';
import { parseNdjson } from './lines';
import { contentToText } from './util';

const MAX_STDERR = 64 * 1024;

export interface CliSettings {
  /** Resolved command to execute. */
  command: string;
  /** Arguments that always precede the adapter's own (e.g. `['fake-cli.js']` for `node`). */
  prefixArgs: string[];
}

/** Read `config.binaryPath` / `config.binaryArgs`. */
export function cliSettings(ctx: ProviderCallContext, defaultBinary: string): CliSettings {
  const binary = ctx.account.config.binaryPath;
  const args = ctx.account.config.binaryArgs;
  return {
    command: typeof binary === 'string' && binary.trim() ? binary.trim() : defaultBinary,
    prefixArgs: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
  };
}

/** Resolve a bare command name through PATH (honouring PATHEXT on Windows). */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) return command;
  const win = process.platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = win
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
    : [''];
  // Prefer real executables over .cmd shims on Windows so no shell is needed.
  const ordered = win ? [...exts].sort((a, b) => rank(a) - rank(b)) : exts;
  for (const dir of dirs) {
    for (const ext of ordered) {
      const candidate = path.join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return command;
}

function rank(ext: string): number {
  if (ext === '.exe' || ext === '.com') return 0;
  if (ext === '') return 1;
  return 2;
}

/** True when the command is a Windows batch shim that cannot be spawned without a shell. */
export function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * Characters that cmd.exe never interprets. Deliberately excludes `%` and `!` (variable
 * expansion), quotes, whitespace and every operator, so no escaping is ever needed.
 */
const SHELL_SAFE = /^[\w.:=@+\-/\\[\]]+$/;

/** True when `arg` can be passed through cmd.exe verbatim. */
export function isShellSafeArg(arg: string): boolean {
  return SHELL_SAFE.test(arg);
}

/** Quote the resolved binary path (it may contain spaces); arguments must already be safe. */
function quoteCommand(path: string): string {
  return isShellSafeArg(path) ? path : `"${path}"`;
}

export interface CliRunOptions {
  provider: ProviderKind;
  accountId: string;
  settings: CliSettings;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  signal?: AbortSignal;
}

export interface CliExit {
  code: number | null;
  stderr: string;
  /** True when the process was killed because the caller aborted. */
  aborted: boolean;
}

export interface CliRun {
  /** Parsed NDJSON events from stdout. */
  events: AsyncGenerator<unknown>;
  /** Resolves once the process has exited (after stdout is drained). */
  exit: Promise<CliExit>;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/** Spawn a CLI, feed `stdin`, and expose its stdout as NDJSON events. */
export function runCli(opts: CliRunOptions): CliRun {
  mkdirSync(opts.cwd, { recursive: true });
  const resolved = resolveOnPath(opts.settings.command);
  const shell = needsShell(resolved);
  const args = [...opts.settings.prefixArgs, ...opts.args];
  const env = { ...process.env, ...opts.env };

  const fail = (message: string, cause?: unknown): ProviderError =>
    new ProviderError(message, {
      kind: 'unavailable',
      provider: opts.provider,
      accountId: opts.accountId,
      cause,
    });

  if (opts.signal?.aborted) {
    throw new ProviderError(`${opts.provider} request aborted`, {
      kind: 'timeout',
      provider: opts.provider,
      accountId: opts.accountId,
    });
  }

  if (shell) {
    // cmd.exe quoting cannot neutralise %VAR% expansion, so refuse anything that is not
    // trivially safe (e.g. a client-supplied model name) instead of trying to escape it.
    const unsafe = args.some((arg) => !isShellSafeArg(arg));
    if (unsafe || /["%!]/.test(resolved)) {
      throw new ProviderError(
        `${opts.provider}: refusing to pass an unsafe argument through the Windows shell`,
        { kind: 'bad_request', provider: opts.provider, accountId: opts.accountId },
      );
    }
  }

  const child = shell
    ? spawn(`${quoteCommand(resolved)} ${args.join(' ')}`, {
        cwd: opts.cwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    : spawn(resolved, args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

  let stderr = '';
  let spawnError: Error | undefined;
  let aborted = false;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    if (stderr.length < MAX_STDERR) stderr += d;
  });
  child.stdin?.on('error', () => {
    // child exited before reading stdin
  });
  child.stdin?.end(opts.stdin);

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (err) => {
      spawnError = err;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  });

  const exit = closed.then((code): CliExit => {
    opts.signal?.removeEventListener('abort', onAbort);
    if (spawnError) {
      throw fail(
        `${opts.provider} CLI could not be started (${(spawnError as NodeJS.ErrnoException).code ?? spawnError.message}); check config.binaryPath`,
        spawnError,
      );
    }
    return { code, stderr, aborted };
  });
  // Avoid unhandled rejection noise when the consumer stops early.
  exit.catch(() => undefined);

  async function* events(): AsyncGenerator<unknown> {
    try {
      if (child.stdout) {
        yield* parseNdjson(child.stdout as AsyncIterable<Buffer>);
      }
    } finally {
      if (child.exitCode === null) killTree(child);
    }
  }

  return { events: events(), exit };
}

/** Render an OpenAI conversation as a plain-text transcript for a CLI prompt. */
export function renderTranscript(messages: ChatMessage[], includeSystem: boolean): string {
  const turns = messages.filter((m) => includeSystem || m.role !== 'system');
  const userTurns = turns.filter((m) => m.role !== 'system');
  const only = userTurns.length === 1 && userTurns[0]?.role === 'user';
  if (only && turns.length === 1) return contentToText(userTurns[0]?.content);

  const label: Record<ChatMessage['role'], string> = {
    system: 'System',
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool result',
  };
  const blocks = turns.map((m) => {
    let body = contentToText(m.content);
    for (const call of m.tool_calls ?? []) {
      body += `${body ? '\n' : ''}[called tool ${call.function.name} with ${call.function.arguments}]`;
    }
    const name = m.role === 'tool' && m.name ? ` (${m.name})` : '';
    return `[${label[m.role]}${name}]\n${body}`;
  });
  return `Below is the conversation so far. Reply only with the next assistant message.\n\n${blocks.join('\n\n')}\n\n[Assistant]\n`;
}

export function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Classify a CLI failure message. Subscription CLIs report limits as plain text, so this is
 * heuristic: limits first, then auth, then transient server trouble.
 */
export function classifyCliText(
  text: string,
  now = Date.now(),
): { kind: ProviderErrorKind; retryAfterMs?: number } {
  const ctxKind = classifyMessage(text);
  if (ctxKind === 'context_length') return { kind: ctxKind };
  if (
    /usage limit|5-hour limit|five-hour limit|weekly limit|hit your limit|limit reached|out of (credits|usage)|insufficient[_ ]quota|quota|RESOURCE_EXHAUSTED/i.test(
      text,
    )
  ) {
    return { kind: 'quota_exhausted', retryAfterMs: parseResetMs(text, now) };
  }
  if (/rate[ _-]?limit|too many requests|\b429\b/i.test(text)) {
    return { kind: 'rate_limit', retryAfterMs: parseResetMs(text, now) };
  }
  if (
    /not logged in|please run \/login|\/login|codex login|invalid api key|unauthori[sz]ed|authentication|oauth token|token (has )?expired|login required|sign in|\b401\b/i.test(
      text,
    )
  ) {
    return { kind: 'auth' };
  }
  if (/overloaded|unavailable|internal server error|\b(500|502|503|529)\b/i.test(text)) {
    return { kind: 'unavailable' };
  }
  return { kind: ctxKind ?? 'unknown' };
}

/**
 * Parse a reset time out of CLI limit messages and return milliseconds from `now`.
 * Understands `...limit reached|1760000000` (epoch seconds/ms) and `resets 3pm`,
 * `resets 3:30 PM (America/New_York)` (next occurrence of that wall-clock time).
 */
export function parseResetMs(text: string, now = Date.now()): number | undefined {
  const epoch = /\|\s*(\d{9,13})\b/.exec(text)?.[1];
  if (epoch) {
    const n = Number(epoch);
    const at = epoch.length <= 10 ? n * 1000 : n;
    return Math.max(0, at - now);
  }
  const m = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!m?.[1]) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? '0');
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const tz = m[4]?.trim();
  let nowHour: number;
  let nowMinute: number;
  let nowSecond: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      ...(tz ? { timeZone: tz } : {}),
    }).formatToParts(new Date(now));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    nowHour = get('hour') % 24;
    nowMinute = get('minute');
    nowSecond = get('second');
  } catch {
    return undefined;
  }
  const nowSecs = nowHour * 3600 + nowMinute * 60 + nowSecond;
  let diff = hour * 3600 + minute * 60 - nowSecs;
  if (diff <= 0) diff += 24 * 3600;
  return diff * 1000;
}
