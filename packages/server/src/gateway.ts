import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Engine } from '@davecode/core';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { sendApiError, sendOpenAIError } from './errors';
import type { GatewayOptions, StartGatewayOptions } from './options';
import { registerApiRoutes } from './routes/api';
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

function surfaceOf(url: string): Surface {
  const path = pathOf(url);
  if (path === '/v1' || path.startsWith('/v1/')) return 'v1';
  if (path === '/api' || path.startsWith('/api/')) return 'api';
  return 'other';
}

/** Hide `?token=` values from logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1[redacted]');
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

  await app.register(cors, {
    origin: [...DEFAULT_CORS_ORIGINS, ...(options.corsOrigins ?? [])],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    exposedHeaders: EXPOSED_HEADERS,
  });

  const token = engine.config.server.authToken;
  if (token) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const surface = surfaceOf(request.url);
      if (surface === 'other') return;
      let provided = bearer(request);
      if (!provided && pathOf(request.url) === '/api/events') {
        const query = request.query as Record<string, unknown> | undefined;
        if (typeof query?.token === 'string') provided = query.token;
      }
      if (provided && safeEqual(provided, token)) return;
      const message = 'Missing or invalid bearer token';
      if (surface === 'v1') {
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
  const app = await buildGateway(engine, options);
  const host = options.host ?? engine.config.server.host;
  const port = options.port ?? engine.config.server.port;
  if (!engine.config.server.authToken && !LOOPBACK.has(host)) {
    app.log.warn(
      `Listening on ${host} without server.authToken: anyone on the network can use your accounts.`,
    );
  }
  await app.listen({ host, port });
  return app;
}
