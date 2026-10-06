import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Windows can briefly refuse to rename over a file another process is reading. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes `content` to `path` atomically: the data goes to a sibling temp file first and is then
 * renamed over the target, so readers see either the old or the new content, never a torn write.
 */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 8 || !code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
        await sleep(10 * (attempt + 1));
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Reads a UTF-8 file, returning `undefined` when it does not exist. */
export async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export function isNodeError(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}
