import { AccountClient, pkcePair, startAccountLogin } from '@davecode/core';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, signJwt, verifyJwt, verifyPassword } from './crypto';
import { type Env, handle, migrate, type SendEmail } from './index';
import type { D1Like, D1Statement } from './store';

/** D1's prepare/bind/first/run over an in-memory SQLite database. */
function sqliteD1(): D1Like {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const statement = (sql: string, values: unknown[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...(values as [])) as T | undefined) ?? null,
    run: async () => db.prepare(sql).run(...(values as [])),
  });
  return { prepare: (sql) => statement(sql) };
}

const ORIGIN = 'https://auth.davecode.test';

interface Sent {
  to: string;
  subject: string;
  text: string;
}

let env: Env;
let mail: Sent[];
let clock: number;

/** GitHub and Google as the worker sees them; everything else goes to the worker itself. */
function upstream(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
  if (url.hostname === 'github.com') return ok({ access_token: 'gh-token' });
  if (url.pathname === '/user') return ok({ id: 42, login: 'octo', name: 'Octo Cat' });
  if (url.pathname === '/user/emails') {
    return ok([
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'octo@example.com', primary: true, verified: true },
    ]);
  }
  if (url.hostname === 'oauth2.googleapis.com') return ok({ access_token: 'g-token' });
  if (url.hostname === 'openidconnect.googleapis.com') {
    return ok({ sub: 'g-1', email: 'octo@example.com', email_verified: true, name: 'Octo' });
  }
  if (url.origin === ORIGIN) {
    return handle(new Request(url, init), env, { now: () => clock, fetch: upstream });
  }
  return globalThis.fetch(input, init);
}

const call = (path: string, init?: RequestInit) => upstream(`${ORIGIN}${path}`, init);
beforeEach(async () => {
  mail = [];
  clock = 1_800_000_000_000;
  const email: SendEmail = {
    send: async (m) => {
      mail.push({ to: m.to, subject: m.subject, text: m.text });
      return {};
    },
  };
  env = {
    DB: sqliteD1(),
    EMAIL: email,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hmac',
    PUBLIC_URL: ORIGIN,
    GITHUB_CLIENT_ID: 'gh-id',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GOOGLE_CLIENT_ID: 'g-id',
    GOOGLE_CLIENT_SECRET: 'g-secret',
  };
  await migrate(env.DB);
});

const client = () =>
  new AccountClient(
    { url: ORIGIN, publishableKey: 'davecode-cli' },
    { fetch: upstream as typeof fetch },
  );

/** What a browser does with the hosted page: find a link by its text, without escapes. */
async function linkOn(path: string, text: string): Promise<string> {
  const html = await (await call(path)).text();
  const href = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].find((m) =>
    m[2]?.endsWith(text),
  )?.[1];
  expect(href, `link "${text}"`).toBeDefined();
  return (href ?? '').replace(/&amp;/g, '&');
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/** Hand the provider's redirect to the CLI listener; returns the hosted page it sends us to. */
async function toLoopback(location: string): Promise<string> {
  const done = await fetch(location, { redirect: 'manual' });
  return (await call(pathOf(done.headers.get('location') ?? ''))).text();
}

/** Follow the browser from the hosted page through GitHub and back to the CLI. */
async function browserGitHub(loginUrl: string): Promise<string> {
  const authorize = await call(await linkOn(pathOf(loginUrl), 'Continue with GitHub'));
  const atGitHub = new URL(authorize.headers.get('location') ?? '');
  expect(atGitHub.hostname).toBe('github.com');
  const callback = new URL(atGitHub.searchParams.get('redirect_uri') ?? '');
  callback.searchParams.set('code', 'from-github');
  callback.searchParams.set('state', atGitHub.searchParams.get('state') ?? '');
  const back = await call(callback.pathname + callback.search);
  return toLoopback(back.headers.get('location') ?? '');
}

/** Submit the hosted email form the way a browser does. */
function submit(loginUrl: string, fields: Record<string, string>, origin = ORIGIN) {
  const params = new URL(loginUrl).searchParams;
  return call('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({
      redirect_to: params.get('redirect_to') ?? '',
      code_challenge: params.get('code_challenge') ?? '',
      email: 'Dev@Example.com',
      password: 'hunter2hunter2',
      ...fields,
    }),
  });
}

describe('crypto', () => {
  it('hashes passwords with a salt and verifies them', async () => {
    const a = await hashPassword('correct horse');
    expect(a).not.toBe(await hashPassword('correct horse'));
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
  });

  it('signs and verifies JWTs and rejects tampering and expiry', async () => {
    const token = await signJwt({ sub: 'u', sid: 's', iat: 1, exp: 2_000_000_000, iss: 'x' }, 'k');
    expect((await verifyJwt(token, 'k', 1_000))?.sub).toBe('u');
    expect(await verifyJwt(token, 'other', 1_000)).toBeUndefined();
    expect(await verifyJwt(`${token}x`, 'k', 1_000)).toBeUndefined();
    expect(await verifyJwt(token, 'k', 2_000_000_001_000)).toBeUndefined();
  });
});

