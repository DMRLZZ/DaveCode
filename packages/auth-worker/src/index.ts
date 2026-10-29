import { hashPassword, randomToken, sha256, signJwt, verifyJwt, verifyPassword } from './crypto';
import { OAuthError, type Provider, providerAuthorizeUrl, providerProfile } from './oauth';
import { loginPage, messagePage } from './pages';
import { SCHEMA } from './schema';
import { type D1Like, Store, type User } from './store';

/**
 * DaveCode accounts: the endpoints the CLI's AccountClient speaks (a subset of Supabase Auth's
 * REST shape), served from Cloudflare Workers with D1.
 *
 *   GET  /login?redirect_to&code_challenge[&mode]   the sign-in page `davecode login` opens
 *   POST /login                                      its email form
 *   GET  /login/done, /login/failed                  where the CLI sends the browser at the end
 *   GET  /auth/v1/settings                          enabled sign-in methods
 *   GET  /auth/v1/authorize?provider&redirect_to&code_challenge
 *   GET  /auth/v1/callback/:provider                 provider redirect target
 *   GET  /auth/v1/verify?token                       email confirmation link
 *   POST /auth/v1/signup?redirect_to                 email + password
 *   POST /auth/v1/token?grant_type=pkce|password|refresh_token
 *   POST /auth/v1/logout                             Bearer access token
 *
 * Sessions only ever return to the CLI's loopback server (127.0.0.1 or localhost), bound to
 * the PKCE challenge the CLI generated, so a code is useless to anyone else.
 */

