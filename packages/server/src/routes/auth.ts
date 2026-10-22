import type { LoginProvider, LoginService } from '@davecode/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';

export function authCookie(request: FastifyRequest, name: string): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function cookie(name: string, value: string, seconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}

export function registerAuthRoutes(app: FastifyInstance, login?: LoginService): void {
  const secure = login?.options.origin.startsWith('https:') ?? false;
  app.get('/api/auth/session', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return (
      login?.status(authCookie(request, 'dc_session')) ?? {
        required: false,
        providers: [],
        user: null,
      }
    );
  });
  app.post('/api/auth/logout', async (request, reply) => {
    if (login && request.headers.origin !== login.options.origin)
      return sendApiError(
        reply,
        403,
        'invalid_origin',
        'Open DaveCode from its configured origin.',
      );
    login?.logout(authCookie(request, 'dc_session'));
    return reply
      .header('Cache-Control', 'no-store')
      .header('Set-Cookie', cookie('dc_session', '', 0, secure))
      .code(204)
      .send();
  });
  for (const provider of ['google', 'github'] as const satisfies readonly LoginProvider[]) {
    app.get(`/api/auth/${provider}/start`, async (_request, reply) => {
      if (!login?.options.providers[provider])
        return sendApiError(
          reply,
          503,
          'login_not_configured',
          'This sign-in provider is not configured.',
        );
      try {
        const flow = login.begin(provider);
        return reply
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer')
          .header('Set-Cookie', cookie('dc_login', flow.binding, 600, secure))
          .redirect(flow.url);
      } catch {
        return sendApiError(reply, 429, 'login_busy', 'Sign-in is busy. Try again shortly.');
      }
    });
    app.get(`/api/auth/${provider}/callback`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (!login)
        return sendApiError(reply, 503, 'login_not_configured', 'Sign-in is not configured.');
      const parsed = z
        .object({ state: z.string().min(1).max(200), code: z.string().min(1).max(4096) })
        .safeParse(request.query);
      const binding = authCookie(request, 'dc_login');
      if (!parsed.success || !binding)
        return reply.redirect(`${login.options.origin}/#/login?error=signin_failed`);
      try {
        const session = await login.finish(provider, parsed.data.state, parsed.data.code, binding);
        login.logout(authCookie(request, 'dc_session'));
        return reply
          .header('Set-Cookie', [
            cookie('dc_session', session, 8 * 60 * 60, secure),
            cookie('dc_login', '', 0, secure),
          ])
          .redirect(`${login.options.origin}/`);
      } catch {
        return reply
          .header('Set-Cookie', cookie('dc_login', '', 0, secure))
          .redirect(`${login.options.origin}/#/login?error=signin_failed`);
      }
    });
  }
}
