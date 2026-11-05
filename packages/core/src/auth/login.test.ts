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

  describe('unfinished sign-ins', () => {
    const stateOf = (flow: { url: string }) => new URL(flow.url).searchParams.get('state')!;

    it('does not let anonymous starts lock the owner out when the table is full', async () => {
      const { service } = setup();
      // Many different peers fill all 1000 slots.
      const first = service.begin('google', 'peer-0');
      for (let i = 1; i < 1000; i++) service.begin('google', `peer-${i}`);
      const owner = service.begin('github', '203.0.113.9');
      // The oldest entry made room; the owner's own sign-in is intact.
      await expect(service.finish('google', stateOf(first), 'code', first.binding)).rejects.toThrow(
        LoginError,
      );
      expect(stateOf(owner)).toBeTruthy();
    });

    it('lets the owner finish after one peer floods the table', async () => {
      const { service } = setup({ id: 42, login: 'dave', name: null });
      const owner = service.begin('github', '198.51.100.1');
      for (let i = 0; i < 5000; i++) service.begin('google', '203.0.113.50');
      const session = await service.finish('github', stateOf(owner), 'code', owner.binding);
      expect(service.status(session).user?.id).toBe('42');
    });

    it('keeps only a few per peer, evicting that peer’s oldest', async () => {
      const { service } = setup();
      const flows = Array.from({ length: 21 }, () => service.begin('google', 'same-peer'));
      await expect(
        service.finish('google', stateOf(flows[0]!), 'code', flows[0]!.binding),
      ).rejects.toThrow(LoginError);
      // The newest is still pending (the call below fails on the binding, not on the state).
      await expect(service.finish('google', stateOf(flows[20]!), 'code', 'wrong')).rejects.toThrow(
        LoginError,
      );
    });

    it('purges expired entries before counting', async () => {
      const { service, advance } = setup({ id: 42, login: 'dave', name: null });
      const stale = Array.from({ length: 20 }, () => service.begin('github', 'peer'));
      advance(10 * 60_000 + 1);
      const fresh = service.begin('github', 'peer');
      await expect(
        service.finish('github', stateOf(stale[19]!), 'code', stale[19]!.binding),
      ).rejects.toThrow(LoginError);
      const session = await service.finish('github', stateOf(fresh), 'code', fresh.binding);
      expect(service.status(session).user?.provider).toBe('github');
    });
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
