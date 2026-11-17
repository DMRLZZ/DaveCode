import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitBashFrom, posixShellPlan, resolveShell, windowsShellPlan } from './shells';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'davecode-shells-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const found = {
  powershell: 'C:\\Windows\\powershell.exe',
  cmd: 'C:\\Windows\\cmd.exe',
  gitbash: 'C:\\Git\\bin\\bash.exe',
  wsl: 'C:\\Windows\\wsl.exe',
};

describe('resolveShell', () => {
  it('uses the chosen shell when it is installed, else PowerShell', () => {
    expect(resolveShell('gitbash', found)).toBe('gitbash');
    expect(resolveShell('pwsh', found)).toBe('powershell');
    expect(resolveShell('auto', found)).toBe('powershell');
    expect(resolveShell('auto', { ...found, pwsh: 'C:\\pwsh.exe' })).toBe('pwsh');
    expect(resolveShell('wsl', { powershell: 'p' })).toBe('powershell');
  });
});

describe('windowsShellPlan', () => {
  it('opens a plain shell', () => {
    expect(windowsShellPlan('powershell', found, undefined)).toEqual({
      file: found.powershell,
      args: ['-NoLogo'],
    });
    expect(windowsShellPlan('cmd', found, undefined)).toEqual({ file: found.cmd, args: [] });
    expect(windowsShellPlan('gitbash', found, undefined)).toEqual({
      file: found.gitbash,
      args: ['--login', '-i'],
    });
    expect(windowsShellPlan('wsl', found, undefined)).toEqual({ file: found.wsl, args: [] });
  });

  it('starts an agent inside the shell and keeps the shell afterwards', () => {
    expect(windowsShellPlan('powershell', found, 'claude').args).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'claude',
    ]);
    expect(windowsShellPlan('cmd', found, 'codex').args).toEqual(['/K', 'codex']);
    expect(windowsShellPlan('gitbash', found, 'agy --dangerously-skip-permissions').args).toEqual([
      '--login',
      '-i',
      '-c',
      'agy --dangerously-skip-permissions; exec bash --login -i',
    ]);
    expect(windowsShellPlan('wsl', found, 'opencode').args).toEqual([
      '-e',
      'bash',
      '-lic',
      'opencode; exec bash -li',
    ]);
  });
});

describe('posixShellPlan', () => {
  it('runs the login shell', () => {
    expect(posixShellPlan('/bin/zsh', undefined)).toEqual({ file: '/bin/zsh', args: ['-il'] });
    expect(posixShellPlan('/bin/zsh', 'codex').args).toEqual([
      '-ilc',
      'codex; exec "/bin/zsh" -il',
    ]);
  });
});

describe('gitBashFrom', () => {
  it('finds bash next to git', () => {
    mkdirSync(join(dir, 'Git', 'cmd'), { recursive: true });
    mkdirSync(join(dir, 'Git', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'Git', 'bin', 'bash.exe'), '');
    expect(gitBashFrom(join(dir, 'Git', 'cmd', 'git.exe'))).toBe(
      join(dir, 'Git', 'bin', 'bash.exe'),
    );
    expect(gitBashFrom(join(dir, 'Other', 'cmd', 'git.exe'))).toBeUndefined();
    expect(gitBashFrom(undefined)).toBeUndefined();
  });
});
