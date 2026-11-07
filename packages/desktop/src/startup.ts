import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How long a cold start may take: the first launch after installing can be slow. */
export const STARTUP_TIMEOUT_MS = 120_000;

/** Enough for many failures; the log only exists to explain the last few. */
const LOG_LIMIT_BYTES = 64 * 1024;

/** Which step failed: starting the local service, waiting for it, or loading its page. */
export type StartupStage = 'backend' | 'timeout' | 'page';

export class StartupError extends Error {
  constructor(
    readonly stage: StartupStage,
    readonly code = 'unknown',
  ) {
    super(`${stage}/${code}`);
    this.name = 'StartupError';
  }
}

const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/**
 * A short identifier for a failure, such as `SQLITE_BUSY` or `EACCES`. Error messages are never
 * used: provider and config failures can carry secrets.
 */
export function safeErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code, name } = error as { code?: unknown; name?: unknown };
  for (const candidate of [code, name]) {
    if (typeof candidate === 'string' && SAFE_CODE.test(candidate)) return candidate;
  }
  return 'unknown';
}

export function asStartupError(error: unknown, stage: StartupStage): StartupError {
  return error instanceof StartupError ? error : new StartupError(stage, safeErrorCode(error));
}

/**
 * Runs `attempt`, and once more after a failure that can be momentary. A timeout is not retried:
 * the user has already waited for the whole of it.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  onRetry: (failure: StartupError) => void,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const failure = asStartupError(error, 'backend');
    if (failure.stage === 'timeout') throw failure;
    onRetry(failure);
    return attempt();
  }
}

function explanation(failure: StartupError): string {
  if (failure.stage === 'timeout') return 'The local workspace took too long to start.';
  if (failure.stage === 'page') return 'The local workspace started, but its window did not load.';
  if (PERMISSION_CODES.has(failure.code)) return 'DaveCode does not have access to this folder.';
  return 'DaveCode could not start the local workspace.';
}

/** The text of the error dialog: what happened, its reason, and where the log is. */
export function startupMessage(failure: StartupError, logFile: string): string {
  return [
    `${explanation(failure)} Try again; DaveCode has already retried once.`,
    `Reason: ${failure.message}`,
    `Log: ${logFile}`,
  ].join('\n\n');
}

/** Failing to write the log must never turn into a second failure. */
export function appendStartupLog(file: string, line: string, now = new Date()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const entry = `${now.toISOString()} ${line}\n`;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* The first entry creates the file. */
    }
    if (size >= LOG_LIMIT_BYTES) writeFileSync(file, entry);
    else appendFileSync(file, entry);
  } catch {
    /* The dialog still shows the reason. */
  }
}
