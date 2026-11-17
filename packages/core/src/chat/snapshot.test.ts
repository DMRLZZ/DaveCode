import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changesSince, takeSnapshot } from './snapshot';

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'davecode-chat-snapshot-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'b.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a turn diff', () => {
  it('shows only what changed during the turn, not what was pending before', async () => {
    // Pending work from before the turn.
    writeFileSync(join(dir, 'b.txt'), 'keep\nmine\n');
    writeFileSync(join(dir, 'notes.txt'), 'my notes\n');
    const status = git('status', '--porcelain');
    const snapshot = await takeSnapshot(dir);
    expect(snapshot).toBeDefined();
    // The snapshot leaves the working tree exactly as it was.
    expect(git('status', '--porcelain')).toBe(status);

    // The turn.
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(dir, 'new.ts'), 'export const x = 1;\n');
    unlinkSync(join(dir, 'b.txt'));

    const changes = await changesSince(dir, snapshot!, 100_000);
    expect(changes.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1 },
      { path: 'b.txt', status: 'deleted', additions: 0, deletions: 2 },
      { path: 'new.ts', status: 'added', additions: 1, deletions: 0 },
    ]);
    expect(changes.patch).toContain('-two');
    expect(changes.patch).toContain('+TWO');
    expect(changes.patch).toContain('+export const x = 1;');
    // notes.txt was there before the turn and is not the agent's.
    expect(changes.patch).not.toContain('notes.txt');
    expect(changes.truncated).toBe(false);
  });

  it('reports nothing for a turn that changed nothing', async () => {
    const snapshot = await takeSnapshot(dir);
    expect(await changesSince(dir, snapshot!, 100_000)).toEqual({
      files: [],
      patch: '',
      truncated: false,
    });
  });

  it('cuts a diff that is too long on a line boundary', async () => {
    const snapshot = await takeSnapshot(dir);
    writeFileSync(join(dir, 'big.txt'), `${'x'.repeat(50)}\n`.repeat(200));
    const changes = await changesSince(dir, snapshot!, 1000);
    expect(changes.truncated).toBe(true);
    expect(Buffer.byteLength(changes.patch)).toBeLessThanOrEqual(1000);
    expect(changes.patch.endsWith('\n')).toBe(true);
    expect(changes.files).toEqual([
      { path: 'big.txt', status: 'added', additions: 200, deletions: 0 },
    ]);
  });

  it('has nothing to say outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'davecode-chat-plain-'));
    try {
      expect(await takeSnapshot(plain)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
