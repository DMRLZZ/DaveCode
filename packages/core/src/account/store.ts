import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { loadMasterKey } from '../identity/keyring';
import { globalPaths } from '../paths';
import { type AccountClient, AccountError, type AccountSession } from './client';

const AAD = Buffer.from('davecode-account', 'utf8');
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 50;
/** Errors from the service that mean "this refresh token is dead", not "try again later". */
const INVALID_TOKEN_CODES = new Set([
  'invalid_grant',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'session_not_found',
  'session_expired',
]);

const fileSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().optional(),
    name: z.string().optional(),
    provider: z.string().optional(),
  }),
});

export function accountFile(home: string): string {
  return join(home, 'account.json');
}

/**
 * The signed-in DaveCode account, encrypted at rest with the keyring's master key (AES-256-GCM).
 * Tokens never leave this file except in requests to the account service.
 */
export class AccountStore {
  private readonly path: string;
  private readonly key: Buffer;

  constructor(
    readonly home: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.path = accountFile(home);
    this.key = loadMasterKey(globalPaths(home).masterKey, env);
  }

  load(): AccountSession | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const file = fileSchema.parse(JSON.parse(raw));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(file.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return sessionSchema.parse(JSON.parse(plain)) as AccountSession;
    } catch {
      // A corrupt or foreign file means "signed out", never a crash.
      return undefined;
    }
  }

  save(session: AccountSession): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      `${JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      })}\n`,
      { mode: 0o600 },
    );
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  /**
   * The current session, refreshed when it is about to expire. Returns undefined when signed out
   * or when the service revoked the session; offline, an unexpired session is still returned.
   */
  async current(client: AccountClient, now = Date.now()): Promise<AccountSession | undefined> {
    const first = this.load();
    if (!first) return undefined;
    if (first.expiresAt - REFRESH_MARGIN_MS > now) return first;
    // One process refreshes at a time: the others wait, then pick up what it saved.
    const release = await this.lock();
    try {
      const session = this.load();
      if (!session) return undefined;
      if (session.expiresAt - REFRESH_MARGIN_MS > now) return session;
      try {
        const fresh = await client.refresh(session.refreshToken);
        this.save(fresh);
        return fresh;
      } catch (err) {
        if (isInvalidToken(err)) {
          // Only the token we used is dead; a newer one saved meanwhile is not ours to clear.
          if (this.load()?.refreshToken === session.refreshToken) this.clear();
          return this.load();
        }
        // Unreachable, rate limited or failing service: keep the cached identity and try later.
        return session;
      }
    } finally {
      release();
    }
  }

  /**
   * A cross-process lock: a file created exclusively next to account.json. A lock older than
   * LOCK_STALE_MS belongs to a process that died, and is taken over. After LOCK_WAIT_MS the
   * refresh goes ahead without it (the service tolerates two refreshes racing).
   */
  private async lock(): Promise<() => void> {
    const path = `${this.path}.lock`;
    const owner = `${process.pid}:${randomBytes(8).toString('hex')}`;
    mkdirSync(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        writeFileSync(path, owner, { flag: 'wx', mode: 0o600 });
        return () => {
          try {
            if (readFileSync(path, 'utf8') === owner) rmSync(path, { force: true });
          } catch {
            // Already gone or taken over as stale: nothing of ours to remove.
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && !isWindowsBusy(err))
          return () => undefined;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
      } catch {
        // Released between the check and the stat: try again straight away.
      }
      if (Date.now() >= deadline) return () => undefined;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

/** The service said this refresh token is no good (as opposed to being busy or down). */
function isInvalidToken(err: unknown): boolean {
  if (!(err instanceof AccountError) || err.status === undefined) return false;
  if (err.code) return INVALID_TOKEN_CODES.has(err.code);
  return err.status === 400 || err.status === 401;
}

const isWindowsBusy = (err: unknown) =>
  ['EPERM', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '');
