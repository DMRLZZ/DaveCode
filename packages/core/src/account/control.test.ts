import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AccountControl, createAccountControl } from './control';
import { AccountStore, accountFile } from './store';

const service = { url: 'https://auth.example.test', publishableKey: 'key' };
const env = { DAVECODE_MASTER_KEY: undefined } as NodeJS.ProcessEnv;

const reply = {
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  expires_in: 3600,
  user: { id: 'user-1', email: 'dev@example.com', app_metadata: { provider: 'google' } },
};

/** Answers the account service and lets requests to the loopback callback through. */
function serviceFetch(status = 200, signOut = vi.fn()) {
  const real = globalThis.fetch;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.origin !== service.url) return real(input, init);
    if (url.pathname.endsWith('/logout')) {
      signOut();
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(status === 200 ? reply : { error: 'invalid_grant' }), {
      status,
    });
  }) as unknown as typeof fetch;
}

const redirectOf = (url: string) => new URL(url).searchParams.get('redirect_to') ?? '';
const callback = (url: string, query = '?code=abc') =>
  fetch(`${redirectOf(url)}${query}`, { redirect: 'manual' });

async function settled(control: AccountControl) {
  await vi.waitFor(async () => expect((await control.state()).pending).toBe(false));
  return control.state();
}

describe('createAccountControl', () => {
  let home: string;
  let open: ReturnType<typeof vi.fn<(url: string) => Promise<boolean>>>;
  const make = (fetcher = serviceFetch()) => {
    const control = createAccountControl({ home, env, open, service, fetch: fetcher });
    if (!control) throw new Error('no control');
    return control;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'davecode-account-control-'));
    open = vi.fn(async () => true);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('is absent when the build has no account service', () => {
    const none = { DAVECODE_ACCOUNT_URL: '', DAVECODE_ACCOUNT_KEY: '' };
    expect(createAccountControl({ home, env: none, open })).toBeUndefined();
  });

  it('reports a session `davecode login` already saved, without any sign-in', async () => {
    new AccountStore(home, env).save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', email: 'dev@example.com', provider: 'google' },
    });
    expect(await make().state()).toEqual({
      signedIn: true,
      user: { id: 'user-1', email: 'dev@example.com', provider: 'google' },
      pending: false,
      error: null,
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the browser, stores the session on the callback and never exposes tokens', async () => {
    const control = make();
    expect((await control.state()).signedIn).toBe(false);
    const started = await control.login('google');
    expect(started.opened).toBe(true);
    expect(open).toHaveBeenCalledWith(started.url);
    const url = new URL(started.url);
    expect(url.pathname).toBe('/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('google');
    expect(redirectOf(started.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/.+\/callback$/);
    expect((await control.state()).pending).toBe(true);

    await callback(started.url);
    const state = await settled(control);
    expect(state.signedIn).toBe(true);
    expect(state.user?.email).toBe('dev@example.com');
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(new AccountStore(home, env).load()?.accessToken).toBe('access-secret');
    await control.close();
  });

  it('without a provider, sends the browser to the page that offers every method', async () => {
    const control = make();
    const started = await control.login();
    expect(new URL(started.url).pathname).toBe('/login');
    await control.close();
  });

  it('still returns the link when no browser could be opened', async () => {
    open.mockRejectedValueOnce(new Error('no browser'));
    const control = make();
    const started = await control.login();
    expect(started.opened).toBe(false);
    expect(started.url).toContain(service.url);
    await control.close();
  });

  it('reports a failed sign-in and clears it on the next attempt', async () => {
    const control = make(serviceFetch(400));
    const started = await control.login('github');
    await callback(started.url);
    const state = await settled(control);
    expect(state.signedIn).toBe(false);
    expect(state.error).toMatch(/did not finish/);
    await control.login('github');
    expect((await control.state()).error).toBeNull();
    await control.close();
  });

  it('a new sign-in replaces a pending one, and cancelling is not an error', async () => {
    const control = make();
    const first = await control.login('google');
    const second = await control.login('github');
    await expect(callback(first.url)).rejects.toThrow();
    expect((await control.state()).pending).toBe(true);
    await control.cancel();
    await expect(callback(second.url)).rejects.toThrow();
    expect(await control.state()).toMatchObject({ pending: false, error: null, signedIn: false });
  });

  it('signs out here even when the service cannot be reached', async () => {
    const signOut = vi.fn();
    const control = make(serviceFetch(200, signOut));
    const started = await control.login();
    await callback(started.url);
    await settled(control);
    expect(existsSync(accountFile(home))).toBe(true);
    await control.logout();
    expect(signOut).toHaveBeenCalledOnce();
    expect(existsSync(accountFile(home))).toBe(false);
    expect((await control.state()).signedIn).toBe(false);

    new AccountStore(home, env).save({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u' },
    });
    const offline = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await make(offline).logout();
    expect(existsSync(accountFile(home))).toBe(false);
  });
});
