import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  type AccountClient,
  AccountError,
  type AccountSession,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  pkcePair,
} from './client';
import { donePage, errorPage, loginPage, pagePolicy } from './page';

export interface AccountLoginOptions {
  client: AccountClient;
  /** Social providers to offer (default: Google and GitHub). E-mail is always offered. */
  providers?: readonly OAuthProvider[];
  /** Give up after this long (default 10 minutes). */
  timeoutMs?: number;
}

export interface AccountLogin {
  /** Open this in the browser. Loopback only, with a one-time path. */
  url: string;
  /** Resolves with the new session, rejects on timeout or {@link AccountLogin.close}. */
  session: Promise<AccountSession>;
  close(): Promise<void>;
}

const emailBody = z.object({
  mode: z.enum(['signin', 'signup']),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(200),
});

const MAX_BODY = 4096;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

/**
 * Start a one-shot sign-in server on 127.0.0.1 (a random port), the same pattern Claude Code
 * and Codex use: the browser shows the sign-in page, providers redirect back to `/callback`
 * with a PKCE code, and the CLI exchanges it. Every path lives under a random prefix, so other
 * local processes cannot drive the flow, and the server stops after the first success.
 */
export async function startAccountLogin(options: AccountLoginOptions): Promise<AccountLogin> {
  const { client } = options;
  const providers = options.providers ?? OAUTH_PROVIDERS;
  const prefix = `/s/${randomBytes(18).toString('base64url')}`;
  const pkce = pkcePair();
  let origin = '';
  let finish: (session: AccountSession) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let finished: AccountSession | undefined;
  const session = new Promise<AccountSession>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Callers may only await `session` later; avoid an unhandled rejection meanwhile.
  session.catch(() => {});

  const complete = (value: AccountSession) => {
    finished = value;
    finish(value);
  };
  const callback = () => `${origin}${prefix}/callback`;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) {
        send(res, 404, 'text/plain; charset=utf-8', 'Not found');
        return;
      }
      const route = url.pathname.slice(prefix.length) || '/';

      if (req.method === 'GET' && route === '/') {
        const nonce = randomBytes(16).toString('base64');
        send(res, 200, 'text/html; charset=utf-8', loginPage(prefix, providers, nonce), {
          'Content-Security-Policy': pagePolicy(nonce),
        });
        return;
      }
      if (req.method === 'GET' && route.startsWith('/oauth/')) {
        const provider = route.slice('/oauth/'.length) as OAuthProvider;
        if (!providers.includes(provider)) {
          send(res, 404, 'text/plain; charset=utf-8', 'Not found');
          return;
        }
        res.writeHead(302, {
          Location: client.authorizeUrl(provider, callback(), pkce.challenge),
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (req.method === 'GET' && route === '/callback') {
        const code = url.searchParams.get('code');
        if (!code) {
          const reason =
            url.searchParams.get('error_description') ??
            'The provider did not complete the sign-in.';
          send(res, 400, 'text/html; charset=utf-8', errorPage(prefix, reason), {
            'Content-Security-Policy': pagePolicy(),
          });
          return;
        }
        try {
          const value = finished ?? (await client.exchangeCode(code, pkce.verifier));
          complete(value);
          send(
            res,
            200,
            'text/html; charset=utf-8',
            donePage(value.user.email ?? value.user.name),
            {
              'Content-Security-Policy': pagePolicy(),
            },
          );
        } catch (err) {
          const message = err instanceof AccountError ? err.message : 'Sign-in failed.';
          send(res, 400, 'text/html; charset=utf-8', errorPage(prefix, message), {
            'Content-Security-Policy': pagePolicy(),
          });
        }
        return;
      }
      if (req.method === 'GET' && route === '/done' && finished) {
        send(
          res,
          200,
          'text/html; charset=utf-8',
          donePage(finished.user.email ?? finished.user.name),
          { 'Content-Security-Policy': pagePolicy() },
        );
        return;
      }
      if (req.method === 'POST' && route === '/email') {
        // Only the page this server rendered may post: same origin, JSON body.
        if (req.headers.origin !== origin || !req.headers['content-type']?.includes('json')) {
          send(res, 403, 'application/json', JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        let parsed: z.infer<typeof emailBody>;
        try {
          parsed = emailBody.parse(JSON.parse(await readBody(req)));
        } catch {
          send(
            res,
            400,
            'application/json',
            JSON.stringify({
              error: 'Enter a valid email and a password of at least 8 characters.',
            }),
          );
          return;
        }
        try {
          if (parsed.mode === 'signin') {
            complete(await client.signInWithPassword(parsed.email, parsed.password));
            send(res, 200, 'application/json', JSON.stringify({ ok: true }));
            return;
          }
          const result = await client.signUp(
            parsed.email,
            parsed.password,
            callback(),
            pkce.challenge,
          );
          if ('session' in result) {
            complete(result.session);
            send(res, 200, 'application/json', JSON.stringify({ ok: true }));
          } else send(res, 200, 'application/json', JSON.stringify({ confirm: true }));
        } catch (err) {
          const message = err instanceof AccountError ? err.message : 'Sign-in failed.';
          send(res, 400, 'application/json', JSON.stringify({ error: message }));
        }
        return;
      }
      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    })().catch(() => {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const timeout = setTimeout(
    () => {
      fail(new AccountError('Sign-in timed out. Run davecode login to try again.'));
    },
    options.timeoutMs ?? 10 * 60_000,
  );
  timeout.unref();
  // Let the browser load the confirmation page before the server goes away.
  void session.then(
    () => setTimeout(() => void close(), 3_000).unref(),
    () => void close(),
  );

  return {
    url: `${origin}${prefix}/`,
    session,
    close: async () => {
      clearTimeout(timeout);
      fail(new AccountError('Sign-in cancelled.'));
      await close();
    },
  };
}
