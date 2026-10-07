import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from './context';
import { CliError } from './errors';
import { describeError } from './program';
import { cli, type TempDir, tempDir, testIO } from './test-utils';

let home: TempDir;

beforeEach(() => {
  home = tempDir();
});
afterEach(() => home.cleanup());

describe('global flags', () => {
  it('prints help without a command when not attached to a terminal', async () => {
    const res = await cli([], { home: home.path });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Usage: davecode');
    expect(res.stdout).toContain('--home <dir>');
    expect(res.stdout).toContain('--no-color');
  });

  it('prints the version', async () => {
    const res = await cli(['--version'], { home: home.path });
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^davecode \d+\.\d+\.\d+/);
  });

  it('refuses to open the chat TUI without a terminal', async () => {
    const res = await cli(['chat'], { home: home.path });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('interactive terminal');
  });

  it('rejects unknown options with a usage error', async () => {
    const res = await cli(['--definitely-not-a-flag'], { home: home.path });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('unknown option');
  });
});

describe('createContext', () => {
  it('resolves --home relative to the cwd and exports it as DAVECODE_HOME', () => {
    const ctx = createContext({ home: 'state' }, testIO(), { env: {}, cwd: home.path });
    expect(ctx.home).toBe(`${home.path}${process.platform === 'win32' ? '\\' : '/'}state`);
    expect(ctx.env.DAVECODE_HOME).toBe(ctx.home);
  });

  it('falls back to DAVECODE_HOME from the environment', () => {
    const ctx = createContext({}, testIO(), { env: { DAVECODE_HOME: home.path }, cwd: '/' });
    expect(ctx.home).toBe(home.path);
  });

  it('is interactive only with TTY stdin and stdout and without --json', () => {
    const tty = testIO({ tty: true });
    expect(createContext({}, tty, { env: {}, cwd: home.path }).interactive).toBe(true);
    expect(createContext({ json: true }, tty, { env: {}, cwd: home.path }).interactive).toBe(false);
    expect(createContext({}, testIO(), { env: {}, cwd: home.path }).interactive).toBe(false);
  });

  it('disables colour for --no-color, NO_COLOR, --json and pipes', () => {
    const tty = testIO({ tty: true });
    const base = { env: {}, cwd: home.path };
    expect(createContext({}, tty, base).theme.color).toBe(true);
    expect(createContext({ color: false }, tty, base).theme.color).toBe(false);
    expect(createContext({ json: true }, tty, base).theme.color).toBe(false);
    expect(createContext({}, tty, { env: { NO_COLOR: '1' }, cwd: home.path }).theme.color).toBe(
      false,
    );
    expect(createContext({}, testIO(), base).theme.color).toBe(false);
  });
});

describe('describeError', () => {
  it('keeps CliError exit codes and hints', () => {
    expect(describeError(new CliError('nope', { exitCode: 2, hint: 'try this' }))).toEqual({
      message: 'nope',
      hint: 'try this',
      exitCode: 2,
    });
  });

  it('adds a hint for config errors', () => {
    const err = new Error('Invalid DaveCode config (x)');
    err.name = 'ConfigError';
    expect(describeError(err).hint).toContain('davecode config path');
  });
});
