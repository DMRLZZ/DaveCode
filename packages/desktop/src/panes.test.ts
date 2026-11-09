import { paneWorkspacePath } from '@davecode/core';
import { describe, expect, it } from 'vitest';
import { openSchema, paneEnv, paneWorkspaceDir, shellPlan, writeSchema } from './panes';

describe('shellPlan', () => {
  it('starts a plain shell', () => {
    expect(shellPlan('shell', 'win32', 'pwsh.exe')).toEqual({
      file: 'pwsh.exe',
      args: ['-NoLogo'],
    });
    expect(shellPlan('shell', 'linux', '/bin/zsh')).toEqual({ file: '/bin/zsh', args: ['-il'] });
  });

  it('keeps the shell open after an agent exits', () => {
    expect(shellPlan('claude', 'win32', 'powershell.exe').args).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'claude',
    ]);
    expect(shellPlan('codex', 'darwin', '/bin/zsh').args).toEqual([
      '-ilc',
      'codex; exec "/bin/zsh" -il',
    ]);
  });
});

describe('openSchema', () => {
  it('refuses a kind outside the allow-list', () => {
    expect(openSchema.safeParse({ kind: 'rm -rf /', cols: 80, rows: 24 }).success).toBe(false);
    expect(openSchema.safeParse({ kind: 'agy', cols: 80, rows: 24 }).success).toBe(true);
  });

  it('refuses nonsensical sizes', () => {
    expect(openSchema.safeParse({ kind: 'shell', cols: 0, rows: 24 }).success).toBe(false);
  });
});

describe('writeSchema', () => {
  it('bounds a single write', () => {
    expect(writeSchema.safeParse({ id: 'a', data: 'x'.repeat(1_000_001) }).success).toBe(false);
  });
});

describe('paneEnv', () => {
  it('drops Electron and DaveCode runtime variables and sets the terminal type', () => {
    const env = paneEnv({
      PATH: '/bin',
      ELECTRON_RUN_AS_NODE: '1',
      DAVECODE_DESKTOP_SMOKE_DIR: '/tmp/x',
      MISSING: undefined,
    });
    expect(env).toEqual({
      PATH: '/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'DaveCode',
    });
  });
});

describe('isolated panes', () => {
  it('accepts a workspace id and nothing that could be a path', () => {
    expect(
      openSchema.parse({ kind: 'claude', cols: 80, rows: 24, workspace: 'ab12cd' }).workspace,
    ).toBe('ab12cd');
    for (const workspace of ['../x', 'C:\\x', 'AB12CD', 'abc', '', 'a/b1c2']) {
      expect(openSchema.safeParse({ kind: 'claude', cols: 80, rows: 24, workspace }).success).toBe(
        false,
      );
    }
  });

  it('finds the same worktree as the gateway', () => {
    const home = '/home/u/.davecode';
    const project = '/work/my project';
    expect(paneWorkspaceDir(home, project, 'ab12cd')).toBe(
      paneWorkspacePath(home, project, 'ab12cd'),
    );
    expect(paneWorkspaceDir(home, project, '../x')).toBeUndefined();
  });
});
