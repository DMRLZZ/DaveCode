import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountName, fetchAccount, startAccountSignIn } from './account';

const state = {
  signedIn: true,
  user: { id: 'u', email: 'dev@example.com', provider: 'google' },
  pending: false,
  error: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchAccount', () => {
  it('returns the account and sends the token when there is one', async () => {
    const fetcher = vi.fn(async () => Response.json(state));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchAccount('http://gw', 'tok')).toEqual(state);
    expect(fetcher).toHaveBeenCalledWith('http://gw/api/account', {
      headers: { Authorization: 'Bearer tok' },
      cache: 'no-store',
    });
  });

  it.each([404, 401, 500])('treats %i as a gateway with no account', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status })),
    );
    expect(await fetchAccount('', '')).toBeNull();
  });

  it('rejects an unexpected payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ signedIn: 'yes' })),
    );
    expect(await fetchAccount('', '')).toBeNull();
  });
});

describe('startAccountSignIn', () => {
  it('declares JSON, which the gateway requires, and names the provider', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ url: 'https://auth.example.test/login', opened: false }),
    );
    vi.stubGlobal('fetch', fetcher);
    expect(await startAccountSignIn('', '', 'github')).toEqual({
      url: 'https://auth.example.test/login',
      opened: false,
    });
    expect(fetcher).toHaveBeenCalledWith('/api/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"provider":"github"}',
    });
  });

  it('fails loudly so the screen can say so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 502 })),
    );
    await expect(startAccountSignIn('', '')).rejects.toThrow(/Could not start/);
  });
});

describe('accountName', () => {
  it('prefers the name, then the email', () => {
    expect(accountName({ id: 'u', name: 'Dev', email: 'dev@example.com' })).toBe('Dev');
    expect(accountName({ id: 'u', email: 'dev@example.com' })).toBe('dev@example.com');
    expect(accountName(null)).toBe('your DaveCode account');
  });
});
