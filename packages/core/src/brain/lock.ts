import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isNodeError } from './fs-util';

export interface LockOptions {
  /** A lock older than this is considered abandoned and is taken over. Default 30 000 ms. */
  staleMs?: number;
  /** How long to wait for a held lock before giving up. Default 10 000 ms. */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 25 ms. */
  retryMs?: number;
}

export interface LockInfo {
  pid: number;
  /** Epoch milliseconds when the lock was taken. */
  ts: number;
  token: string;
}

export class LockTimeoutError extends Error {
  constructor(
    readonly lockPath: string,
    timeoutMs: number,
  ) {
    super(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readLockInfo(path: string): Promise<LockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as LockInfo).ts === 'number' &&
      typeof (parsed as LockInfo).pid === 'number'
    ) {
      return parsed as LockInfo;
    }
  } catch {
    // Missing or half-written lock files are handled by the caller.
  }
  return undefined;
}

/** Age of the lock in ms, from its recorded timestamp (falling back to the file mtime). */
async function lockAge(path: string): Promise<number | undefined> {
  const info = await readLockInfo(path);
  if (info) return Date.now() - info.ts;
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return undefined; // vanished: someone released it
  }
}

/**
 * Runs `fn` while holding an exclusive lock file at `lockPath`. The file holds `{ pid, ts }`;
 * a lock older than `staleMs` (crashed holder) is removed and re-acquired.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryMs = opts.retryMs ?? 25;
  const token = randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        const info: LockInfo = { pid: process.pid, ts: Date.now(), token };
        await handle.writeFile(JSON.stringify(info));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if (!isNodeError(err, 'EEXIST')) throw err;
      const age = await lockAge(lockPath);
      if (age !== undefined && age > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, timeoutMs);
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    // Only release a lock that is still ours (it may have been taken over after going stale).
    const current = await readLockInfo(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}