export interface SendEmail {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Like;
  EMAIL?: SendEmail;
  RATE_LIMITER?: RateLimiter;
  JWT_SECRET: string;
  /** Public origin of this worker, e.g. https://auth.davecode.app */
  PUBLIC_URL: string;
  EMAIL_FROM?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface Deps {
  now?: () => number;
  fetch?: typeof fetch;
}

const ACCESS_TTL_SECONDS = 3600;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/[\w/-]*$/;
const CHALLENGE = /^[\w-]{43}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const fail = (status: number, error: string, description: string) =>
  json({ error, error_description: description }, status);

function credentials(env: Env, provider: Provider) {
  const [clientId, clientSecret] =
    provider === 'google'
      ? [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET]
      : [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function page(title: string, message: string, extraHead = ''): Response {
  const escapeHtml = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<title>${escapeHtml(title)} · DaveCode</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#000;color:#f5f5f5;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px}main{max-width:380px}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#8a8a8a;margin:0}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}

function withParams(target: string, params: Record<string, string>): string {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function publicUser(user: User, provider: string) {
  return {
    id: user.id,
    email: user.email,
    app_metadata: { provider },
    user_metadata: user.name ? { full_name: user.name } : {},
  };
}

async function session(
  env: Env,
  store: Store,
  user: User,
  provider: string,
  now: number,
  /** Refreshes keep their session, so revoking it covers every rotated token. */
  sessionId: string = crypto.randomUUID(),
) {
  const iat = Math.floor(now / 1000);
  const accessToken = await signJwt(
    {
      sub: user.id,
      email: user.email,
      sid: sessionId,
      iat,
      exp: iat + ACCESS_TTL_SECONDS,
      iss: env.PUBLIC_URL,
    },
    env.JWT_SECRET,
  );
  return json({
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: await store.issueRefresh(user.id, provider, sessionId),
    user: publicUser(user, provider),
  });
}

async function limited(env: Env, request: Request, bucket: string): Promise<boolean> {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  return !(await env.RATE_LIMITER.limit({ key: `${bucket}:${ip}` })).success;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

let dummy: Promise<string> | undefined;
/** A real hash of a random password, compared against when an email has no account. */
const dummyHash = () => {
  dummy ??= hashPassword(randomToken());
  return dummy;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendVerification(env: Env, to: string, link: string): Promise<void> {
  if (!env.EMAIL) throw new Error('email_unavailable');
  await env.EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM ?? 'accounts@davecode.app', name: 'DaveCode' },
    subject: 'Confirm your DaveCode account',
    text: `Confirm your email to finish creating your DaveCode account:\n\n${link}\n\nThe link works for 24 hours. If you did not sign up, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px"><h2 style="font-weight:600">Confirm your DaveCode account</h2><p>Confirm your email to finish creating your account.</p><p><a href="${link}" style="display:inline-block;background:#000;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm email</a></p><p style="color:#666;font-size:13px">The link works for 24 hours. If you did not sign up, ignore this email.</p></div>`,
  });
}

async function sendExisting(env: Env, to: string): Promise<void> {
  if (!env.EMAIL) return;
  await env.EMAIL.send({
    to,
    from: { email: env.EMAIL_FROM ?? 'accounts@davecode.app', name: 'DaveCode' },
    subject: 'You already have a DaveCode account',
    text: 'Someone tried to create a DaveCode account with this email, which already has one. Sign in with davecode login instead. If this was not you, you can ignore this email.',
    html: '<div style="font-family:system-ui,sans-serif;max-width:420px"><h2 style="font-weight:600">You already have an account</h2><p>Someone tried to create a DaveCode account with this email. Sign in with <code>davecode login</code> instead.</p><p style="color:#666;font-size:13px">If this was not you, you can ignore this email.</p></div>',
  });
}

type Failure = { status: number; error: string; description: string };

const TOO_MANY: Failure = {
  status: 429,
  error: 'over_request_rate_limit',
  description: 'Too many attempts. Wait a minute and try again.',
};

async function readForm(request: Request): Promise<Map<string, string>> {
  const fields = new Map<string, string>();
  try {
    for (const [key, value] of await request.formData()) {
      if (typeof value === 'string') fields.set(key, value);
    }
  } catch {
    // Not a form: every field is missing.
  }
  return fields;
}

/** Create (or re-claim an unconfirmed) email account and send its confirmation link. */
async function emailSignUp(
  env: Env,
  store: Store,
  request: Request,
  input: { email: string; password: string; redirectTo: string; challenge: string },
): Promise<{ id: string; email: string } | Failure> {
  if (await limited(env, request, 'signup')) return TOO_MANY;
  const email = input.email.trim().toLowerCase();
  const { password, redirectTo, challenge } = input;
  if (!EMAIL.test(email) || email.length > 320) {
    return { status: 400, error: 'validation_failed', description: 'Enter a valid email address.' };
  }
  if (password.length < 8 || password.length > 200) {
    return {
      status: 400,
      error: 'weak_password',
      description: 'Use a password of at least 8 characters.',
    };
  }
  if (!LOOPBACK.test(redirectTo) || !CHALLENGE.test(challenge)) {
    return {
      status: 400,
      error: 'validation_failed',
      description: 'Start again from your terminal with davecode login.',
    };
  }
  if (!env.EMAIL) {
    return {
      status: 503,
      error: 'email_unavailable',
      description: 'Email sign-up is not available yet.',
    };
  }
  const existing = await store.userByEmail(email);
  if (existing?.email_verified) {
    // Same reply as a new sign-up, so nobody can probe which emails have accounts.
    await sendExisting(env, email);
    return { id: crypto.randomUUID(), email };
  }
  const passwordHash = await hashPassword(password);
  const user = existing ?? (await store.createUser({ email, verified: false, passwordHash }));
  // An unconfirmed account can be claimed again: only whoever reads the inbox finishes it.
  if (existing) await store.setPassword(existing.id, passwordHash);
  const token = await store.saveVerification(user.id, redirectTo, challenge);
  try {
    await sendVerification(env, email, `${env.PUBLIC_URL}/auth/v1/verify?token=${token}`);
  } catch {
    return {
      status: 503,
      error: 'email_unavailable',
      description: 'We could not send the confirmation email. Try again in a few minutes.',
    };
  }
  return { id: user.id, email };
}

/** Check an email and password; only confirmed accounts may sign in. */
async function emailSignIn(
  env: Env,
  store: Store,
  request: Request,
  email: string,
  password: string,
): Promise<User | Failure> {
  if (await limited(env, request, 'password')) return TOO_MANY;
  const user = await store.userByEmail(email.trim().toLowerCase());
  // Hash even when the account does not exist, so timing does not reveal which emails do.
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
  if (!user?.password_hash || !ok) {
    return { status: 400, error: 'invalid_grant', description: 'Invalid email or password.' };
  }
  if (!user.email_verified) {
    return {
      status: 400,
      error: 'email_not_confirmed',
      description: 'Confirm your email first, using the link we sent you.',
    };
  }
  return user;
}

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const fetcher = deps.fetch ?? fetch;
  const store = new Store(env.DB, () => now);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const callbackFor = (provider: Provider) => `${env.PUBLIC_URL}/auth/v1/callback/${provider}`;

  if (request.method === 'GET' && (path === '' || path === '/health')) {
    return json({ status: 'ok' });
  }

  const enabled = {
    email: Boolean(env.EMAIL),
    github: Boolean(credentials(env, 'github')),
    google: Boolean(credentials(env, 'google')),
  };
  const invalidLink = () =>
    messagePage('Sign-in link not valid', 'Start again from your terminal with davecode login.');

  if (request.method === 'GET' && path === '/login') {
    const redirectTo = url.searchParams.get('redirect_to') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    if (!LOOPBACK.test(redirectTo) || !CHALLENGE.test(challenge)) return invalidLink();
    const mode = url.searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
    return loginPage({ redirectTo, challenge, mode, providers: enabled });
  }

  if (request.method === 'POST' && path === '/login') {
    // Only this site's own form may post here.
    if (request.headers.get('Origin') !== new URL(env.PUBLIC_URL).origin) return invalidLink();
    const form = await readForm(request);
    const redirectTo = form.get('redirect_to') ?? '';
    const challenge = form.get('code_challenge') ?? '';
    if (!LOOPBACK.test(redirectTo) || !CHALLENGE.test(challenge)) return invalidLink();
    const mode = form.get('mode') === 'signup' ? 'signup' : 'signin';
    const email = (form.get('email') ?? '').trim();
    const password = form.get('password') ?? '';
    const again = (error: string) =>
      loginPage({ redirectTo, challenge, mode, providers: enabled, email, error });
    if (mode === 'signup') {
      const result = await emailSignUp(env, store, request, {
        email,
        password,
        redirectTo,
        challenge,
      });
      if ('error' in result) return again(result.description);
      return messagePage(
        'Check your email',
        `We sent a confirmation link to ${result.email}. Open it on this computer to finish signing in.`,
      );
    }
    const user = await emailSignIn(env, store, request, email, password);
    if ('error' in user) return again(user.description);
    const code = await store.issueCode(user.id, challenge, 'email');
    return Response.redirect(withParams(redirectTo, { code }), 303);
  }

  if (request.method === 'GET' && path === '/login/done') {
    return messagePage('You are signed in', 'Return to your terminal. You can close this tab.');
  }

  if (request.method === 'GET' && path === '/login/failed') {
    return messagePage(
      'Sign-in did not finish',
      'Your terminal says what went wrong. Run davecode login to try again.',
    );
  }

  if (request.method === 'GET' && path === '/auth/v1/settings') {
    return json({ external: enabled });
  }

  if (request.method === 'GET' && path === '/auth/v1/authorize') {
    const provider = url.searchParams.get('provider') as Provider;
    const redirectTo = url.searchParams.get('redirect_to') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    if (!LOOPBACK.test(redirectTo) || !CHALLENGE.test(challenge)) {
      return page('Sign-in link not valid', 'Start again from your terminal with davecode login.');
    }
    const creds =
      provider === 'google' || provider === 'github' ? credentials(env, provider) : undefined;
    if (!creds) {
      return Response.redirect(
        withParams(redirectTo, {
          error: 'provider_disabled',
          error_description: 'This sign-in method is not available yet. Use email instead.',
        }),
        302,
      );
    }
    const state = await store.saveState(provider, redirectTo, challenge);
    return Response.redirect(
      providerAuthorizeUrl(provider, creds, callbackFor(provider), state),
      302,
    );
  }

  if (request.method === 'GET' && path.startsWith('/auth/v1/callback/')) {
    const provider = path.slice('/auth/v1/callback/'.length) as Provider;
    const pending = await store.takeState(url.searchParams.get('state') ?? '');
    if (!pending || pending.provider !== provider) {
      return page('Sign-in expired', 'Start again from your terminal with davecode login.');
    }
    const back = (params: Record<string, string>) =>
      Response.redirect(withParams(pending.redirect_to, params), 302);
    const code = url.searchParams.get('code');
    const creds = credentials(env, provider);
    if (!code || !creds) {
      return back({ error: 'access_denied', error_description: 'Sign-in was cancelled.' });
    }
    let profile: Awaited<ReturnType<typeof providerProfile>>;
    try {
      profile = await providerProfile(provider, creds, code, callbackFor(provider), fetcher);
    } catch (err) {
      const reason = err instanceof OAuthError ? err.message : 'provider error';
      return back({ error: 'server_error', error_description: `Sign-in failed: ${reason}.` });
    }
    let user = await store.identity(provider, profile.subject);
    if (!user) {
      if (!profile.email || !profile.emailVerified) {
        return back({
          error: 'email_unverified',
          error_description: `Your ${provider} account has no verified email. Verify one, or use email sign-in.`,
        });
      }
      user = await store.userByEmail(profile.email);
      if (user) await store.markVerified(user.id, profile.name);
      else {
        user = await store.createUser({
          email: profile.email,
          verified: true,
          ...(profile.name ? { name: profile.name } : {}),
        });
      }
      await store.link(provider, profile.subject, user.id);
    }
    return back({ code: await store.issueCode(user.id, pending.challenge, provider) });
  }

  if (request.method === 'GET' && path === '/auth/v1/verify') {
    const pending = await store.takeVerification(url.searchParams.get('token') ?? '');
    if (!pending) {
      return page('Link expired', 'Sign up again from your terminal with davecode login.');
    }
    await store.markVerified(pending.user_id);
    const code = await store.issueCode(pending.user_id, pending.challenge, 'email');
    const target = withParams(pending.redirect_to, { code });
    // An intermediate page: if the terminal stopped waiting, the user still learns it worked.
    return page(
      'Email confirmed',
      'Returning you to DaveCode. If nothing happens, run davecode login and sign in with your email.',
      `<meta http-equiv="refresh" content="1;url=${target.replace(/"/g, '&quot;')}">`,
    );
  }

  if (request.method === 'POST' && path === '/auth/v1/signup') {
    const body = await readJson(request);
    const result = await emailSignUp(env, store, request, {
      email: str(body.email),
      password: str(body.password),
      redirectTo: url.searchParams.get('redirect_to') ?? '',
      challenge: str(body.code_challenge),
    });
    return 'error' in result ? fail(result.status, result.error, result.description) : json(result);
  }

  if (request.method === 'POST' && path === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');
    const body = await readJson(request);

    if (grant === 'pkce') {
      const pending = await store.takeCode(str(body.auth_code));
      if (!pending || (await sha256(str(body.code_verifier))) !== pending.challenge) {
        return fail(400, 'invalid_grant', 'Sign-in expired. Run davecode login again.');
      }
      const user = await store.userById(pending.user_id);
      if (!user) return fail(400, 'invalid_grant', 'Account not found.');
      return session(env, store, user, pending.provider, now);
    }

    if (grant === 'password') {
      const user = await emailSignIn(env, store, request, str(body.email), str(body.password));
      if ('error' in user) return fail(user.status, user.error, user.description);
      return session(env, store, user, 'email', now);
    }

    if (grant === 'refresh_token') {
      const previous = await store.rotateRefresh(str(body.refresh_token));
      const user = previous ? await store.userById(previous.user_id) : null;
      if (!previous || !user) return fail(400, 'invalid_grant', 'Session expired. Sign in again.');
      return session(env, store, user, previous.provider, now, previous.session_id);
    }

    return fail(400, 'unsupported_grant_type', 'Unsupported grant type.');
  }

  if (request.method === 'POST' && path === '/auth/v1/logout') {
    const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const claims = await verifyJwt(token, env.JWT_SECRET, now);
    if (claims) await store.revokeSession(claims.sid);
    return new Response(null, { status: 204 });
  }

  return fail(404, 'not_found', 'Not found.');
}

/** Create the tables (idempotent). Run once per deploy. */
export async function migrate(db: D1Like): Promise<void> {
  for (const statement of SCHEMA) await db.prepare(statement).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      return fail(500, 'server_error', 'Something went wrong. Try again.');
    }
  },
};
