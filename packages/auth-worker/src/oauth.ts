export type Provider = 'google' | 'github';

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** What DaveCode keeps from a provider: a stable subject and, when verified, the email. */
export interface ProviderProfile {
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export class OAuthError extends Error {}

const ENDPOINTS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
} as const;

export function providerAuthorizeUrl(
  provider: Provider,
  credentials: ProviderCredentials,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(ENDPOINTS[provider].authorize);
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', ENDPOINTS[provider].scope);
  url.searchParams.set('response_type', 'code');
  if (provider === 'google') url.searchParams.set('prompt', 'select_account');
  if (provider === 'github') url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new OAuthError(`${what} failed (HTTP ${response.status})`);
  return (await response.json()) as T;
}

/** Exchange the provider's code and read the profile. `fetcher` is injectable for tests. */
export async function providerProfile(
  provider: Provider,
  credentials: ProviderCredentials,
  code: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<ProviderProfile> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const token = await json<{ access_token?: string; error?: string }>(
    await fetcher(ENDPOINTS[provider].token, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }),
    'Token exchange',
  );
  if (!token.access_token) throw new OAuthError(token.error ?? 'No access token');
  const auth = { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'DaveCode' };

  if (provider === 'google') {
    const info = await json<{
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
    }>(
      await fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth }),
      'Google profile',
    );
    return {
      subject: info.sub,
      ...(info.email ? { email: info.email } : {}),
      emailVerified: info.email_verified === true,
      ...(info.name ? { name: info.name } : {}),
    };
  }

  const user = await json<{ id: number; login: string; name?: string | null }>(
    await fetcher('https://api.github.com/user', {
      headers: { ...auth, Accept: 'application/vnd.github+json' },
    }),
    'GitHub profile',
  );
  const emails = await json<Array<{ email: string; primary: boolean; verified: boolean }>>(
    await fetcher('https://api.github.com/user/emails', {
      headers: { ...auth, Accept: 'application/vnd.github+json' },
    }),
    'GitHub emails',
  );
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  return {
    subject: String(user.id),
    ...(primary ? { email: primary.email } : {}),
    emailVerified: Boolean(primary),
    name: user.name ?? user.login,
  };
}
