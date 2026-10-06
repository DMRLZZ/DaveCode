import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountRepository } from '../storage/accounts';
import { type Database, openDatabase } from '../storage/database';
import { Keyring, KeyringError, loadMasterKey } from './keyring';

let home: string;
let db: Database;
let accountId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-keyring-'));
  db = openDatabase(':memory:');
  accountId = new AccountRepository(db).create({ provider: 'openai', label: 'x' }).id;
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe('loadMasterKey', () => {
  it('creates a 32-byte key file once and reuses it', () => {
    const path = join(home, 'sub', 'master.key');
    const key = loadMasterKey(path, {});
    expect(key).toHaveLength(32);
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(path, {}).equals(key)).toBe(true);
    expect(readFileSync(path).equals(key)).toBe(true);
  });

  it('prefers DAVECODE_MASTER_KEY and validates its length', () => {
    const key = randomBytes(32);
    const path = join(home, 'master.key');
    expect(loadMasterKey(path, { DAVECODE_MASTER_KEY: key.toString('base64') }).equals(key)).toBe(
      true,
    );
    expect(existsSync(path)).toBe(false);
    expect(() => loadMasterKey(path, { DAVECODE_MASTER_KEY: 'c2hvcnQ=' })).toThrow(KeyringError);
  });

  it('rejects a corrupt key file', () => {
    const path = join(home, 'master.key');
    writeFileSync(path, 'short');
    expect(() => loadMasterKey(path, {})).toThrow(/corrupt/);
  });
});

describe('Keyring', () => {
  it('encrypts, decrypts, overwrites and deletes secrets', () => {
    const keyring = new Keyring(db, { keyPath: join(home, 'master.key'), env: {} });
    expect(keyring.has(accountId)).toBe(false);
    expect(keyring.get(accountId)).toBeUndefined();
    keyring.set(accountId, 'sk-secret-1');
    expect(keyring.has(accountId)).toBe(true);
    expect(keyring.get(accountId)).toBe('sk-secret-1');
    keyring.set(accountId, 'sk-secret-2');
    expect(keyring.get(accountId)).toBe('sk-secret-2');
    expect(keyring.delete(accountId)).toBe(true);
    expect(keyring.delete(accountId)).toBe(false);
    expect(keyring.get(accountId)).toBeUndefined();
  });

  it('never stores plaintext and uses a fresh IV per encryption', () => {
    const keyring = new Keyring(db, { key: randomBytes(32) });
    keyring.set(accountId, 'sk-plaintext');
    const first = db.prepare('SELECT * FROM secrets').get() as { ciphertext: Buffer; iv: Buffer };
    expect(first.ciphertext.toString('utf8')).not.toContain('sk-plaintext');
    keyring.set(accountId, 'sk-plaintext');
    const second = db.prepare('SELECT * FROM secrets').get() as { iv: Buffer };
    expect(second.iv.equals(first.iv)).toBe(false);
    expect(first.iv).toHaveLength(12);
  });

  it('throws on tampered ciphertext or auth tag', () => {
    const keyring = new Keyring(db, { key: randomBytes(32) });
    keyring.set(accountId, 'sk-secret');
    const row = db.prepare('SELECT ciphertext, auth_tag FROM secrets').get() as {
      ciphertext: Buffer;
      auth_tag: Buffer;
    };
    const tampered = Buffer.from(row.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    db.prepare('UPDATE secrets SET ciphertext = ?').run(tampered);
    expect(() => keyring.get(accountId)).toThrow(KeyringError);

    keyring.set(accountId, 'sk-secret');
    db.prepare('UPDATE secrets SET auth_tag = ?').run(Buffer.alloc(16));
    expect(() => keyring.get(accountId)).toThrow(KeyringError);
  });

  it('binds ciphertext to its account id', () => {
    const keyring = new Keyring(db, { key: randomBytes(32) });
    const other = new AccountRepository(db).create({ provider: 'openai', label: 'y' }).id;
    keyring.set(accountId, 'sk-a');
    keyring.set(other, 'sk-b');
    // Copy account A's encrypted row onto account B.
    db.prepare(
      `UPDATE secrets SET (ciphertext, iv, auth_tag) =
         (SELECT ciphertext, iv, auth_tag FROM secrets WHERE account_id = ?) WHERE account_id = ?`,
    ).run(accountId, other);
    expect(() => keyring.get(other)).toThrow(KeyringError);
  });

  it('cannot decrypt with a different master key', () => {
    new Keyring(db, { key: randomBytes(32) }).set(accountId, 'sk-secret');
    expect(() => new Keyring(db, { key: randomBytes(32) }).get(accountId)).toThrow(KeyringError);
  });

  it('rejects explicit keys of the wrong size', () => {
    expect(() => new Keyring(db, { key: randomBytes(16) })).toThrow(KeyringError);
  });
});
