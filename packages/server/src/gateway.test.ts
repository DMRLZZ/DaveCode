import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway, redactUrl, startGateway } from './gateway';
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
  return { t, app };
}

const TOKEN = 'test-token-123';

describe('bearer auth', () => {
  it('guards /v1 with the OpenAI envelope and /api with the API envelope', async () => {
    const { app } = await setup({ server: { authToken: TOKEN } });
    let res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: {
        message: 'Missing or invalid bearer token',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
    res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { message: 'Missing or invalid bearer token', code: 'unauthorized' },
    });
    res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts ?token= only on /api/events', async () => {
    const { app } = await setup({ server: { authToken: TOKEN } });
    const res = await app.inject({ method: 'GET', url: `/api/accounts?token=${TOKEN}` });
    expect(res.statusCode).toBe(401);
    const events = await app.inject({ method: 'GET', url: '/api/events?token=wrong' });
    expect(events.statusCode).toBe(401);
  });

  it('lets CORS preflights through without a token', async () => {
    const { app } = await setup({ server: { authToken: TOKEN } });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/accounts',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('is disabled when no token is configured', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('redacts tokens from logged URLs', () => {
    expect(redactUrl('/api/events?token=abc&x=1')).toBe('/api/events?token=[redacted]&x=1');
    expect(redactUrl('/api/events?a=1&token=abc')).toBe('/api/events?a=1&token=[redacted]');
  });
});

describe('CORS', () => {
  it('allows the Vite dev server and exposes routing headers', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-expose-headers']).toContain('x-davecode-account');
    const other = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('dashboard', () => {
  function dashboard(): string {
    const dir = mkdtempSync(join(tmpdir(), 'davecode-ui-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    return dir;
  }

  it('serves static files with SPA fallback, excluding /api and /v1', async () => {
    const { app } = await setup(undefined, { dashboardDir: dashboard() });
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.payload).toContain('id="root"');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.payload).toBe('console.log(1)');
    expect(asset.headers['content-type']).toContain('javascript');
    const spa = await app.inject({ method: 'GET', url: '/tasks/123' });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toContain('text/html');
    expect(spa.payload).toContain('id="root"');
    const api = await app.inject({ method: 'GET', url: '/api/missing' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
    const v1 = await app.inject({ method: 'GET', url: '/v1/missing' });
    expect(v1.statusCode).toBe(404);
    expect(v1.json().error.type).toBe('invalid_request_error');
    // Real API routes still win over the static wildcard.
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('keeps static files public when auth is on', async () => {
    const { app } = await setup({ server: { authToken: TOKEN } }, { dashboardDir: dashboard() });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
  });

  it('is not served when server.dashboard is false or no dir is given', async () => {
    const { app } = await setup({ server: { dashboard: false } }, { dashboardDir: dashboard() });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});

// --- live SSE ----------------------------------------------------------------

interface SseClient {
  res: IncomingMessage;
  text(): string;
  waitFor(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}

function connect(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers }, (res) => {
      let buffer = '';
      const waiters = new Set<() => void>();
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (const w of waiters) w();
      });
      resolve({
        res,
        text: () => buffer,
        waitFor(predicate, timeoutMs = 3000) {
          return new Promise((done, fail) => {
            const check = () => {
              if (predicate(buffer)) {
                waiters.delete(check);
                clearTimeout(timer);
                done(buffer);
              }
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`timed out; received: ${buffer}`));
            }, timeoutMs);
            waiters.add(check);
            check();
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

async function listen(config?: Parameters<typeof makeTestEngine>[0], options: GatewayOptions = {}) {
  t = makeTestEngine(config);
  app = await startGateway(t.engine, { ...options, host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { t, base: `http://127.0.0.1:${port}` };
}

describe('GET /api/events', () => {
  it('replays the buffer, streams live events, sends heartbeats and cleans up', async () => {
    const { t, base } = await listen(undefined, { heartbeatMs: 50 });
    let active = 0;
    const subscribe = t.engine.events.subscribe.bind(t.engine.events);
    t.engine.events.subscribe = (handler) => {
      active++;
      const unsubscribe = subscribe(handler);
      return () => {
        active--;
        unsubscribe();
      };
    };

    t.engine.events.emit({ type: 'log', level: 'info', scope: 'test', message: 'before' });
    const client = await connect(`${base}/api/events`, { origin: 'http://localhost:5173' });
    expect(client.res.statusCode).toBe(200);
    expect(client.res.headers['content-type']).toContain('text/event-stream');
    expect(client.res.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    await client.waitFor((s) => s.includes('"message":"before"'));
    expect(client.text()).toContain('event: log\ndata: {"type":"log"');
    expect(active).toBe(1);

    t.engine.events.emit({ type: 'account.removed', accountId: 'acc_live' });
    await client.waitFor((s) => s.includes('event: account.removed\ndata: '));
    await client.waitFor((s) => s.includes(': ping\n\n'));

    client.close();
    await expect.poll(() => active, { timeout: 2000 }).toBe(0);
  });

  it('accepts ?token= when auth is enabled', async () => {
    const { base } = await listen({ server: { authToken: TOKEN } });
    const ok = await connect(`${base}/api/events?token=${TOKEN}`);
    expect(ok.res.statusCode).toBe(200);
    ok.close();
    const denied = await connect(`${base}/api/events`);
    expect(denied.res.statusCode).toBe(401);
    denied.close();
  });

  it('does not block shutdown while clients are connected', async () => {
    const { base } = await listen();
    const client = await connect(`${base}/api/events`);
    await client.waitFor((s) => s.includes('retry:'));
    const ended = new Promise<void>((resolve) => client.res.on('end', () => resolve()));
    await app!.close();
    app = undefined;
    await ended;
  });
});
