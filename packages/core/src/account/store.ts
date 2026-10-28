import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { loadMasterKey } from '../identity/keyring';
import { globalPaths } from '../paths';
import { type AccountClient, AccountError, type AccountSession } from './client';

const AAD = Buffer.from('davecode-account', 'utf8');
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

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
    const session = this.load();
    if (!session) return undefined;
    if (session.expiresAt - REFRESH_MARGIN_MS > now) return session;
    try {
      const fresh = await client.refresh(session.refreshToken);
      this.save(fresh);
      return fresh;
    } catch (err) {
      if (err instanceof AccountError && err.status !== undefined && err.status < 500) {
        this.clear();
        return undefined;
      }
      // Unreachable service: keep working with the cached identity until it can refresh.
      return session;
    }
  }
}
