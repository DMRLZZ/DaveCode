import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, startGateway } from './gateway';
import type { GatewayOptions } from './options';
import { makeTestEngine, type TestEngine } from './test-utils';

let t: TestEngine | undefined;
let app: FastifyInstance | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await app?.close();
  t?.cleanup();
  app = undefined;
  t = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(config?: Parameters<typeof makeTestEngine>[0], options: GatewayOptions = {}) {
  t = makeTestEngine(config);
  app = await buildGateway(t.engine, options);
  return app;
}

const TOKEN = 'guard-token-123';
const JSON_TYPE = { 'content-type': 'application/json' };

function dashboard(): string {
  const dir = mkdtempSync(join(tmpdir(), 'davecode-ui-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

describe('authentication follows the matched route', () => {
  const variants = [
    '/api/health',
    '/%61pi/health',
    '/ap%69/health',
    '/api/h%65alth',
    '/api%2Fhealth',
    '/api%2fhealth',
    '//api/health',
    '/api//health',
    '/API/health',
    '/Api/Health',
    '/api/health/',
    '/api/health//',
    '/api/./health',
    '/api/nothing-here',
    '/%61pi/nothing-here',
    '/v1/models',
    '/%76%31/models',
    '/v%31/models',
    '/v1%2Fmodels',
    '//v1/models',
    '/V1/models',
    '/v1/models/',
    '/v1/nothing-here',
    '/v%31/nothing-here',
  ];

  it.each(variants)('requires the token for %s', async (url) => {
    const gateway = await setup({ server: { authToken: TOKEN } });
    const denied = await gateway.inject({ method: 'GET', url });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain('"status":"ok"');
    const wrong = await gateway.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it.each(variants)('requires the token for %s when the dashboard is served', async (url) => {
    const gateway = await setup({ server: { authToken: TOKEN } }, { dashboardDir: dashboard() });
    const res = await gateway.inject({ method: 'GET', url });
    // Either denied, or answered by the static handler: never a gateway payload.
    expect(res.body).not.toContain('"status":"ok"');
    expect(res.body).not.toContain('"object":"list"');
  });

  it('still answers the encoded forms of real routes once a token is sent', async () => {
    const gateway = await setup({ server: { authToken: TOKEN } });
    const headers = { authorization: `Bearer ${TOKEN}` };
    for (const url of ['/api/health', '/%61pi/health', '/v%31/models']) {
      expect((await gateway.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    }
  });

  it('denies unmatched write requests and unknown methods', async () => {
    const gateway = await setup({ server: { authToken: TOKEN } });
    for (const url of ['/api/unknown', '/%61pi/unknown', '/v1/unknown', '/unknown']) {
      const res = await gateway.inject({ method: 'POST', url, headers: JSON_TYPE, payload: '{}' });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('uses the OpenAI envelope for v1 paths however they are written', async () => {
    const gateway = await setup({ server: { authToken: TOKEN } });
    const res = await gateway.inject({ method: 'GET', url: '/v%31/models' });
    expect(res.json().error.code).toBe('invalid_api_key');
  });

  it('keeps serving the dashboard files without a token', async () => {
    const gateway = await setup({ server: { authToken: TOKEN } }, { dashboardDir: dashboard() });
    for (const url of ['/', '/index.html', '/assets/app.js', '/some/client/route']) {
      const res = await gateway.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    expect((await gateway.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
  });

  it('keeps the login-mode routes reachable without a token', async () => {
    const gateway = await setup({ server: { authToken: TOKEN } });
    const session = await gateway.inject({ method: 'GET', url: '/api/auth/session' });
    expect(session.statusCode).toBe(200);
    const logout = await gateway.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(logout.statusCode).toBe(204);
    const start = await gateway.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(start.statusCode).toBe(503);
  });
});

describe('Host header', () => {
  it('accepts the loopback names and rejects other names', async () => {
    const gateway = await setup();
    for (const host of [
      'localhost',
      'localhost:80',
      '127.0.0.1',
      '127.0.0.1:80',
      '[::1]',
      'LOCALHOST',
    ]) {
      const res = await gateway.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
    for (const host of [
      'example.com',
      'localhost.example.com',
      '127.0.0.1.example.com',
      '10.0.0.5',
    ]) {
      for (const url of ['/api/health', '/v1/models']) {
        const res = await gateway.inject({ method: 'GET', url, headers: { host } });
        expect(res.statusCode, `${host} ${url}`).toBe(403);
      }
    }
  });

  it('checks the port against the listening socket', async () => {
    t = makeTestEngine();
    app = await startGateway(t.engine, { host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/health', headers: { host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`[::1]:${port}`)).toBe(200);
    expect(await get(`localhost:${port + 1}`)).toBe(403);
    expect(await get(`attacker.example:${port}`)).toBe(403);
  });

  it('does not restrict a gateway bound to a network address', async () => {
    const gateway = await setup(undefined, { host: '0.0.0.0' });
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'dave.lan:4040' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('also accepts the host of a configured origin on a loopback bind', async () => {
    const gateway = await setup(undefined, { corsOrigins: ['https://dave.example'] });
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'dave.example' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('state-changing /api requests', () => {
  const post = (
    gateway: FastifyInstance,
    headers: Record<string, string>,
    url = '/api/runner/start',
  ) => gateway.inject({ method: 'POST', url, headers });

  it('accepts requests with no Origin header', async () => {
    const gateway = await setup();
    const res = await post(gateway, JSON_TYPE);
    expect(res.statusCode).toBe(501);
  });

  it('accepts the gateway own origin and rejects others', async () => {
    const gateway = await setup();
    const own = await post(gateway, {
      ...JSON_TYPE,
      host: 'localhost:4040',
      origin: 'http://localhost:4040',
    });
    expect(own.statusCode).toBe(501);
    for (const origin of ['https://example.com', 'null', 'http://localhost:5173', 'not a url']) {
      const res = await post(gateway, { ...JSON_TYPE, origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().error.code).toBe('invalid_origin');
    }
  });

  it('trusts the dev server origin only in dev mode', async () => {
    const dev = await setup(undefined, { dev: true });
    const ok = await post(dev, { ...JSON_TYPE, origin: 'http://localhost:5173' });
    expect(ok.statusCode).toBe(501);
    await app?.close();
    t?.cleanup();
    const plain = await setup();
    const denied = await post(plain, { ...JSON_TYPE, origin: 'http://localhost:5173' });
    expect(denied.statusCode).toBe(403);
    const cors = await plain.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(cors.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('trusts explicitly configured origins', async () => {
    const gateway = await setup(undefined, { corsOrigins: ['https://app.example'] });
    const ok = await post(gateway, { ...JSON_TYPE, origin: 'https://app.example' });
    expect(ok.statusCode).toBe(501);
  });

  it('requires a JSON content type on POST, including empty bodies', async () => {
    const gateway = await setup();
    const cases: Record<string, string>[] = [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=x' },
    ];
    for (const headers of cases) {
      const res = await post(gateway, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(415);
      expect(res.json().error.code).toBe('json_required');
    }
    expect((await post(gateway, JSON_TYPE, '/api/runner/stop')).statusCode).toBe(501);
    expect(
      (await post(gateway, { 'content-type': 'Application/JSON; charset=utf-8' })).statusCode,
    ).toBe(501);
  });

  it('does not change reads', async () => {
    const gateway = await setup();
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not touch /v1 clients that send no Origin', async () => {
    const gateway = await setup();
    const res = await gateway.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
  });
});
