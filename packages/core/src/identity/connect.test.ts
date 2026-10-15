import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, ProviderKind } from '../types';
import {
  ConnectionChecker,
  connectionMethod,
  loginEnv,
  type ProbeCommand,
  type ProbeResult,
  spawnProbe,
} from './connect';
import { SandboxManager } from './sandbox';

let root: string;
let sandboxes: SandboxManager;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-connect-'));
  sandboxes = new SandboxManager(join(root, 'sandboxes'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function account(provider: ProviderKind, extra: Partial<Account> = {}): Account {
  return {
    id: `acc_${provider.replace(/-/g, '_')}`,
    provider,
    label: provider,
    enabled: true,
    priority: 100,
    weight: 1,
    limits: {},
    config: {},
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

function checker(
  reply: ProbeResult,
  seen: ProbeCommand[] = [],
  platform: NodeJS.Platform = 'linux',
) {
  return new ConnectionChecker({
    sandboxes,
    clock: () => Date.parse('2026-10-15T12:00:00.000Z'),
    platform,
    probe: async (cmd) => {
      seen.push(cmd);
      return reply;
    },
  });
}

describe('connectionMethod', () => {
  it('classifies providers', () => {
    expect(connectionMethod('claude-cli')).toBe('cli-login');
    expect(connectionMethod('codex-cli')).toBe('cli-login');
    expect(connectionMethod('gemini-cli')).toBe('cli-login');
    expect(connectionMethod('gemini-web')).toBe('browser');
    expect(connectionMethod('openai')).toBe('api-key');
  });
});

describe('ConnectionChecker', () => {
  it('reports API-key accounts from the keyring flag only', async () => {
    const c = checker({ code: 0, stdout: '' });
    expect((await c.check(account('openai', { hasSecret: true }))).status).toBe('connected');
    const missing = await c.check(account('anthropic'));
    expect(missing).toMatchObject({ status: 'not_connected', method: 'api-key' });
    expect(missing.loginCommand).toBeUndefined();
    expect((await c.check(account('openai-compatible'))).status).toBe('connected');
  });

  it('asks Claude Code for its status inside the sandbox and flags a non-isolated login', async () => {
    const seen: ProbeCommand[] = [];
    const acc = account('claude-cli');
    const c = checker({ code: 0, stdout: '{"loggedIn": true, "authMethod": "oauth_token"}' }, seen);
    const shared = await c.check(acc);
    expect(seen[0]?.args).toEqual(['auth', 'status', '--json']);
    expect(seen[0]?.env.CLAUDE_CONFIG_DIR).toBe(sandboxes.dirFor(acc.id));
    expect(shared.status).toBe('connected');
    expect(shared.detail).toMatch(/not isolated/);
    expect(shared.loginCommand).toBe(`davecode accounts login ${acc.id}`);
    expect(shared.checkedAt).toBe('2026-10-15T12:00:00.000Z');

    const dir = sandboxes.ensure(acc.id);
    writeFileSync(join(dir, '.credentials.json'), '{}');
    expect((await c.check(acc)).detail).not.toMatch(/not isolated/);
    // macOS keeps the login in the keychain, so a missing file proves nothing there.
    rmSync(join(dir, '.credentials.json'));
    const mac = await checker({ code: 0, stdout: '{"loggedIn":true}' }, [], 'darwin').check(acc);
    expect(mac.detail).not.toMatch(/not isolated/);
  });

  it('runs status commands with the configured base environment', async () => {
    const seen: ProbeCommand[] = [];
    const c = new ConnectionChecker({
      sandboxes,
      env: { PATH: '/only/here' },
      probe: async (cmd) => {
        seen.push(cmd);
        return { code: 1, stdout: '' };
      },
    });
    await c.check(account('codex-cli'));
    expect(seen[0]?.env).toEqual({
      PATH: '/only/here',
      CODEX_HOME: sandboxes.dirFor('acc_codex_cli'),
    });
  });

  it('maps Claude Code logged-out, unreadable and missing-binary results', async () => {
    const acc = account('claude-cli');
    const out = await checker({ code: 1, stdout: '{"loggedIn":false}' }).check(acc);
    expect(out.status).toBe('not_connected');
    expect((await checker({ code: 0, stdout: 'garbage' }).check(acc)).status).toBe('unknown');
    const missing = await checker({ code: null, stdout: '', missing: true }).check(acc);
    expect(missing).toMatchObject({ status: 'unknown' });
    expect(missing.detail).toMatch(/npm install -g @anthropic-ai\/claude-code/);
    expect((await checker({ code: null, stdout: '', timedOut: true }).check(acc)).status).toBe(
      'unknown',
    );
  });

  it('uses the exit code of `codex login status` and never echoes its output', async () => {
    const seen: ProbeCommand[] = [];
    const acc = account('codex-cli', { config: { binaryPath: 'node', binaryArgs: ['fake.js'] } });
    const ok = await checker(
      { code: 0, stdout: 'Logged in using ChatGPT (me@example.com)' },
      seen,
    ).check(acc);
    expect(seen[0]).toMatchObject({ command: 'node', args: ['fake.js', 'login', 'status'] });
    expect(seen[0]?.env.CODEX_HOME).toBe(sandboxes.dirFor(acc.id));
    expect(ok.status).toBe('connected');
    expect(JSON.stringify(ok)).not.toContain('example.com');
    expect((await checker({ code: 1, stdout: 'Not logged in' }).check(acc)).status).toBe(
      'not_connected',
    );
  });

  it('detects the Google credentials Gemini CLI caches in the sandbox without a probe', async () => {
    const seen: ProbeCommand[] = [];
    const acc = account('gemini-cli');
    const c = checker({ code: 0, stdout: '' }, seen);
    expect((await c.check(acc)).status).toBe('not_connected');
    const gemini = join(sandboxes.dirFor(acc.id), '.gemini');
    mkdirSync(gemini, { recursive: true });
    writeFileSync(join(gemini, 'oauth_creds.json'), '{"secret":"never-read"}');
    const connected = await c.check(acc);
    expect(connected.status).toBe('connected');
    expect(JSON.stringify(connected)).not.toContain('never-read');
    expect(seen).toHaveLength(0);
  });

  it('cannot verify gemini-web without opening its browser profile', async () => {
    expect(await checker({ code: 0, stdout: '' }).check(account('gemini-web'))).toMatchObject({
      method: 'browser',
      status: 'unknown',
    });
  });
});

describe('loginEnv', () => {
  it('isolates the CLI home and blanks Gemini API keys', () => {
    const env = loginEnv({ id: 'acc_g', provider: 'gemini-cli' }, sandboxes);
    expect(env.GEMINI_CLI_HOME).toBe(sandboxes.dirFor('acc_g'));
    expect(env.GEMINI_API_KEY).toBe('');
    expect(loginEnv({ id: 'acc_c', provider: 'codex-cli' }, sandboxes)).toEqual({
      CODEX_HOME: sandboxes.dirFor('acc_c'),
    });
  });
});

describe('spawnProbe', () => {
  it('runs a real process with the given env and reports missing binaries', async () => {
    const script = join(root, 'status.cjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_HOME === "x" })); process.exit(3);',
    );
    const res = await spawnProbe({
      command: process.execPath,
      args: [script],
      env: { ...process.env, FAKE_HOME: 'x' },
      cwd: root,
      timeoutMs: 10_000,
    });
    expect(res).toEqual({ code: 3, stdout: '{"loggedIn":true}' });
    const missing = await spawnProbe({
      command: join(root, 'does-not-exist'),
      args: [],
      env: process.env,
      cwd: root,
      timeoutMs: 10_000,
    });
    expect(missing.missing).toBe(true);
  });
});
