import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendErrorSchema } from './policy';
import {
  appendStartupLog,
  asStartupError,
  StartupError,
  safeErrorCode,
  startupMessage,
  withRetry,
} from './startup';

describe('safeErrorCode', () => {
  it('prefers the system code, then the error name', () => {
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }))).toBe(
      'SQLITE_BUSY',
    );
    expect(safeErrorCode(new TypeError('x'))).toBe('TypeError');
  });

  it('never carries a message, however an error is shaped', () => {
    const secret = 'sk-secret-value';
    expect(safeErrorCode(new Error(secret))).toBe('Error');
    expect(safeErrorCode({ code: `bad code ${secret}` })).toBe('unknown');
    expect(safeErrorCode(secret)).toBe('unknown');
    expect(safeErrorCode(null)).toBe('unknown');
  });
});

describe('asStartupError', () => {
  it('keeps a startup error and labels anything else with the stage', () => {
    const failure = new StartupError('timeout');
    expect(asStartupError(failure, 'page')).toBe(failure);
    expect(asStartupError(new TypeError('x'), 'page').message).toBe('page/TypeError');
  });
});

describe('withRetry', () => {
  it('does not retry a success', async () => {
    const attempt = vi.fn(async () => 'ok');
    const onRetry = vi.fn();
    expect(await withRetry(attempt, onRetry)).toBe('ok');
    expect(attempt).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['backend', 'page'] as const)('recovers from one %s failure', async (stage) => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new StartupError(stage, 'SQLITE_BUSY'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    expect(await withRetry(attempt, onRetry)).toBe('ok');
    expect(onRetry.mock.calls[0]?.[0].message).toBe(`${stage}/SQLITE_BUSY`);
  });

  it('gives up after the second failure', async () => {
    const attempt = vi.fn(async () => {
      throw new StartupError('backend', 'exit-1');
    });
    await expect(withRetry(attempt, vi.fn())).rejects.toThrow('backend/exit-1');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not make the user wait through a second timeout', async () => {
    const attempt = vi.fn(async () => {
      throw new StartupError('timeout');
    });
    const onRetry = vi.fn();
    await expect(withRetry(attempt, onRetry)).rejects.toThrow('timeout/unknown');
    expect(attempt).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('startupMessage', () => {
  const message = (stage: 'backend' | 'timeout' | 'page', code?: string) =>
    startupMessage(new StartupError(stage, code), 'C:\\logs\\startup.log');

  it('says what failed, why, and where the log is', () => {
    const text = message('backend', 'SQLITE_BUSY');
    expect(text).toContain('could not start the local workspace');
    expect(text).toContain('Reason: backend/SQLITE_BUSY');
    expect(text).toContain('C:\\logs\\startup.log');
  });

  it('only blames the folder when the failure is about access', () => {
    expect(message('backend', 'EACCES')).toContain('does not have access to this folder');
    expect(message('backend', 'SQLITE_BUSY')).not.toContain('folder');
  });

  it('tells a slow start and a page failure apart', () => {
    expect(message('timeout')).toContain('took too long');
    expect(message('page', 'ERR_FAILED')).toContain('its window did not load');
  });
});

describe('appendStartupLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'davecode-startup-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds dated lines and creates the folder', () => {
    const file = join(dir, 'logs', 'startup.log');
    appendStartupLog(file, 'first', new Date('2026-11-06T12:00:00Z'));
    appendStartupLog(file, 'second', new Date('2026-11-06T12:00:01Z'));
    expect(readFileSync(file, 'utf8')).toBe(
      '2026-11-06T12:00:00.000Z first\n2026-11-06T12:00:01.000Z second\n',
    );
  });

  it('starts over instead of growing forever', () => {
    const file = join(dir, 'startup.log');
    writeFileSync(file, 'x'.repeat(64 * 1024));
    appendStartupLog(file, 'fresh', new Date('2026-11-06T12:00:00Z'));
    expect(readFileSync(file, 'utf8')).toBe('2026-11-06T12:00:00.000Z fresh\n');
  });

  it('never throws, even when the log cannot be written', () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, '');
    expect(() => appendStartupLog(join(blocker, 'logs', 'startup.log'), 'lost')).not.toThrow();
    expect(existsSync(join(blocker, 'logs'))).toBe(false);
  });
});

describe('backendErrorSchema', () => {
  it('accepts a short code or none, and rejects free text', () => {
    expect(backendErrorSchema.safeParse({ type: 'error', code: 'SQLITE_BUSY' }).success).toBe(true);
    expect(backendErrorSchema.safeParse({ type: 'error' }).success).toBe(true);
    expect(backendErrorSchema.safeParse({ type: 'error', code: 'token=abc def' }).success).toBe(
      false,
    );
  });
});
