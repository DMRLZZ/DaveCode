import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountClient, AccountError, accountService, pkcePair } from './client';
import { startAccountLogin } from './login-server';
import { AccountStore, accountFile } from './store';

const service = { url: 'https://auth.example.test', publishableKey: 'sb_publishable_test' };

function sessionReply(email = 'dev@example.com') {
  return {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    user: { id: 'user-1', email, app_metadata: { provider: 'github' } },
  };
}

/** A fetch double that records calls to the account service and lets others through. */
function upstream(reply: (url: URL, body: unknown) => { status?: number; body: unknown }) {
  const calls: Array<{ url: URL; body: unknown; headers: Headers }> = [];
  const real = globalThis.fetch;
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.origin !== service.url) return real(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    const { status = 200, body: out } = reply(url, body);
    return new Response(JSON.stringify(out), { status });
  });
  return { fetch: fake as unknown as typeof fetch, calls };
}

describe('accountService', () => {
  it('points at DaveCode accounts on Cloudflare and honours the environment', () => {
    expect(accountService({})).toEqual({
      url: 'https://auth.davecode.app',
      publishableKey: 'davecode-cli',
    });
    expect(
      accountService({ DAVECODE_ACCOUNT_URL: 'https://x.test/', DAVECODE_ACCOUNT_KEY: 'k' }),
    ).toEqual({ url: 'https://x.test', publishableKey: 'k' });
  });
});

describe('AccountClient', () => {
  it('builds a PKCE authorize URL and exchanges the code', async () => {
    const { fetch, calls } = upstream(() => ({ body: sessionReply() }));
    const client = new AccountClient(service, { fetch, now: () => 1_000 });
    const { verifier, challenge } = pkcePair();
    const url = new URL(client.authorizeUrl('github', 'http://127.0.0.1:5/cb', challenge));
    expect(url.pathname).toBe('/auth/v1/authorize');
    expect(url.searchParams.get('provider')).toBe('github');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');

    const session = await client.exchangeCode('abc', verifier);
    expect(calls[0]?.url.search).toBe('?grant_type=pkce');
    expect(calls[0]?.body).toEqual({ auth_code: 'abc', code_verifier: verifier });
    expect(calls[0]?.headers.get('apikey')).toBe(service.publishableKey);
    expect(session).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1_000 + 3_600_000,
      user: { id: 'user-1', email: 'dev@example.com', provider: 'github' },
    });
  });

  it('maps upstream errors to a readable AccountError', async () => {
    const { fetch } = upstream(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid login credentials' },
    }));
    const client = new AccountClient(service, { fetch });
    await expect(client.signInWithPassword('a@b.co', 'password1')).rejects.toMatchObject({
      message: 'Invalid login credentials',
      status: 400,
    });
  });

  it('reports a pending confirmation when sign-up returns no session', async () => {
    const { fetch, calls } = upstream(() => ({ body: { id: 'user-2', email: 'a@b.co' } }));
    const client = new AccountClient(service, { fetch });
    const result = await client.signUp('a@b.co', 'password1', 'http://127.0.0.1:5/cb', 'ch');
    expect(result).toEqual({ confirmEmail: true });
    expect(calls[0]?.url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5/cb');
  });
});

describe('AccountStore', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'davecode-account-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const session = {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: 10_000_000,
    user: { id: 'u', email: 'dev@example.com' },
  };

  it('encrypts the session at rest and reads it back', () => {
    const store = new AccountStore(home, {});
    store.save(session);
    const raw = readFileSync(accountFile(home), 'utf8');
    expect(raw).not.toContain('secret-access');
    expect(raw).not.toContain('dev@example.com');
    expect(new AccountStore(home, {}).load()).toEqual(session);
    store.clear();
    expect(store.load()).toBeUndefined();
  });

  it('treats a tampered file as signed out', () => {
    const store = new AccountStore(home, {});
    store.save(session);
    const file = JSON.parse(readFileSync(accountFile(home), 'utf8'));
    file.data = Buffer.from('tampered').toString('base64');
    writeFileSync(accountFile(home), JSON.stringify(file));
    expect(store.load()).toBeUndefined();
  });

  it('refreshes near expiry and signs out when the refresh token is revoked', async () => {
    const store = new AccountStore(home, {});
    store.save({ ...session, expiresAt: 1_000 });
    const ok = upstream(() => ({ body: sessionReply() }));
    const fresh = await store.current(new AccountClient(service, { fetch: ok.fetch }), 1_000);
    expect(fresh?.accessToken).toBe('access');
    expect(store.load()?.refreshToken).toBe('refresh');

    store.save({ ...session, expiresAt: 1_000 });
    const revoked = upstream(() => ({ status: 400, body: { error_description: 'revoked' } }));
    expect(
      await store.current(new AccountClient(service, { fetch: revoked.fetch }), 1_000),
    ).toBeUndefined();
    expect(store.load()).toBeUndefined();
  });

  it('keeps the cached identity while the service is unreachable', async () => {
    const store = new AccountStore(home, {});
    store.save({ ...session, expiresAt: 1_000 });
    const down = upstream(() => ({ status: 503, body: {} }));
    const kept = await store.current(new AccountClient(service, { fetch: down.fetch }), 1_000);
    expect(kept?.user.email).toBe('dev@example.com');
  });
});

describe('startAccountLogin', () => {
  it('opens the hosted page and listens only for the final redirect', async () => {
    const { fetch } = upstream(() => ({ body: sessionReply() }));
    const login = await startAccountLogin({ client: new AccountClient(service, { fetch }) });
    try {
      const url = new URL(login.url);
      expect(`${url.origin}${url.pathname}`).toBe(`${service.url}/login`);
      expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      const back = new URL(url.searchParams.get('redirect_to') ?? '');
      expect(back.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[\w-]+\/callback$/);
      // Nothing else is served locally.
      expect((await globalThis.fetch(new URL('/', back))).status).toBe(404);
    } finally {
      await login.close();
    }
  });

  it('exchanges the code and sends the browser to the hosted done page', async () => {
    const { fetch, calls } = upstream(() => ({ body: sessionReply() }));
    const login = await startAccountLogin({ client: new AccountClient(service, { fetch }) });
    const back = new URL(new URL(login.url).searchParams.get('redirect_to') ?? '');
    back.searchParams.set('code', 'from-github');
    const done = await globalThis.fetch(back, { redirect: 'manual' });
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe(`${service.url}/login/done`);
    expect((await login.session).user.email).toBe('dev@example.com');
    expect(calls.at(-1)?.body).toMatchObject({ auth_code: 'from-github' });
    await login.close();
  });

  it('reports a provider error and sends the browser to the failure page', async () => {
    const { fetch } = upstream(() => ({ body: sessionReply() }));
    const login = await startAccountLogin({ client: new AccountClient(service, { fetch }) });
    const back = new URL(new URL(login.url).searchParams.get('redirect_to') ?? '');
    back.searchParams.set('error_description', 'Sign-in was cancelled.');
    const res = await globalThis.fetch(back, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${service.url}/login/failed`);
    await expect(login.session).rejects.toThrow('Sign-in was cancelled.');
    await login.close();
  });

  it('rejects the session when cancelled', async () => {
    const { fetch } = upstream(() => ({ body: sessionReply() }));
    const login = await startAccountLogin({ client: new AccountClient(service, { fetch }) });
    await login.close();
    await expect(login.session).rejects.toBeInstanceOf(AccountError);
  });
});
