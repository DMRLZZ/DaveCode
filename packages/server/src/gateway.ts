import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Engine, loginFromEnv } from '@davecode/core';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { sendApiError, sendOpenAIError } from './errors';
import type { GatewayOptions, StartGatewayOptions } from './options';
import { registerAccountRoutes } from './routes/account';
import { registerApiRoutes } from './routes/api';
import { authCookie, registerAuthRoutes } from './routes/auth';
import { registerEventRoutes } from './routes/events';
import { registerV1Routes } from './routes/v1';

/** Origins allowed to call the gateway from a browser (the Vite dev server). */
export const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const EXPOSED_HEADERS = [
  'x-davecode-request-id',
  'x-davecode-account',
  'x-davecode-provider',
  'x-davecode-failovers',
];

type Surface = 'v1' | 'api' | 'other';

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Lower-cased, percent-decoded path. Used to pick an error envelope, never to skip a check. */
function normalisedPath(url: string): string {
  const path = pathOf(url);
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

function surfaceOf(url: string): Surface {
  const path = normalisedPath(url);
  if (path === '/v1' || path.startsWith('/v1/')) return 'v1';
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  return 'other';
}

/** Routes that never need a token: the login-mode routes. Matched by route pattern, not by URL. */
const PUBLIC_ROUTES = new Set([
  '/api/auth/session',
  '/api/auth/logout',
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/auth/github/start',
  '/api/auth/github/callback',
]);

/** Patterns under which the dashboard's static files are served (read-only GET/HEAD). */
const STATIC_ROUTES = new Set(['/', '/*']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function splitHost(header: string): { name: string; port: string } | undefined {
  const match = /^(\[[0-9a-f:.]+\]|[^:/\\@\s]+)(?::(\d{1,5}))?$/i.exec(header.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), port: match[2] ?? '' };
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** Hide `?token=` values from logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|code|state|error_description)=)[^&]*/gi, '$1[redacted]');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function loggerOption(logger: GatewayOptions['logger']) {
  if (!logger) return false;
  return {
    ...(typeof logger === 'object' ? logger : {}),
    serializers: {
      req(req: FastifyRequest) {
        return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip };
      },
    },
  };
}

/**
 * Build the DaveCode gateway (OpenAI-compatible `/v1`, dashboard `/api`, SSE events and the
 * optional dashboard). The instance is not listening; use `app.inject()` or `startGateway()`.
 */
