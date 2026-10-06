import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '../types';
import { AccountRepository } from './accounts';
import { AuditLog } from './audit';
import { type Database, MIGRATIONS, migrate, openDatabase, schemaVersion } from './database';
import { UsageRepository } from './usage';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `use_${Math.random().toString(16).slice(2)}`,
    requestId: 'req_1',
    accountId: 'acc_a',
    provider: 'openai',
    model: 'gpt-x',
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 100,
    status: 'success',
    ts: 1_000,
    ...overrides,
  };
}

describe('openDatabase', () => {
  it('runs migrations and enables foreign keys', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['accounts', 'secrets', 'sessions', 'token_usage', 'audit_logs']),
    );
  });

  it('uses WAL on a file database and is idempotent across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'davecode-db-'));
    try {
      const path = join(dir, 'nested', 'state.db');
      const first = openDatabase(path);
      expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
      new AccountRepository(first).create({ provider: 'openai', label: 'x' });
      first.close();
      const second = openDatabase(path);
      expect(schemaVersion(second)).toBe(MIGRATIONS.length);
      expect(new AccountRepository(second).list()).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies only pending migrations and refuses newer schemas', () => {
    const extra = [...MIGRATIONS, 'CREATE TABLE extra (id INTEGER PRIMARY KEY);'];
    expect(migrate(db, extra)).toBe(extra.length);
    expect(schemaVersion(db)).toBe(extra.length);
    expect(() => migrate(db)).toThrow(/newer/);
  });
});

