import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LoginProvider, LoginStatus, LoginUser } from '../types';

const credentials = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
const optionsSchema = z.object({
  origin: z
    .string()
    .url()
    .refine((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return (
        url.origin === value &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    }, 'Use an HTTPS origin, or HTTP on loopback, without a path or trailing slash'),
  providers: z
    .object({ google: credentials.optional(), github: credentials.optional() })
    .refine(
      (value) => Boolean(value.google || value.github),
      'Configure at least one login provider',
    ),
  allowedUsers: z.array(z.string().regex(/^(google|github):[^\s:]+$/)).min(1),
});

export type LoginOptions = z.infer<typeof optionsSchema>;

const ENDPOINTS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    user: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    user: 'https://api.github.com/user',
    scope: 'read:user',
  },
} as const;

const PENDING_MS = 10 * 60_000;
const SESSION_MS = 8 * 60 * 60_000;
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LoginError extends Error {
  constructor() {
    super('Sign-in could not be completed. Try again or contact the workspace owner.');
  }
}

/** In-memory, single-owner gateway login. Provider tokens are discarded after user lookup. */
export class LoginService {
  readonly options: LoginOptions;
  private readonly pending = new Map<
    string,
    { provider: LoginProvider; binding: string; verifier: string; expires: number }
  >();
  private readonly sessions = new Map<string, { user: LoginUser; expires: number }>();

  constructor(
    options: LoginOptions,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success)
      throw new Error(
        'Invalid login configuration: set a canonical origin, provider credentials and an allowed user list.',
      );
    this.options = parsed.data;
  }

  status(session?: string): LoginStatus {
    return {
      required: true,
      providers: (['google', 'github'] as const).filter(
        (provider) => this.options.providers[provider],
      ),
      user: this.user(session),
    };
  }

  user(session?: string): LoginUser | null {
    this.prune();
    return session ? (this.sessions.get(digest(session))?.user ?? null) : null;
  }

  logout(session?: string): void {
    if (session) this.sessions.delete(digest(session));
  }

  begin(provider: LoginProvider): { url: string; binding: string } {
    this.prune();
    const client = this.options.providers[provider];
    if (!client || this.pending.size >= 1000) throw new LoginError();
    const state = random();
    const binding = random();
    const verifier = random();
    this.pending.set(digest(state), {
      provider,
      binding: digest(binding),
      verifier,
      expires: this.now() + PENDING_MS,
    });
    const url = new URL(ENDPOINTS[provider].authorize);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.callback(provider),
      response_type: 'code',
      scope: ENDPOINTS[provider].scope,
      state,
      code_challenge: digest(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), binding };
  }

  async finish(
    provider: LoginProvider,
    state: string,
    code: string,
    binding: string,
  ): Promise<string> {
    this.prune();
    const flow = this.pending.get(digest(state));
    if (!flow || flow.provider !== provider || !equal(flow.binding, digest(binding)))
      throw new LoginError();
    this.pending.delete(digest(state));
    const client = this.options.providers[provider];
    if (!client) throw new LoginError();
    try {
      const response = await this.fetcher(ENDPOINTS[provider].token, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          code_verifier: flow.verifier,
          grant_type: 'authorization_code',
          redirect_uri: this.callback(provider),
        }),
      });
      if (!response.ok) throw new LoginError();
      const token = z
        .object({ access_token: z.string().min(1), token_type: z.string().regex(/^bearer$/i) })
        .parse(await response.json());
      const profile = await this.fetcher(ENDPOINTS[provider].user, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.access_token}`,
          'User-Agent': 'DaveCode',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!profile.ok) throw new LoginError();
      const data: unknown = await profile.json();
      let user: LoginUser;
      if (provider === 'google') {
        const parsed = z
          .object({ sub: z.string().min(1), name: z.string().max(200).optional() })
          .parse(data);
        user = { id: parsed.sub, provider, name: parsed.name ?? 'Google user' };
      } else {
        const parsed = z
          .object({
            id: z.number().int().positive(),
            login: z.string().min(1).max(200),
            name: z.string().max(200).nullable().optional(),
          })
          .parse(data);
        user = { id: String(parsed.id), provider, name: parsed.name || parsed.login };
      }
      if (
        !this.options.allowedUsers.includes(`${provider}:${user.id}`) ||
        this.sessions.size >= 1000
      )
        throw new LoginError();
      const session = random();
      this.sessions.set(digest(session), { user, expires: this.now() + SESSION_MS });
      return session;
    } catch {
      // Upstream bodies, credentials and authorization codes never reach logs or clients.
      throw new LoginError();
    }
  }

  clear(): void {
    this.pending.clear();
    this.sessions.clear();
  }

  private callback(provider: LoginProvider): string {
    return `${this.options.origin}/api/auth/${provider}/callback`;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expires <= now) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
  }
}

/** Read only dedicated auth variables. No credentials are exposed in validation errors. */
export function loginFromEnv(env: NodeJS.ProcessEnv): LoginService | undefined {
  if (env.DAVECODE_LOGIN_ENABLED !== '1') return undefined;
  const providers: LoginOptions['providers'] = {};
  for (const [provider, prefix] of [
    ['google', 'GOOGLE'],
    ['github', 'GITHUB'],
  ] as const) {
    const clientId = env[`DAVECODE_${prefix}_CLIENT_ID`];
    const clientSecret = env[`DAVECODE_${prefix}_CLIENT_SECRET`];
    if (clientId || clientSecret)
      providers[provider] = { clientId: clientId ?? '', clientSecret: clientSecret ?? '' };
  }
  return new LoginService({
    origin: env.DAVECODE_PUBLIC_ORIGIN ?? '',
    providers,
    allowedUsers: (env.DAVECODE_LOGIN_ALLOWED_USERS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
}
