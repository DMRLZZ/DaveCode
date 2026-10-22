import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LoginError, type LoginOptions, LoginService, loginFromEnv } from './login';

const options: LoginOptions = {
  origin: 'http://localhost:4040',
  providers: {
    google: { clientId: 'google-id', clientSecret: 'google-secret' },
    github: { clientId: 'github-id', clientSecret: 'github-secret' },
  },
  allowedUsers: ['google:subject-1', 'github:42'],
};

function setup(profile: unknown = { sub: 'subject-1', name: 'Dave' }) {
  let now = 1000;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'private-token', token_type: 'Bearer' }))
    .mockResolvedValueOnce(Response.json(profile));
  const service = new LoginService(options, fetcher, () => now);
  return {
    service,
    fetcher,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('LoginService', () => {
  it.each(['google', 'github'] as const)(
    'exchanges %s code with PKCE, keeps only an allowed identity and invalidates logout',
    async (provider) => {
      const { service, fetcher } = setup(
        provider === 'google' ? undefined : { id: 42, login: 'dave', name: null },
      );
      const flow = service.begin(provider);
      const url = new URL(flow.url);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).not.toContain('repo');
      expect(url.searchParams.get('scope')).not.toContain('email');
      const state = url.searchParams.get('state')!;
      const session = await service.finish(provider, state, 'one-time-code', flow.binding);
      const body = fetcher.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(
        url.searchParams.get('code_challenge'),
      );
      expect(body.get('redirect_uri')).toBe(`${options.origin}/api/auth/${provider}/callback`);
      expect(service.status(session).user?.provider).toBe(provider);
      expect(JSON.stringify(service.status(session))).not.toMatch(
        /private-token|clientSecret|one-time-code/,
      );
      await expect(service.finish(provider, state, 'one-time-code', flow.binding)).rejects.toThrow(
        LoginError,
      );
      service.logout(session);
      expect(service.user(session)).toBeNull();
    },
  );

  it('binds state to the initiating browser and provider before contacting upstream', async () => {
    const { service, fetcher } = setup();
    const flow = service.begin('google');
    const state = new URL(flow.url).searchParams.get('state')!;
    await expect(service.finish('google', state, 'code', 'other-browser')).rejects.toThrow(
      LoginError,
    );
    await expect(service.finish('github', state, 'code', flow.binding)).rejects.toThrow(LoginError);
    expect(fetcher).not.toHaveBeenCalled();
    const session = await service.finish('google', state, 'code', flow.binding);
    expect(service.user(session)).not.toBeNull();
  });

  it('expires pending logins and sessions', async () => {
    const { service, advance, fetcher } = setup();
    const expired = service.begin('google');
    advance(600_001);
    await expect(
      service.finish(
        'google',
        new URL(expired.url).searchParams.get('state')!,
        'code',
        expired.binding,
      ),
    ).rejects.toThrow(LoginError);
    expect(fetcher).not.toHaveBeenCalled();
    const flow = service.begin('google');
    const session = await service.finish(
      'google',
      new URL(flow.url).searchParams.get('state')!,
      'code',
      flow.binding,
    );
    advance(8 * 60 * 60_000 + 1);
    expect(service.user(session)).toBeNull();
  });

  it.each([
    { sub: 'uninvited', name: 'Stranger' },
    { sub: 123 },
    { error: 'private-upstream-error' },
  ])('rejects uninvited and malformed identities without leaking data', async (profile) => {
    const { service } = setup(profile);
    const flow = service.begin('google');
    await expect(
      service.finish('google', new URL(flow.url).searchParams.get('state')!, 'code', flow.binding),
    ).rejects.toThrow(new LoginError().message);
    expect(service.status().user).toBeNull();
  });

  it('sanitizes upstream failures and never retries a consumed authorization code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret upstream payload'));
    const service = new LoginService(options, fetcher);
    const flow = service.begin('google');
    const state = new URL(flow.url).searchParams.get('state')!;
    await expect(service.finish('google', state, 'code', flow.binding)).rejects.toThrow(
      new LoginError().message,
    );
    await expect(service.finish('google', state, 'code', flow.binding)).rejects.toThrow(LoginError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires explicit configuration and an allowlist; rejects insecure origins', () => {
    expect(loginFromEnv({})).toBeUndefined();
    expect(() => loginFromEnv({ DAVECODE_LOGIN_ENABLED: '1' })).toThrow(
      'Invalid login configuration',
    );
    expect(() => new LoginService({ ...options, allowedUsers: [] })).toThrow(
      'Invalid login configuration',
    );
    expect(() => new LoginService({ ...options, origin: 'http://public.example' })).toThrow(
      'Invalid login configuration',
    );
    expect(() => new LoginService({ ...options, origin: 'https://example.com/path' })).toThrow(
      'Invalid login configuration',
    );
  });
});