describe('auth worker with the real CLI client', () => {
  it('signs in with GitHub through the hosted page, then refreshes and logs out', async () => {
    const login = await startAccountLogin({ client: client() });
    expect(login.url.startsWith(`${ORIGIN}/login?`)).toBe(true);
    const page = await (await call(pathOf(login.url))).text();
    expect(page).toContain('Continue with Google');
    expect(page).not.toMatch(/Continue with Apple|<script/i);
    expect(await browserGitHub(login.url)).toContain('You are signed in');
    const session = await login.session;
    expect(session.user).toMatchObject({
      email: 'octo@example.com',
      name: 'Octo Cat',
      provider: 'github',
    });

    const refreshed = await client().refresh(session.refreshToken);
    expect(refreshed.user.email).toBe('octo@example.com');
    // A rotated refresh token cannot be used twice; reusing it ends the session.
    await expect(client().refresh(session.refreshToken)).rejects.toMatchObject({ status: 400 });
    await expect(client().refresh(refreshed.refreshToken)).rejects.toMatchObject({ status: 400 });
    await login.close();
  });

  it('links Google to the same account by verified email', async () => {
    const first = await startAccountLogin({ client: client() });
    await browserGitHub(first.url);
    const github = await first.session;
    await first.close();

    const { challenge, verifier } = pkcePair();
    const redirect = 'http://127.0.0.1:5555/s/x/callback';
    const authorize = await call(
      `/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
    );
    const atGoogle = new URL(authorize.headers.get('location') ?? '');
    expect(atGoogle.hostname).toBe('accounts.google.com');
    const back = await call(
      `/auth/v1/callback/google?code=g&state=${atGoogle.searchParams.get('state')}`,
    );
    const code = new URL(back.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const google = await client().exchangeCode(code, verifier);
    expect(google.user.id).toBe(github.user.id);
    // The code is single use and bound to the verifier.
    await expect(client().exchangeCode(code, verifier)).rejects.toMatchObject({ status: 400 });
  });

  it('creates an email account only after the emailed link is opened', async () => {
    const login = await startAccountLogin({ client: client() });
    // Only the hosted page itself may post the form.
    expect(
      await (await submit(login.url, { mode: 'signup' }, 'https://evil.test')).text(),
    ).toContain('Sign-in link not valid');
    expect(mail).toHaveLength(0);

    expect(await (await submit(login.url, { mode: 'signup' })).text()).toContain(
      'Check your email',
    );
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe('dev@example.com');
    expect(await (await submit(login.url, { mode: 'signin' })).text()).toContain(
      'Confirm your email first, using the link we sent you.',
    );

    const link = new URL(mail[0]?.text.match(/https:\S+/)?.[0] ?? '');
    const confirmed = await call(link.pathname + link.search);
    const html = await confirmed.text();
    expect(html).toContain('Email confirmed');
    const target = html.match(/url=([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? '';
    expect(await toLoopback(target)).toContain('You are signed in');
    expect((await login.session).user.email).toBe('dev@example.com');
    await login.close();

    // The hosted form signs in with the password, straight back to the CLI.
    const again = await startAccountLogin({ client: client() });
    const wrong = await submit(again.url, { mode: 'signin', password: 'nope-nope' });
    expect(await wrong.text()).toContain('Invalid email or password.');
    const right = await submit(again.url, { mode: 'signin' });
    expect(right.status).toBe(303);
    await toLoopback(right.headers.get('location') ?? '');
    expect((await again.session).user.email).toBe('dev@example.com');
    await again.close();

    // Afterwards the password works, and a wrong one gets the same generic answer.
    const ok = await client().signInWithPassword('dev@example.com', 'hunter2hunter2');
    expect(ok.user.provider).toBe('email');
    await expect(client().signInWithPassword('dev@example.com', 'nope-nope')).rejects.toMatchObject(
      { message: 'Invalid email or password.' },
    );
    await expect(
      client().signInWithPassword('nobody@example.com', 'nope-nope'),
    ).rejects.toMatchObject({ message: 'Invalid email or password.' });
  });

  it('says so when the confirmation email cannot be sent', async () => {
    env.EMAIL = {
      send: async () => {
        throw new Error('domain not verified');
      },
    };
    const { challenge } = pkcePair();
    await expect(
      client().signUp(
        'new@example.com',
        'hunter2hunter2',
        'http://127.0.0.1:5555/s/x/callback',
        challenge,
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: 'We could not send the confirmation email. Try again in a few minutes.',
    });
  });

  it('does not reveal that an email is taken', async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, email_verified, created_at) VALUES ('u1', 'taken@example.com', 1, 0)",
    ).run();
    const { challenge } = pkcePair();
    const reply = await client().signUp(
      'taken@example.com',
      'hunter2hunter2',
      'http://127.0.0.1:5555/s/x/callback',
      challenge,
    );
    expect(reply).toEqual({ confirmEmail: true });
    expect(mail[0]?.subject).toBe('You already have a DaveCode account');
  });

  it('only redirects to the CLI loopback and reports disabled providers', async () => {
    const { challenge } = pkcePair();
    const evil = await call(
      `/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent('https://evil.test/cb')}&code_challenge=${challenge}`,
    );
    expect(evil.status).toBe(200);
    expect(await evil.text()).toContain('Sign-in link not valid');

    env.GOOGLE_CLIENT_ID = undefined;
    const settings = (await (await call('/auth/v1/settings')).json()) as {
      external: Record<string, boolean>;
    };
    expect(settings.external).toEqual({ email: true, github: true, google: false });
    const disabled = await call(
      `/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent('http://127.0.0.1:5555/s/x/callback')}&code_challenge=${challenge}`,
    );
    expect(new URL(disabled.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'provider_disabled',
    );
  });

  it('expires one-time codes', async () => {
    const login = await startAccountLogin({ client: client() });
    const authorize = await call(await linkOn(pathOf(login.url), 'Continue with GitHub'));
    const state = new URL(authorize.headers.get('location') ?? '').searchParams.get('state');
    clock += 11 * 60_000;
    const late = await call(`/auth/v1/callback/github?code=c&state=${state}`);
    expect(await late.text()).toContain('Sign-in expired');
    await login.close();
  });
});
