import type { AccountControl } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let app: FastifyInstance | undefined;
let fixture: TestEngine | undefined;
afterEach(async () => {
  await app?.close();
  fixture?.cleanup();
  app = undefined;
  fixture = undefined;
});

const signedOut = { signedIn: false, user: null, pending: false, error: null };

function control(overrides: Partial<AccountControl> = {}): AccountControl {
  return {
    state: vi.fn(async () => signedOut),
    login: vi.fn(async () => ({ url: 'https://auth.example.test/login', opened: true })),
    cancel: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

async function setup(account?: AccountControl, authToken?: string) {
  fixture = makeTestEngine(authToken ? { server: { authToken } } : undefined);
  app = await buildGateway(fixture.engine, { login: false, ...(account ? { account } : {}) });
  return app;
}

const json = { 'content-type': 'application/json' };

describe('/api/account', () => {
  it('does not exist when the host gave the gateway no account', async () => {
    const gateway = await setup();
    expect((await gateway.inject('/api/account')).statusCode).toBe(404);
  });

  it('returns the state uncached', async () => {
    const gateway = await setup(control());
    const response = await gateway.inject('/api/account');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(signedOut);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('starts a sign-in for a known provider and refuses anything else', async () => {
    const account = control();
    const gateway = await setup(account);
    const started = await gateway.inject({
      method: 'POST',
      url: '/api/account/login',
      headers: json,
      payload: { provider: 'google' },
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ url: 'https://auth.example.test/login', opened: true });
    expect(account.login).toHaveBeenCalledWith('google');
    const refused = await gateway.inject({
      method: 'POST',
      url: '/api/account/login',
      headers: json,
      payload: { provider: 'facebook' },
    });
    expect(refused.statusCode).toBe(400);
    expect(account.login).toHaveBeenCalledOnce();
  });

  it('hides why the sign-in could not start', async () => {
    const login = vi.fn(async () => {
      throw new Error('EADDRINUSE secret detail');
    });
    const gateway = await setup(control({ login }));
    const response = await gateway.inject({
      method: 'POST',
      url: '/api/account/login',
      headers: json,
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('secret detail');
  });

  it('cancels and signs out', async () => {
    const account = control();
    const gateway = await setup(account);
    for (const path of ['cancel', 'logout']) {
      const response = await gateway.inject({
        method: 'POST',
        url: `/api/account/${path}`,
        headers: json,
      });
      expect(response.statusCode).toBe(204);
    }
    expect(account.cancel).toHaveBeenCalledOnce();
    expect(account.logout).toHaveBeenCalledOnce();
  });

  it('needs the gateway token, unlike the public sign-in routes', async () => {
    const account = control();
    const gateway = await setup(account, 'api-token');
    expect((await gateway.inject('/api/account')).statusCode).toBe(401);
    const denied = await gateway.inject({
      method: 'POST',
      url: '/api/account/logout',
      headers: json,
    });
    expect(denied.statusCode).toBe(401);
    expect(account.logout).not.toHaveBeenCalled();
    const allowed = await gateway.inject({
      url: '/api/account',
      headers: { authorization: 'Bearer api-token' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects writes from another origin and without a JSON body', async () => {
    const account = control();
    const gateway = await setup(account);
    const foreign = await gateway.inject({
      method: 'POST',
      url: '/api/account/logout',
      headers: { ...json, origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    const form = await gateway.inject({
      method: 'POST',
      url: '/api/account/login',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(form.statusCode).toBe(415);
    expect(account.logout).not.toHaveBeenCalled();
    expect(account.login).not.toHaveBeenCalled();
  });
});
