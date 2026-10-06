import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CommandError,
  prepareCommand,
  runProcess,
  splitCommand,
  truncateHead,
  truncateTail,
} from './process';

describe.runIf(process.platform === 'win32')('prepareCommand on Windows', () => {
  it('runs .cmd shims through the shell only with safe arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'davecode-shim-'));
    try {
      writeFileSync(join(dir, 'fakeshim.cmd'), '@echo off\r\necho %*\r\n');
      const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
      expect(prepareCommand('fakeshim', ['run', '--filter=@x/y'], env).shell).toBe(true);
      expect(() => prepareCommand('fakeshim', ['a b'], env)).toThrow(CommandError);
      expect(() => prepareCommand('fakeshim', ['%PATH%'], env)).toThrow(CommandError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitCommand', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommand('pnpm vitest run')).toEqual(['pnpm', 'vitest', 'run']);
    expect(splitCommand(`node -e "console.log('a b')"`)).toEqual([
      'node',
      '-e',
      "console.log('a b')",
    ]);
    expect(splitCommand(`echo 'it''s' "say \\"hi\\""`)).toEqual(['echo', 'its', 'say "hi"']);
    expect(splitCommand('a\\ b c')).toEqual(['a b', 'c']);
    expect(splitCommand('node C:\\tools\\x.js')).toEqual(['node', 'C:\\tools\\x.js']);
    expect(splitCommand('cmd "" x')).toEqual(['cmd', '', 'x']);
    expect(splitCommand('a && b | c')).toEqual(['a', '&&', 'b', '|', 'c']);
    expect(splitCommand('   ')).toEqual([]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => splitCommand('node "oops')).toThrow(CommandError);
  });
});

describe('truncation', () => {
  it('keeps the tail or head with a marker', () => {
    expect(truncateTail('abcdef', 10)).toBe('abcdef');
    expect(truncateTail('abcdef', 2)).toBe('[… 4 earlier characters truncated]\nef');
    expect(truncateHead('abcdef', 2)).toBe('ab\n[… 4 more characters truncated]');
  });
});

describe('runProcess', () => {
  it('captures exit code, stdout and stderr', async () => {
    const res = await runProcess({
      command: 'node',
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'],
      cwd: tmpdir(),
      timeoutMs: 20_000,
    });
    expect(res).toMatchObject({ exitCode: 2, stdout: 'out', stderr: 'err', timedOut: false });
  });

  it('keeps the tail of large output', async () => {
    const res = await runProcess({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(5000) + "THE END")'],
      cwd: tmpdir(),
      timeoutMs: 20_000,
      maxOutputChars: 100,
    });
    expect(res.stdout.endsWith('THE END')).toBe(true);
    expect(res.stdout).toContain('earlier characters truncated');
  });

  it('kills the process on timeout and on abort', async () => {
    const slow = ['-e', 'setTimeout(() => {}, 60000)'];
    const timed = await runProcess({ command: 'node', args: slow, cwd: tmpdir(), timeoutMs: 300 });
    expect(timed).toMatchObject({ exitCode: null, timedOut: true });

    const controller = new AbortController();
    const pending = runProcess({
      command: 'node',
      args: slow,
      cwd: tmpdir(),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ exitCode: null, aborted: true });
  });

  it('reports a missing executable', async () => {
    const res = await runProcess({
      command: 'definitely-not-a-real-binary-davecode',
      args: [],
      cwd: tmpdir(),
      timeoutMs: 5_000,
    });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toMatch(/failed to start|not recognized|ENOENT/);
  });
});
