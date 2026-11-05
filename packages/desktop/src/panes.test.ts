import { describe, expect, it } from 'vitest';
import { openSchema, paneEnv, shellPlan, writeSchema } from './panes';

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
