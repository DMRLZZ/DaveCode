import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AccountClient, AccountError, type AccountSession, pkcePair } from './client';

export interface AccountLoginOptions {
  client: AccountClient;
  /** Give up after this long (default 10 minutes). */
  timeoutMs?: number;
}

export interface AccountLogin {
  /** Open this in the browser: the hosted sign-in page. */
  url: string;
  /** Resolves with the new session, rejects on failure, timeout or {@link AccountLogin.close}. */
  session: Promise<AccountSession>;
  close(): Promise<void>;
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * Sign in the way Claude Code and Codex do: the browser opens the hosted sign-in page, and a
 * one-shot listener on 127.0.0.1 (random port, random path) only receives the final redirect
 * with a PKCE-bound code. The CLI exchanges it, sends the browser to the hosted "signed in"
 * page and stops listening.
 */
export async function startAccountLogin(options: AccountLoginOptions): Promise<AccountLogin> {
  const { client } = options;
  const callbackPath = `/s/${randomBytes(18).toString('base64url')}/callback`;
  const pkce = pkcePair();
  let finish: (session: AccountSession) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let settled = false;
  const session = new Promise<AccountSession>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Callers may only await `session` later; avoid an unhandled rejection meanwhile.
  session.catch(() => {});

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== callbackPath || settled) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        settled = true;
        fail(
          new AccountError(
            url.searchParams.get('error_description') ?? 'The sign-in was not completed.',
          ),
        );
        redirect(res, client.pageUrl('/login/failed'));
        return;
      }
      settled = true;
      try {
        finish(await client.exchangeCode(code, pkce.verifier));
        redirect(res, client.pageUrl('/login/done'));
      } catch (err) {
        fail(err instanceof AccountError ? err : new AccountError('Sign-in failed.'));
        redirect(res, client.pageUrl('/login/failed'));
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

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
  // Give the browser a moment to follow the final redirect before the listener goes away.
  void session.then(
    () => setTimeout(() => void close(), 1_000).unref(),
    () => setTimeout(() => void close(), 1_000).unref(),
  );

  return {
    url: client.loginUrl(`http://127.0.0.1:${port}${callbackPath}`, pkce.challenge),
    session,
    close: async () => {
      clearTimeout(timeout);
      fail(new AccountError('Sign-in cancelled.'));
      await close();
    },
  };
}
