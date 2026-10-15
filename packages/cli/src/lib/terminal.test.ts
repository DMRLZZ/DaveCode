import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TempDir, tempDir } from '../test-utils';
import {
  type DetachedSpawn,
  launchLoginTerminal,
  loginInvocation,
  terminalCommand,
} from './terminal';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const ARGV = ['/usr/bin/node', '/opt/davecode/bin.js', 'accounts', 'login', 'acc_1', '--hold'];

describe('loginInvocation', () => {
  it('re-runs this CLI entry point with accounts login --hold', () => {
    expect(loginInvocation('acc_1', ['node', '/opt/davecode/bin.js', 'serve'])).toEqual([
      process.execPath,
      '/opt/davecode/bin.js',
      'accounts',
      'login',
      'acc_1',
      '--hold',
    ]);
  });

  it.each(['../x', 'a b', 'acc;rm', '"q"', ''])('rejects unsafe id %j', (id) => {
    expect(() => loginInvocation(id, ['node', 'bin.js'])).toThrow();
  });
});

describe('terminalCommand', () => {
  it('uses start on Windows and refuses characters cmd.exe would expand', () => {
    const win = terminalCommand(['C:\\Program Files\\node.exe', 'C:\\dc\\bin.js', 'acc_1'], {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    expect(win).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: [
        '/d',
        '/c',
        'start "DaveCode login" "C:\\Program Files\\node.exe" "C:\\dc\\bin.js" "acc_1"',
      ],
    });
    expect(terminalCommand(['C:\\%PATH%\\node.exe'], { platform: 'win32', env: {} })).toBe(
      undefined,
    );
  });

  it('asks Terminal.app through osascript on macOS with quoted arguments', () => {
    const mac = terminalCommand(["/Users/o'neil/node", '/opt/bin.js'], {
      platform: 'darwin',
      env: {},
    });
    expect(mac?.command).toBe('osascript');
    expect(mac?.args[1]).toBe(
      `tell application "Terminal" to do script "'/Users/o'\\\\''neil/node' '/opt/bin.js'"`,
    );
  });

  it('picks an installed terminal emulator on Linux and needs a display', () => {
    const bin = join(tmp.path, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'xterm'), '');
    const env = { PATH: bin, DISPLAY: ':0' };
    expect(terminalCommand(ARGV, { platform: 'linux', env })).toEqual({
      command: 'xterm',
      args: ['-e', ...ARGV],
    });
    expect(terminalCommand(ARGV, { platform: 'linux', env: { PATH: bin } })).toBe(undefined);
    expect(
      terminalCommand(ARGV, {
        platform: 'linux',
        env: { PATH: join(tmp.path, 'none'), DISPLAY: ':0' },
      }),
    ).toBe(undefined);
  });
});

describe('launchLoginTerminal', () => {
  function fakeSpawn(event: 'spawn' | 'error') {
    const calls: Array<{ command: string; args: readonly string[]; detached?: boolean }> = [];
    const spawn: DetachedSpawn = (command, args, options) => {
      calls.push({ command, args, ...(options.detached ? { detached: true } : {}) });
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => child.emit(event, new Error('nope')));
      return child;
    };
    return { calls, spawn };
  }

  it('opens a detached window and reports whether it started', async () => {
    const ok = fakeSpawn('spawn');
    expect(
      await launchLoginTerminal('acc_1', { platform: 'darwin', env: {}, spawn: ok.spawn }),
    ).toBe(true);
    expect(ok.calls[0]).toMatchObject({ command: 'osascript', detached: true });
    const failed = fakeSpawn('error');
    expect(
      await launchLoginTerminal('acc_1', { platform: 'darwin', env: {}, spawn: failed.spawn }),
    ).toBe(false);
  });

  it('does nothing on a headless Linux machine', async () => {
    const none = fakeSpawn('spawn');
    expect(
      await launchLoginTerminal('acc_1', { platform: 'linux', env: {}, spawn: none.spawn }),
    ).toBe(false);
    expect(none.calls).toHaveLength(0);
  });
});
