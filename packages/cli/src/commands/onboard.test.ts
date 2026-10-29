import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountStore, loadConfig } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../context';
import { openAccounts } from '../lib/accounts-backend';
import { readPreferences } from '../lib/preferences';
import { scriptedPrompter } from '../lib/prompter';
import { type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import { accountCommand, logoutCommand } from './account';
import { ensureReady, parseAgyModels } from './onboard';

const service = { url: 'https://auth.example.test', publishableKey: 'sb_publishable_test' };

/** The account service, answering every token request with the same session. */
function accountFetch() {
  const real = globalThis.fetch;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.origin !== service.url) return real(input, init);
    return new Response(
      JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        user: { id: 'u1', email: 'dev@example.com', app_metadata: { provider: 'github' } },
      }),
    );
  }) as unknown as typeof fetch;
}

/** A browser that clicks "Continue with GitHub" and comes back with a code. */
async function browser(url: string): Promise<boolean> {
  const start = await fetch(`${url}oauth/github`, { redirect: 'manual' });
  const back = new URL(
    new URL(start.headers.get('location') ?? '').searchParams.get('redirect_to') ?? '',
  );
  back.searchParams.set('code', 'code-from-github');
  void fetch(back);
  return true;
}

let home: TempDir;
beforeEach(() => {
  home = tempDir();
});
afterEach(() => home.cleanup());

function context() {
  const io = testIO({ tty: true });
  const ctx = createContext({}, io, {
    env: testEnv(home.path, { NO_COLOR: '1' }),
    cwd: home.path,
  });
  return { ctx, io };
}

describe('first run', () => {
  it('shows the logo, applies the theme, signs in and connects the first agent', async () => {
    const { ctx, io } = context();
    const prompter = scriptedPrompter(['dark', 'browser', 'claude-cli', 'opus']);
    const vendorLogin = vi.fn(async () => 0);
    // Pretend the vendor CLI has no login yet, whatever this machine has.
    const real = await openAccounts({ home: home.path, env: ctx.env, local: true });
    const backend = Object.assign(Object.create(real), {
      connection: async () => ({ status: 'disconnected' }) as never,
    });
    const ready = await ensureReady(ctx, {
      prompter,
      backend,
      service,
      fetch: accountFetch(),
      open: browser,
      which: (binary) => (binary === 'claude' ? '/bin/claude' : undefined),
      vendorLogin,
    });

    expect(ready).toBeDefined();
    const out = io.stdout.text();
    expect(out).toContain('█');
    expect(out).toContain('Welcome to DaveCode');
    expect(out).toContain('Signed in as dev@example.com');
    expect(out).toContain('DaveCode will use Claude Code · opus');
    expect(prompter.asked).toEqual([
      'Choose a look for the terminal',
      'Sign in to continue',
      'Connect your first agent',
      'Model for Claude Code',
    ]);
    expect(vendorLogin).toHaveBeenCalledOnce();
    real.close();

    expect(readPreferences(home.path)).toEqual({ theme: 'dark', onboarded: true });
    expect(new AccountStore(home.path, ctx.env).load()?.user.email).toBe('dev@example.com');
    const config = loadConfig({ home: home.path, env: ctx.env });
    expect(config.routing.defaultRoute).toBe('auto');
    expect(config.routing.routes.find((r) => r.name === 'auto')?.targets[0]).toMatchObject({
      provider: 'claude-cli',
      model: 'opus',
    });
    expect(readFileSync(join(home.path, 'config.json'), 'utf8')).not.toMatch(/ollama/i);
  });

  it('explains how to install an agent that is missing, then lets you skip', async () => {
    const { ctx, io } = context();
    const prompter = scriptedPrompter(['auto', 'browser', 'codex-cli', 'later']);
    const ready = await ensureReady(ctx, {
      prompter,
      service,
      fetch: accountFetch(),
      open: browser,
      which: () => undefined,
    });
    expect(ready).toBeDefined();
    expect(io.stdout.text()).toContain('Codex is not installed.');
    expect(io.stdout.text()).toContain('npm install -g @openai/codex');
    const backend = await openAccounts({ home: home.path, env: ctx.env, local: true });
    expect(await backend.list()).toEqual([]);
    backend.close();
    expect(readPreferences(home.path).onboarded).toBe(true);
  });

  it('stops when the user quits at sign-in', async () => {
    const { ctx, io } = context();
    const ready = await ensureReady(ctx, {
      prompter: scriptedPrompter(['light', 'quit']),
      service,
      fetch: accountFetch(),
      open: browser,
    });
    expect(ready).toBeUndefined();
    expect(io.stderr.text()).toContain('Setup cancelled');
    expect(readPreferences(home.path)).toEqual({ theme: 'light' });
  });

  it('only asks to sign in again on later runs', async () => {
    const { ctx } = context();
    await ensureReady(ctx, {
      prompter: scriptedPrompter(['dark', 'browser', 'later']),
      service,
      fetch: accountFetch(),
      open: browser,
      which: () => undefined,
    });
    expect(await logoutCommand(ctx, { service, fetch: accountFetch() })).toBe(0);

    const again = scriptedPrompter(['browser']);
    await ensureReady(ctx, { prompter: again, service, fetch: accountFetch(), open: browser });
    expect(again.asked).toEqual(['Sign in to continue']);

    const quiet = scriptedPrompter([]);
    await ensureReady(ctx, { prompter: quiet, service, fetch: accountFetch() });
    expect(quiet.asked).toEqual([]);
  });
});

describe('account command', () => {
  it('reports the signed-in user', async () => {
    const { ctx, io } = context();
    expect(await accountCommand(ctx, { service, fetch: accountFetch() })).toBe(1);
    expect(io.stdout.text()).toContain('Not signed in');
    new AccountStore(home.path, ctx.env).save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', email: 'dev@example.com', provider: 'google' },
    });
    expect(await accountCommand(ctx, { service, fetch: accountFetch() })).toBe(0);
    expect(io.stdout.text()).toContain('Signed in as dev@example.com (google)');
  });
});

describe('Antigravity models', () => {
  it('parses `agy models` output', () => {
    expect(
      parseAgyModels(
        'gemini-4-argon-high\tGemini 4 Argon (High)\r\nclaude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n\nnoise',
      ),
    ).toEqual([
      { value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { value: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
    ]);
  });

  it('offers the models Antigravity reports during first run', async () => {
    const { ctx, io } = context();
    const prompter = scriptedPrompter(['dark', 'antigravity-cli', 'gemini-4-argon-high']);
    const real = await openAccounts({ home: home.path, env: ctx.env, local: true });
    const backend = Object.assign(Object.create(real), {
      connection: async () => ({ status: 'connected' }) as never,
    });
    await ensureReady(ctx, {
      prompter,
      backend,
      which: (binary) => (binary === 'agy' ? '/bin/agy' : undefined),
      models: async () => [{ value: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }],
    });
    real.close();
    expect(io.stdout.text()).toContain('DaveCode will use Antigravity · gemini-4-argon-high');
    const route = loadConfig({ home: home.path, env: ctx.env }).routing.routes[0];
    expect(route?.targets[0]).toMatchObject({ provider: 'antigravity-cli' });
  });
});
