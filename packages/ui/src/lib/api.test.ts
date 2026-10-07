import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createHttpClient } from './api';

function mockFetch(status: number, body: string, contentType = 'application/json') {
  const fn = vi.fn(
    async () =>
      new Response(status === 204 ? null : body, {
        status,
        headers: { 'content-type': contentType },
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('createHttpClient', () => {
  it('sends the bearer token and unwraps envelopes', async () => {
    const fetchFn = mockFetch(200, JSON.stringify({ accounts: [{ id: 'a' }] }));
    const client = createHttpClient({ baseUrl: 'http://127.0.0.1:4040/', token: 's3cret' });
    expect(await client.listAccounts()).toEqual([{ id: 'a' }]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4040/api/accounts');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
  });

  it('sends task and route writes to the right endpoints', async () => {
    const fetchFn = mockFetch(200, JSON.stringify({ task: { id: 't' } }));
    const client = createHttpClient({ baseUrl: 'http://gw', token: '' });
    await client.createTask({ id: 't', title: 'T' });
    await client.updateTask('a/b', { title: 'x', description: null });
    await client.deleteTask('t');
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST http://gw/api/tasks',
      'PATCH http://gw/api/tasks/a%2Fb',
      'DELETE http://gw/api/tasks/t',
    ]);
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({ title: 'x', description: null });

    const put = mockFetch(
      200,
      JSON.stringify({ defaultRoute: 'a', routes: [], shadowedByProject: false }),
    );
    await client.updateRoutes({ routes: [], defaultRoute: 'a' });
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(`${init.method} ${url}`).toBe('PUT http://gw/api/routes');
  });

  it('sends taskId only for a targeted runner start', async () => {
    const fetchFn = mockFetch(200, JSON.stringify({ status: { state: 'selecting' } }));
    const client = createHttpClient({ baseUrl: '', token: '' });
    await client.runnerAction('start');
    await client.runnerAction('start', { taskId: 'build-api' });
    await client.runnerAction('stop', { taskId: 'ignored' });
    const bodies = (fetchFn.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([, init]) => init.body,
    );
    expect(bodies).toEqual([undefined, JSON.stringify({ taskId: 'build-api' }), undefined]);
  });

  it('keeps cycle paths and dependents from the error envelope', async () => {
    mockFetch(
      400,
      JSON.stringify({
        error: { code: 'cycle', message: 'dependency cycle: a → b → a', cycle: ['a', 'b', 'a'] },
      }),
    );
    const err = (await createHttpClient({ baseUrl: '', token: '' })
      .updateTask('a', { dependsOn: ['b'] })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ status: 400, code: 'cycle', cycle: ['a', 'b', 'a'] });
    mockFetch(
      409,
      JSON.stringify({ error: { code: 'has_dependents', message: 'x', dependents: ['b'] } }),
    );
    const refused = (await createHttpClient({ baseUrl: '', token: '' })
      .deleteTask('a')
      .catch((e: unknown) => e)) as ApiError;
    expect(refused.dependents).toEqual(['b']);
  });

  it('maps the /api error envelope to ApiError with its code', async () => {
    mockFetch(501, JSON.stringify({ error: { message: 'no runner', code: 'runner_unavailable' } }));
    const err = await createHttpClient({ baseUrl: '', token: '' })
      .runner()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 501, code: 'runner_unavailable', reachable: true });
  });

  it('treats 401 as a reachable gateway that needs a token', async () => {
    mockFetch(401, JSON.stringify({ error: { message: 'unauthorized', code: 'unauthorized' } }));
    const err = (await createHttpClient({ baseUrl: '', token: '' })
      .health()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.reachable).toBe(true);
  });

  it('treats an envelope-less proxy 502 as an unreachable gateway', async () => {
    mockFetch(502, '', 'text/plain');
    const err = (await createHttpClient({ baseUrl: '', token: '' })
      .health()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('gateway_unreachable');
    expect(err.reachable).toBe(false);
  });

  it('treats HTML (e.g. the SPA index) as an unreachable gateway', async () => {
    mockFetch(200, '<!doctype html><html></html>', 'text/html');
    const err = (await createHttpClient({ baseUrl: '', token: '' })
      .health()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('bad_response');
    expect(err.reachable).toBe(false);
  });

  it('treats network failures as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = (await createHttpClient({ baseUrl: '', token: '' })
      .health()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.reachable).toBe(false);
  });

  it('returns undefined for 204 deletes', async () => {
    mockFetch(204, '');
    await expect(
      createHttpClient({ baseUrl: '', token: '' }).deleteAccount('acc 1'),
    ).resolves.toBeUndefined();
  });
});
