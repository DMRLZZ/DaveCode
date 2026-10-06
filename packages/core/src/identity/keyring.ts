import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { globalPaths } from '../paths';
import type { Database } from '../storage/database';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class KeyringError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeyringError';
  }
}

export interface KeyringOptions {
  /** Path of the master key file (default `globalPaths().masterKey`). */
  keyPath?: string;
  /** Environment; `DAVECODE_MASTER_KEY` (base64, 32 bytes) overrides the key file. */
  env?: NodeJS.ProcessEnv;
  /** Explicit 32-byte key (tests). Takes precedence over env and file. */
  key?: Buffer;
  now?: () => number;
}

/**
 * Load the master key: `DAVECODE_MASTER_KEY` if set, else the key file, creating it with
 * mode 0600 when missing (chmod is a no-op on Windows).
 */
export function loadMasterKey(keyPath: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.DAVECODE_MASTER_KEY;
  if (fromEnv !== undefined && fromEnv !== '') {
    const key = Buffer.from(fromEnv, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`DAVECODE_MASTER_KEY must be ${KEY_BYTES} bytes encoded as base64`);
    }
    return key;
  }

  try {
    const key = readFileSync(keyPath);
    if (key.length !== KEY_BYTES) {
      throw new KeyringError(`Master key at ${keyPath} is corrupt (expected ${KEY_BYTES} bytes)`);
    }
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  try {
    // 'wx' fails if another process created the key in the meantime.
    writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return loadMasterKey(keyPath, {});
    throw err;
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Best effort; not supported on every filesystem.
  }
  return key;
}

interface SecretRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
}

/**
 * Per-account secret storage encrypted with AES-256-GCM. Every encryption uses a fresh
 * random IV and binds the ciphertext to its account id (AAD), so rows cannot be swapped.
 */
export class Keyring {
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    options: KeyringOptions = {},
  ) {
    if (options.key && options.key.length !== KEY_BYTES) {
      throw new KeyringError(`Keyring key must be ${KEY_BYTES} bytes`);
    }
    this.key =
      options.key ??
      loadMasterKey(options.keyPath ?? globalPaths().masterKey, options.env ?? process.env);
    this.now = options.now ?? Date.now;
  }

  set(accountId: string, secret: string): void {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(accountId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO secrets (account_id, ciphertext, iv, auth_tag, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv,
           auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`,
      )
      .run(accountId, ciphertext, iv, authTag, new Date(this.now()).toISOString());
  }

  /** Decrypt the secret for an account. Throws {@link KeyringError} if it was tampered with. */
  get(accountId: string): string | undefined {
    const row = this.db
      .prepare('SELECT ciphertext, iv, auth_tag FROM secrets WHERE account_id = ?')
      .get(accountId) as SecretRow | undefined;
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, row.iv);
      decipher.setAAD(Buffer.from(accountId, 'utf8'));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch (err) {
      throw new KeyringError(`Secret for account ${accountId} failed integrity check`, {
        cause: err,
      });
    }
  }

  has(accountId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM secrets WHERE account_id = ?').get(accountId) !== undefined
    );
  }

  /** Remove a secret. Returns false if none was stored. */
  delete(accountId: string): boolean {
    return this.db.prepare('DELETE FROM secrets WHERE account_id = ?').run(accountId).changes > 0;
  }
}