describe('AccountRepository', () => {
  it('creates accounts with defaults and acc_ ids', () => {
    const repo = new AccountRepository(db, () => Date.UTC(2026, 0, 1));
    const account = repo.create({ provider: 'anthropic', label: 'Work' });
    expect(account.id).toMatch(/^acc_[0-9a-f]{16}$/);
    expect(account).toMatchObject({
      provider: 'anthropic',
      label: 'Work',
      enabled: true,
      priority: 100,
      weight: 1,
      limits: {},
      config: {},
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(account.cooldownUntil).toBeUndefined();
    expect(repo.get(account.id)).toEqual(account);
  });

  it('marks accounts created disabled with status disabled', () => {
    const repo = new AccountRepository(db);
    expect(repo.create({ provider: 'openai', label: 'x', enabled: false }).status).toBe('disabled');
  });

  it('lists by priority then age', () => {
    let t = 0;
    const repo = new AccountRepository(db, () => ++t * 1000);
    const a = repo.create({ provider: 'openai', label: 'a', priority: 50 });
    const b = repo.create({ provider: 'openai', label: 'b', priority: 10 });
    const c = repo.create({ provider: 'openai', label: 'c', priority: 50 });
    expect(repo.list().map((x) => x.id)).toEqual([b.id, a.id, c.id]);
  });

  it('updates fields and clears nullable ones', () => {
    const repo = new AccountRepository(db);
    const account = repo.create({ provider: 'openai', label: 'x' });
    const updated = repo.update(account.id, {
      label: 'y',
      limits: { tpm: 1000 },
      config: { models: ['gpt-x'] },
      status: 'cooldown',
      cooldownUntil: '2030-01-01T00:00:00.000Z',
      lastError: 'boom',
      enabled: false,
      priority: 1,
      weight: 2.5,
    });
    expect(updated).toMatchObject({
      label: 'y',
      limits: { tpm: 1000 },
      config: { models: ['gpt-x'] },
      status: 'cooldown',
      cooldownUntil: '2030-01-01T00:00:00.000Z',
      lastError: 'boom',
      enabled: false,
      priority: 1,
      weight: 2.5,
    });
    const cleared = repo.update(account.id, { cooldownUntil: null, lastError: null });
    expect(cleared?.cooldownUntil).toBeUndefined();
    expect(cleared?.lastError).toBeUndefined();
    expect(repo.update('acc_missing', { label: 'z' })).toBeUndefined();
  });

  it('deletes accounts and cascades to secrets and sessions', () => {
    const repo = new AccountRepository(db);
    const account = repo.create({ provider: 'openai', label: 'x' });
    db.prepare(
      "INSERT INTO secrets (account_id, ciphertext, iv, auth_tag, updated_at) VALUES (?, x'00', x'00', x'00', 'now')",
    ).run(account.id);
    db.prepare(
      "INSERT INTO sessions (id, account_id, kind, created_at, updated_at) VALUES ('s1', ?, 'cli', 'now', 'now')",
    ).run(account.id);
    expect(repo.delete(account.id)).toBe(true);
    expect(repo.delete(account.id)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });
});

describe('UsageRepository', () => {
  it('round-trips records and returns recent first', () => {
    const repo = new UsageRepository(db);
    repo.insert(usage({ id: 'u1', ts: 1 }));
    repo.insert(usage({ id: 'u2', ts: 3, status: 'rate_limited', errorKind: 'rate_limit' }));
    repo.insert(usage({ id: 'u3', ts: 2 }));
    const recent = repo.recent(2);
    expect(recent.map((r) => r.id)).toEqual(['u2', 'u3']);
    expect(recent[0]).toMatchObject({ status: 'rate_limited', errorKind: 'rate_limit' });
    expect(recent[1]?.errorKind).toBeUndefined();
    expect(repo.since(2).map((r) => r.id)).toEqual(['u3', 'u2']);
  });

  it('sums an account since a timestamp', () => {
    const repo = new UsageRepository(db);
    repo.insert(usage({ ts: 100 }));
    repo.insert(usage({ ts: 200, promptTokens: 1, completionTokens: 2 }));
    repo.insert(usage({ ts: 300, accountId: 'acc_b' }));
    expect(repo.totalsSince('acc_a', 150)).toEqual({
      tokens: 3,
      promptTokens: 1,
      completionTokens: 2,
      requests: 1,
    });
    expect(repo.totalsSince('acc_none', 0)).toEqual({
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
    });
  });

  it('builds zero-filled, aligned timeseries buckets', () => {
    const repo = new UsageRepository(db);
    repo.insert(usage({ ts: 60_500 }));
    repo.insert(usage({ ts: 61_000, accountId: 'acc_b', promptTokens: 1, completionTokens: 1 }));
    repo.insert(usage({ ts: 179_999 }));
    repo.insert(usage({ ts: 180_000 })); // == until, excluded
    const buckets = repo.timeseries({ since: 30_000, until: 180_000, bucketMs: 60_000 });
    expect(buckets.map((b) => b.ts)).toEqual([0, 60_000, 120_000]);
    expect(buckets[0]).toEqual({ ts: 0, tokens: 0, requests: 0, byAccount: {} });
    expect(buckets[1]).toEqual({
      ts: 60_000,
      tokens: 17,
      requests: 2,
      byAccount: { acc_a: { tokens: 15, requests: 1 }, acc_b: { tokens: 2, requests: 1 } },
    });
    expect(buckets[2]?.requests).toBe(1);
  });

  it('prunes old records', () => {
    const repo = new UsageRepository(db);
    repo.insert(usage({ ts: 1 }));
    repo.insert(usage({ ts: 10 }));
    expect(repo.prune(5)).toBe(1);
    expect(repo.recent()).toHaveLength(1);
  });
});

describe('AuditLog', () => {
  it('records and lists entries newest first', () => {
    const log = new AuditLog(db, () => 42);
    log.record({ actor: 'api', action: 'account.create', target: 'acc_1', details: { a: 1 } });
    log.record({ actor: 'router', action: 'account.cooldown' });
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ actor: 'router', action: 'account.cooldown', ts: 42 });
    expect(entries[0]?.target).toBeUndefined();
    expect(entries[1]).toMatchObject({ target: 'acc_1', details: { a: 1 } });
    expect(log.list({ target: 'acc_1' })).toHaveLength(1);
    expect(log.list({ limit: 1 })).toHaveLength(1);
  });
});
