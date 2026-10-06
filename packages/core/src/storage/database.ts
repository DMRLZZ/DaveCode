import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

/**
 * Ordered schema migrations. Index `i` upgrades the schema from version `i` to `i + 1`
 * (tracked in `PRAGMA user_version`). Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,
    provider       TEXT NOT NULL,
    label          TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    priority       INTEGER NOT NULL DEFAULT 100,
    weight         REAL NOT NULL DEFAULT 1,
    limits         TEXT NOT NULL DEFAULT '{}',
    config         TEXT NOT NULL DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'active',
    cooldown_until TEXT,
    last_error     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE secrets (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    ciphertext BLOB NOT NULL,
    iv         BLOB NOT NULL,
    auth_tag   BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    metadata   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE INDEX idx_sessions_account ON sessions(account_id);

  CREATE TABLE token_usage (
    id                TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL,
    error_kind        TEXT,
    ts                INTEGER NOT NULL
  );
  CREATE INDEX idx_token_usage_account_ts ON token_usage(account_id, ts);
  CREATE INDEX idx_token_usage_ts ON token_usage(ts);

  CREATE TABLE audit_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    target  TEXT,
    details TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_audit_logs_ts ON audit_logs(ts);
  `,
];

/** Current schema version of the database. */
export function schemaVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Apply pending migrations, each inside its own transaction. */
export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): number {
  let version = schemaVersion(db);
  if (version > migrations.length) {
    throw new Error(
      `Database schema version ${version} is newer than this DaveCode build supports (${migrations.length}). Upgrade DaveCode.`,
    );
  }
  for (; version < migrations.length; version++) {
    const sql = migrations[version]!;
    const next = version + 1;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${next}`);
    })();
  }
  return version;
}

export interface OpenDatabaseOptions {
  /** Milliseconds to wait on a locked database before failing (default 5000). */
  busyTimeoutMs?: number;
}

/**
 * Open (creating if needed) the DaveCode SQLite database with WAL, foreign keys and a
 * busy timeout, then run migrations. Pass `':memory:'` for an ephemeral database.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
