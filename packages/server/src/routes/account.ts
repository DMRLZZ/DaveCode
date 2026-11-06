import type { AccountControl } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../errors';

const loginSchema = z.object({ provider: z.enum(['google', 'github']).optional() });

/** The machine's DaveCode account. Identity only: tokens never leave the core store. */
export function registerAccountRoutes(app: FastifyInstance, account?: AccountControl): void {
  if (!account) return;
  app.get('/api/account', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return account.state();
  });
  app.post('/api/account/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return sendApiError(reply, 400, 'invalid_body', 'Unknown sign-in provider.');
    try {
      return reply.code(202).send(await account.login(parsed.data.provider));
    } catch {
      return sendApiError(reply, 502, 'account_unavailable', 'Could not start the sign-in.');
    }
  });
  app.post('/api/account/cancel', async (_request, reply) => {
    await account.cancel();
    return reply.code(204).send();
  });
  app.post('/api/account/logout', async (_request, reply) => {
    await account.logout();
    return reply.code(204).send();
  });
}
