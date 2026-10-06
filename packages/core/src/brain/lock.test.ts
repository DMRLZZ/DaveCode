import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, withFileLock } from './lock';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'davecode-lock-'));
  lockPath = join(dir, '.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('withFileLock', () => {
  it('writes pid + timestamp while held and removes the file afterwards', async () => {
    await withFileLock(lockPath, async () => {
      const info = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(info.pid).toBe(process.pid);
      expect(Math.abs(Date.now() - info.ts)).toBeLessThan(5_000);
    });
    expect(await exists(lockPath)).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await exists(lockPath)).toBe(false);
  });

  it('serialises concurrent critical sections', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withFileLock(
          lockPath,
          async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 10));
            order.push(n);
            active--;
          },
          { retryMs: 2 },
        ),
      ),
    );
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(5);
  });

  it('times out while a fresh lock is held by someone else', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 99999, ts: Date.now(), token: 'other' }));
    await expect(
      withFileLock(lockPath, async () => 'x', { timeoutMs: 80, retryMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await exists(lockPath)).toBe(true);
  });

  it('recovers a stale lock (recorded timestamp older than 30 s)', async () => {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, ts: Date.now() - 31_000, token: 'old' }),
    );
    await expect(withFileLock(lockPath, async () => 'ok')).resolves.toBe('ok');
    expect(await exists(lockPath)).toBe(false);
  });

  it('recovers a stale lock with unreadable content using the file mtime', async () => {
    await writeFile(lockPath, 'garbage');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await expect(withFileLock(lockPath, async () => 'ok')).resolves.toBe('ok');
  });

  it('does not steal a lock that is not yet stale', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 99999, ts: Date.now() - 20_000, token: 'x' }));
    await expect(
      withFileLock(lockPath, async () => 'x', { timeoutMs: 50, retryMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('honours a custom staleMs', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 99999, ts: Date.now() - 200, token: 'x' }));
    await expect(withFileLock(lockPath, async () => 'ok', { staleMs: 100 })).resolves.toBe('ok');
  });

  it('does not delete a lock that was taken over while the callback ran', async () => {
    await withFileLock(lockPath, async () => {
      await writeFile(lockPath, JSON.stringify({ pid: 1, ts: Date.now(), token: 'usurper' }));
    });
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe('usurper');
  });
});
