import { LoginService } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { buildGateway, redactUrl } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let app: FastifyInstance | undefined;
let fixture: TestEngine | undefined;
afterEach(async () => {
  await app?.close();
  fixture?.cleanup();
  app = undefined;
  fixture = undefined;
});

async function setup() {
  fixture = makeTestEngine({ server: { authToken: 'api-token' } });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'upstream-secret', token_type: 'bearer' }))
    .mockResolvedValueOnce(Response.json({ id: 42, login: 'dave' }));
  const login = new LoginService(
    {
      origin: 'https://dave.example',
      providers: { github: { clientId: 'client-id', clientSecret: 'client-secret' } },
      allowedUsers: ['github:42'],
    },
    fetcher,
  );
  app = await buildGateway(fixture.engine, { login });
  return { app, fetcher };
}

it('provides public session status but protects APIs, and completes a browser-bound OAuth callback', async () => {
  const { app, fetcher } = await setup();
  const status = await app.inject('/api/auth/session');
  expect(status.json()).toEqual({ required: true, providers: ['github'], user: null });
  expect(status.headers['cache-control']).toBe('no-store');
  expect((await app.inject('/api/accounts')).statusCode).toBe(401);
  const start = await app.inject('/api/auth/github/start');
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const binding = start.cookies.find((item) => item.name === 'dc_login')!;
  expect(binding.httpOnly).toBe(true);
  expect(binding.secure).toBe(true);
  const callback = `/api/auth/github/callback?state=${state}&code=temporary-code`;
  const unbound = await app.inject(callback);
  expect(unbound.headers.location).toContain('signin_failed');
  expect(fetcher).not.toHaveBeenCalled();
  const signed = await app.inject({ url: callback, cookies: { dc_login: binding.value } });
  expect(signed.headers.location).toBe('https://dave.example/');
  const session = signed.cookies.find((item) => item.name === 'dc_session')!;
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.sameSite).toBe('Lax');
  const cookies = { dc_session: session.value };
  expect((await app.inject({ url: '/api/accounts', cookies })).statusCode).toBe(200);
  expect((await app.inject({ url: '/v1/models', cookies })).statusCode).toBe(401);
  expect(
    (await app.inject({ url: '/v1/models', headers: { authorization: 'Bearer api-token' } }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/runner/start',
        cookies,
        headers: { origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies,
        headers: { origin: 'https://evil.example' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies,
        headers: { origin: 'https://dave.example' },
      })
    ).statusCode,
  ).toBe(204);
  expect((await app.inject({ url: '/api/accounts', cookies })).statusCode).toBe(401);
  expect(redactUrl(callback)).not.toContain('temporary-code');
  expect(redactUrl(callback)).not.toContain(state);
});

it('keeps local mode available when login is disabled without weakening bearer protection', async () => {
  fixture = makeTestEngine({ server: { authToken: 'private-token' } });
  app = await buildGateway(fixture.engine, { login: false });
  expect((await app.inject('/api/auth/session')).json()).toEqual({
    required: false,
    providers: [],
    user: null,
  });
  expect((await app.inject('/api/accounts')).statusCode).toBe(401);
  expect((await app.inject('/api/auth/google/start')).statusCode).toBe(503);
});
