import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Where DaveCode accounts live: a Supabase Auth project and its public (publishable) key. */
export interface AccountServiceConfig {
  url: string;
  publishableKey: string;
}

/**
 * The hosted account service. The publishable key is public by design (it only identifies the
 * project); every request still needs the user's own credentials. `DAVECODE_ACCOUNT_URL` and
 * `DAVECODE_ACCOUNT_KEY` point a build at another project (development, tests).
 */
export const ACCOUNT_SERVICE: AccountServiceConfig = {
  url: 'https://auth.davecode.app',
  publishableKey: 'davecode-cli',
};

export function accountService(
  env: NodeJS.ProcessEnv = process.env,
): AccountServiceConfig | undefined {
  const url = env.DAVECODE_ACCOUNT_URL ?? ACCOUNT_SERVICE.url;
  const publishableKey = env.DAVECODE_ACCOUNT_KEY ?? ACCOUNT_SERVICE.publishableKey;
  return url && publishableKey ? { url: url.replace(/\/+$/, ''), publishableKey } : undefined;
}

export type OAuthProvider = 'google' | 'github';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'github'];

export interface AccountUser {
  id: string;
  email?: string;
  name?: string;
  /** How the account signs in: `google`, `github` or `email`. */
  provider?: string;
}

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  user: AccountUser;
}

/** Upstream rejections, mapped to a message that is safe to show. */
export class AccountError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

const userSchema = z.object({
  id: z.string().min(1),
  email: z.string().optional().nullable(),
  app_metadata: z.object({ provider: z.string().optional() }).passthrough().optional(),
  user_metadata: z
    .object({ full_name: z.string().optional(), name: z.string().optional() })
    .passthrough()
    .optional(),
});

const sessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  user: userSchema,
});

const settingsSchema = z.object({ external: z.record(z.string(), z.boolean()) });

const errorSchema = z
  .object({
    error_description: z.string().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function toSession(raw: unknown, now: number): AccountSession {
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) throw new AccountError('The account service sent an unexpected reply.');
  const { user } = parsed.data;
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now + parsed.data.expires_in * 1000,
    user: {
      id: user.id,
      ...(user.email ? { email: user.email } : {}),
      ...((user.user_metadata?.full_name ?? user.user_metadata?.name)
        ? { name: (user.user_metadata?.full_name ?? user.user_metadata?.name) as string }
        : {}),
      ...(user.app_metadata?.provider ? { provider: user.app_metadata.provider } : {}),
    },
  };
}

export interface AccountClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Signs-up result: a session, or a pending confirmation e-mail. */
export type SignUpResult = { session: AccountSession } | { confirmEmail: true };

/** Thin client for the Supabase Auth REST endpoints DaveCode needs. */
export class AccountClient {
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    readonly service: AccountServiceConfig,
    options: AccountClientOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The hosted sign-in page (Google, GitHub or email). Every method ends by sending the browser
   * to `redirectTo` with `?code=` bound to `challenge`.
   */
  loginUrl(redirectTo: string, challenge: string): string {
    const url = new URL(`${this.service.url}/login`);
    url.searchParams.set('redirect_to', redirectTo);
    url.searchParams.set('code_challenge', challenge);
    return url.toString();
  }

  /** A page of the hosted service, such as `/login/done`. */
  pageUrl(path: string): string {
    return `${this.service.url}${path}`;
  }

  /** Browser URL that starts Google or GitHub sign-in and returns to `redirectTo` with `?code=`. */
  authorizeUrl(provider: OAuthProvider, redirectTo: string, challenge: string): string {
    const url = new URL(`${this.service.url}/auth/v1/authorize`);
    url.searchParams.set('provider', provider);
    url.searchParams.set('redirect_to', redirectTo);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 's256');
    return url.toString();
  }

  exchangeCode(code: string, verifier: string): Promise<AccountSession> {
    return this.session('token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
  }

  signInWithPassword(email: string, password: string): Promise<AccountSession> {
    return this.session('token?grant_type=password', { email, password });
  }

  /** Create an e-mail account. With confirmation on, the link returns to `redirectTo`. */
  async signUp(
    email: string,
    password: string,
    redirectTo: string,
    challenge: string,
  ): Promise<SignUpResult> {
    const raw = await this.post(`signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
      email,
      password,
      code_challenge: challenge,
      code_challenge_method: 's256',
    });
    if (sessionSchema.safeParse(raw).success) return { session: toSession(raw, this.now()) };
    return { confirmEmail: true };
  }

  /** Sign-in methods the service has enabled; on any failure, assume all of them. */
  async providers(): Promise<OAuthProvider[]> {
    try {
      const response = await this.fetch(`${this.service.url}/auth/v1/settings`, {
        headers: { apikey: this.service.publishableKey },
        signal: AbortSignal.timeout(10_000),
      });
      const parsed = settingsSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) return [...OAUTH_PROVIDERS];
      return OAUTH_PROVIDERS.filter((p) => parsed.data.external[p] !== false);
    } catch {
      return [...OAUTH_PROVIDERS];
    }
  }

  refresh(refreshToken: string): Promise<AccountSession> {
    return this.session('token?grant_type=refresh_token', { refresh_token: refreshToken });
  }

  /** Revoke the session on the server. Best effort: the local copy is removed regardless. */
  async signOut(accessToken: string): Promise<void> {
    await this.fetch(`${this.service.url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: this.service.publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  private async session(path: string, body: unknown): Promise<AccountSession> {
    return toSession(await this.post(path, body), this.now());
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(`${this.service.url}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: this.service.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AccountError('Cannot reach the DaveCode account service. Check your connection.');
    }
    const raw: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = errorSchema.safeParse(raw);
      const detail = error.success
        ? (error.data.error_description ?? error.data.msg ?? error.data.message)
        : undefined;
      throw new AccountError(
        detail ?? `Sign-in failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    return raw;
  }
}
