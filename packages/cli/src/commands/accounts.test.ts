import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context';
import type { SpawnFn } from '../lib/proc';
import { scriptedPrompter } from '../lib/prompter';
import { startRuntime } from '../runtime';
import { cli, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import { stripAnsi } from '../ui/format';
import { accountsAdd, accountsLogin } from './accounts';

let tmp: TempDir;
let home: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  mkdirSync(home);
});
afterEach(() => tmp.cleanup());

const SECRET = 'sk-ant-do-not-print-me';

function readSecret(accountId: string): string | undefined {
  const engine = createEngine({ home, env: testEnv(home) });
  try {
    return engine.keyring.get(accountId);
  } finally {
    engine.close();
  }
}

describe('davecode accounts (local, non-interactive)', () => {
  it('adds, lists, disables, enables and removes an account without echoing the secret', async () => {
    const added = await cli(
      [
        'accounts',
        'add',
        '--provider',
        'anthropic',
        '--label',
        'work',
        '--secret-env',
        'KEY',
        '--yes',
        '--json',
      ],
      { home, env: { KEY: SECRET, DAVECODE_PORT: '1' } },
    );
    expect(added.code).toBe(0);
    expect(added.stdout + added.stderr).not.toContain(SECRET);
    const { account } = JSON.parse(added.stdout);
    expect(account).toMatchObject({ provider: 'anthropic', label: 'work', status: 'active' });
    expect(readSecret(account.id)).toBe(SECRET);

    const list = await cli(['accounts', 'list', '--local'], { home });
    expect(list.stdout).toMatch(/ID\s+LABEL\s+PROVIDER\s+STATUS/);
    expect(list.stdout).toContain('work');
    expect(list.stdout).not.toContain(SECRET);

    const disabled = await cli(['accounts', 'disable', 'work', '--local'], { home });
    expect(disabled.stdout).toContain('work is now disabled (disabled)');
    const enabled = await cli(['accounts', 'enable', account.id, '--local'], { home });
    expect(enabled.stdout).toContain('work is now enabled (active)');

    const refused = await cli(['accounts', 'remove', account.id, '--local'], { home });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--yes');

    const removed = await cli(['accounts', 'rm', account.id, '--yes', '--local'], { home });
    expect(removed.code).toBe(0);
    const after = await cli(['--json', 'accounts'], { home, env: { DAVECODE_PORT: '1' } });
    expect(JSON.parse(after.stdout).accounts).toEqual([]);
  });

  it('accepts add-account as an alias and warns about --secret', async () => {
    const res = await cli(
      ['add-account', '--provider', 'openai', '--secret', SECRET, '--yes', '--local'],
      { home },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Added OpenAI');
    expect(res.stdout).toContain('secret    set (stored encrypted)');
    expect(res.stdout + res.stderr).not.toContain(SECRET);
    expect(res.stderr).toContain('prefer --secret-env');
  });

  it('refuses gemini-web without the experimental flag and explains the ToS risk', async () => {
    const res = await cli(['accounts', 'add', '--provider', 'gemini-web', '--yes', '--local'], {
      home,
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Terms of Service');
    expect(res.stderr).toContain('geminiWeb');
  });

  it('refuses a second subscription login without multiAccountRotation', async () => {
    const first = await cli(['accounts', 'add', '--provider', 'claude-cli', '--yes', '--local'], {
      home,
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('davecode accounts login');
    const second = await cli(['accounts', 'add', '--provider', 'claude-cli', '--yes', '--local'], {
      home,
    });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('multiAccountRotation');

    const allowed = await cli(['accounts', 'add', '--provider', 'claude-cli', '--yes', '--local'], {
      home,
      env: { DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION: '1' },
    });
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain('consumer terms');
  });

  it('reports usage errors for missing providers', async () => {
    const res = await cli(['accounts', 'add', '--yes', '--local'], { home });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Missing --provider');
  });
});

describe('accounts through a running gateway', () => {
  it('creates accounts via the API when a gateway is up', async () => {
    const runtime = await startRuntime({
      home,
      env: testEnv(home),
      cwd: tmp.path,
      host: '127.0.0.1',
      port: 0,
      dashboard: false,
      noProject: true,
    });
    try {
      const events: string[] = [];
      runtime.engine.events.subscribe((e) => events.push(e.type));
      const res = await cli(
        ['accounts', 'add', '--provider', 'openai', '--secret-env', 'KEY', '--yes'],
        { home, env: { KEY: SECRET, DAVECODE_PORT: String(runtime.port) } },
      );
      expect(res.code).toBe(0);
      expect(events).toContain('account.updated');
      const list = await cli(['accounts'], {
        home,
        env: { DAVECODE_PORT: String(runtime.port) },
      });
      expect(list.stdout).toContain('source: running gateway');
    } finally {
      await runtime.close();
    }
  });
});

describe('interactive add', () => {
  it('runs the prompt flow in a terminal', async () => {
    const io = testIO({ tty: true });
    const ctx = createContext({}, io, { env: testEnv(home, { DAVECODE_PORT: '1' }), cwd: home });
    const prompter = scriptedPrompter(['anthropic', 'personal', '50', SECRET, true]);
    const code = await accountsAdd(ctx, { local: true }, { prompter });
    expect(code).toBe(0);
    expect(stripAnsi(io.stdout.text())).toContain('Added personal');
    expect(io.stdout.text()).not.toContain(SECRET);
  });
});

describe('davecode accounts login', () => {
  function fakeClaudeOnPath(): string {
    const bin = join(tmp.path, 'bin');
    mkdirSync(bin);
    const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    writeFileSync(join(bin, name), '');
    return bin;
  }

  it('launches the CLI with CLAUDE_CONFIG_DIR set to the account sandbox', async () => {
    const add = await cli(
      [
        'accounts',
        'add',
        '--provider',
        'claude-cli',
        '--label',
        'pro',
        '--yes',
        '--json',
        '--local',
      ],
      { home },
    );
    const { account } = JSON.parse(add.stdout);
    const bin = fakeClaudeOnPath();

    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, env: options.env ?? {} });
      expect(options.stdio).toBe('inherit');
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    };
    const io = testIO();
    const ctx = createContext({}, io, { env: testEnv(home, { PATH: bin }), cwd: home });
    const code = await accountsLogin(ctx, account.id, [], { local: true }, { spawn });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain('claude');
    expect(calls[0]!.args).toEqual([]);
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe(join(home, 'sandboxes', account.id));
    expect(io.stdout.text()).toContain('is ready');
  });

  it('explains how to install a missing CLI and rejects API-key accounts', async () => {
    const add = await cli(
      ['accounts', 'add', '--provider', 'codex-cli', '--yes', '--json', '--local'],
      { home },
    );
    const { account } = JSON.parse(add.stdout);
    const missing = await cli(['accounts', 'login', account.id, '--local'], {
      home,
      env: { PATH: join(tmp.path, 'empty') },
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('npm install -g @openai/codex');

    await cli(
      ['accounts', 'add', '--provider', 'openai', '--secret-env', 'K', '--yes', '--local'],
      {
        home,
        env: { K: 'x' },
      },
    );
    const wrong = await cli(['accounts', 'login', 'OpenAI', '--local'], { home });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('do not use a CLI login');
  });
});
