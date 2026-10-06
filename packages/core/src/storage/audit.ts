import type { Database } from './database';

export interface AuditEntry {
  id: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Who did it: `api`, `cli`, `router`, `runner`… */
  actor: string;
  /** What happened, e.g. `account.create`. */
  action: string;
  /** Affected resource id, if any. */
  target?: string;
  details: Record<string, unknown>;
}

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  /** Free-form context. Never put secrets here. */
  details?: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  details: string;
}

function parseDetails(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Append-only audit trail (`audit_logs` table). */
export class AuditLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  record(input: AuditInput): AuditEntry {
    const ts = this.now();
    const details = input.details ?? {};
    const result = this.db
      .prepare('INSERT INTO audit_logs (ts, actor, action, target, details) VALUES (?, ?, ?, ?, ?)')
      .run(ts, input.actor, input.action, input.target ?? null, JSON.stringify(details));
    const entry: AuditEntry = {
      id: Number(result.lastInsertRowid),
      ts,
      actor: input.actor,
      action: input.action,
      details,
    };
    if (input.target !== undefined) entry.target = input.target;
    return entry;
  }

  /** Most recent entries first, optionally filtered by target. */
  list(options: { limit?: number; target?: string } = {}): AuditEntry[] {
    const limit = Math.max(0, Math.floor(options.limit ?? 100));
    const rows = (
      options.target === undefined
        ? this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit)
        : this.db
            .prepare('SELECT * FROM audit_logs WHERE target = ? ORDER BY id DESC LIMIT ?')
            .all(options.target, limit)
    ) as AuditRow[];
    return rows.map((row) => {
      const entry: AuditEntry = {
        id: row.id,
        ts: row.ts,
        actor: row.actor,
        action: row.action,
        details: parseDetails(row.details),
      };
      if (row.target !== null) entry.target = row.target;
      return entry;
    });
  }
}