export async function buildGateway(
  engine: Engine,
  options: GatewayOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOption(options.logger), bodyLimit: 10 * 1024 * 1024 });
  const login = options.login === false ? undefined : (options.login ?? loginFromEnv(process.env));
  if (login) app.addHook('onClose', async () => login.clear());

  const bindHost = (options.host ?? engine.config.server.host).toLowerCase();
  const loopbackBind = LOOPBACK.has(bindHost);
  // Origins that may call state-changing /api routes besides the gateway's own origin.
  const extraOrigins = [
    ...(options.dev ? DEFAULT_CORS_ORIGINS : []),
    ...(options.corsOrigins ?? []),
    ...(login ? [login.options.origin] : []),
  ]
    .map(originOf)
    .filter((origin): origin is string => origin !== undefined);
  const allowedOrigins = new Set(extraOrigins);
  // Hosts that are also expected when the gateway sits behind a proxy on a loopback bind.
  const extraHosts = new Set(
    [...(options.corsOrigins ?? []), ...(login ? [login.options.origin] : [])]
      .map(originOf)
      .filter((origin): origin is string => origin !== undefined)
      .map((origin) => new URL(origin).host.toLowerCase()),
  );

  function hostAllowed(request: FastifyRequest): boolean {
    // A gateway bound to a network address is reached by whatever name it was configured with.
    if (!loopbackBind) return true;
    const header = request.headers.host;
    if (!header) return false;
    if (extraHosts.has(header.toLowerCase())) return true;
    const parsed = splitHost(header);
    if (!parsed || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.name)) return false;
    const actual = request.raw.socket?.localPort;
    return actual === undefined || Number(parsed.port || 80) === actual;
  }

  function originAllowed(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    const normalised = originOf(origin);
    if (!normalised) return false;
    if (allowedOrigins.has(normalised)) return true;
    const host = request.headers.host?.toLowerCase();
    return host !== undefined && new URL(normalised).host.toLowerCase() === host;
  }

  // Runs first, after routing: which Host may be used, which Origin may change state, and
  // that state-changing /api requests declare a JSON body (a cross-site page cannot send that
  // without a preflight).
  app.addHook('onRequest', async (request, reply) => {
    // The matched route decides; the URL only picks an error format for unmatched requests.
    const surface = surfaceOf(request.routeOptions.url ?? request.url);
    const reject = (status: number, code: string, message: string) =>
      surface === 'v1'
        ? sendOpenAIError(reply, status, { message, type: 'invalid_request_error', code })
        : sendApiError(reply, status, code, message);
    if (!hostAllowed(request)) return reject(403, 'invalid_host', 'Unexpected Host header.');
    if (surface !== 'api' || SAFE_METHODS.has(request.method)) return;
    if (!originAllowed(request)) {
      return reject(403, 'invalid_origin', 'Requests from this origin are not allowed.');
    }
    if (PUBLIC_ROUTES.has(request.routeOptions.url ?? '')) return;
    // PUT, PATCH and DELETE always need a preflight cross-site; a POST can be sent without one.
    if (request.method !== 'POST') return;
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return reject(415, 'json_required', 'Send Content-Type: application/json');
    }
  });

  await app.register(cors, {
    origin: [...(options.dev ? DEFAULT_CORS_ORIGINS : []), ...(options.corsOrigins ?? [])],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    exposedHeaders: EXPOSED_HEADERS,
  });

  const token = engine.config.server.authToken;
  if (token || login) {
    // Deny by default: only the explicit public routes and the dashboard's static files skip
    // the check. The decision uses the matched route, not the raw URL text.
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const route = request.routeOptions.url;
      if (route !== undefined) {
        if (PUBLIC_ROUTES.has(route)) return;
        if (STATIC_ROUTES.has(route) && (request.method === 'GET' || request.method === 'HEAD'))
          return;
      }
      const surface = surfaceOf(request.url);
      const isV1 = route === '/v1' || route?.startsWith('/v1/') || surface === 'v1';
      let provided = bearer(request);
      if (!provided && route === '/api/events') {
        const query = request.query as Record<string, unknown> | undefined;
        if (typeof query?.token === 'string') provided = query.token;
      }
      if (provided && token && safeEqual(provided, token)) return;
      if (!isV1 && login?.user(authCookie(request, 'dc_session'))) {
        if (
          !['GET', 'HEAD'].includes(request.method) &&
          request.headers.origin !== login.options.origin
        ) {
          return sendApiError(
            reply,
            403,
            'invalid_origin',
            'Open DaveCode from its configured origin.',
          );
        }
        return;
      }
      const message = 'Missing or invalid bearer token';
      if (isV1) {
        return sendOpenAIError(reply, 401, {
          message,
          type: 'authentication_error',
          code: 'invalid_api_key',
        });
      }
      return sendApiError(reply, 401, 'unauthorized', message);
    });
  }

  // Accept `Content-Type: application/json` with an empty body (clients that always send the
  // header, e.g. `POST /api/runner/start` or `DELETE`): the body is simply undefined.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const error = Object.assign(err instanceof Error ? err : new Error('Invalid JSON'), {
        statusCode: 400,
      });
      done(error, undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message =
      status >= 500 ? 'Internal gateway error' : error instanceof Error ? error.message : 'Error';
    if (status >= 500) request.log.error({ err: error }, 'request failed');
    if (surfaceOf(request.url) === 'v1') {
      return sendOpenAIError(reply, status, {
        message,
        type: status >= 500 ? 'api_error' : 'invalid_request_error',
        code: status >= 500 ? 'internal_error' : 'bad_request',
      });
    }
    return sendApiError(reply, status, status >= 500 ? 'internal_error' : 'bad_request', message);
  });

  const dashboardDir =
    engine.config.server.dashboard && options.dashboardDir && existsSync(options.dashboardDir)
      ? resolve(options.dashboardDir)
      : undefined;
  if (dashboardDir) {
    await app.register(fastifyStatic, { root: dashboardDir });
  }

  app.setNotFoundHandler((request, reply) => {
    const surface = surfaceOf(request.url);
    const message = `Unknown endpoint ${request.method} ${pathOf(request.url)}`;
    if (surface === 'v1') {
      return sendOpenAIError(reply, 404, {
        message,
        type: 'invalid_request_error',
        code: 'not_found',
      });
    }
    if (surface === 'api') return sendApiError(reply, 404, 'not_found', message);
    if (dashboardDir && (request.method === 'GET' || request.method === 'HEAD')) {
      // SPA fallback: client-side routes are served by index.html.
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: { message, code: 'not_found' } });
  });

  registerV1Routes(app, engine);
  registerAuthRoutes(app, login);
  registerAccountRoutes(app, options.account);
  registerApiRoutes(app, engine, options);
  registerEventRoutes(app, engine, options.heartbeatMs ?? 15_000);

  return app;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Build and listen on `server.host:server.port` (or the overrides). */
export async function startGateway(
  engine: Engine,
  options: StartGatewayOptions = {},
): Promise<FastifyInstance> {
  const host = options.host ?? engine.config.server.host;
  const app = await buildGateway(engine, { ...options, host });
  const port = options.port ?? engine.config.server.port;
  if (!engine.config.server.authToken && !LOOPBACK.has(host)) {
    app.log.warn(
      `Listening on ${host} without server.authToken: anyone on the network can use your accounts.`,
    );
  }
  await app.listen({ host, port });
  return app;
}
