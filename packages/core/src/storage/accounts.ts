import type { Account, AccountStatus, ProviderKind, QuotaLimits } from '../types';
import type { Database } from './database';
import { newId } from './ids';

export interface AccountCreateInput {
  provider: ProviderKind;
  label: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
}

export interface AccountUpdateInput {
  label?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
  status?: AccountStatus;
  /** ISO timestamp, or `null` to clear. */
  cooldownUntil?: string | null;
  /** Error summary, or `null` to clear. */
  lastError?: string | null;
}

interface AccountRow {
  id: string;
  provider: string;
  label: string;
  enabled: number;
  priority: number;
  weight: number;
  limits: string;
  config: string;
  status: string;
  cooldown_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toAccount(row: AccountRow): Account {
  const account: Account = {
    id: row.id,
    provider: row.provider as ProviderKind,
    label: row.label,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    limits: parseObject(row.limits) as QuotaLimits,
    config: parseObject(row.config),
    status: row.status as AccountStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.cooldown_until) account.cooldownUntil = row.cooldown_until;
  if (row.last_error) account.lastError = row.last_error;
  return account;
}

/** CRUD for provider accounts. Secrets are stored separately by the keyring. */
export class AccountRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: AccountCreateInput): Account {
    const ts = new Date(this.now()).toISOString();
    const enabled = input.enabled ?? true;
    const row: AccountRow = {
      id: newId('acc'),
      provider: input.provider,
      label: input.label,
      enabled: enabled ? 1 : 0,
      priority: input.priority ?? 100,
      weight: input.weight ?? 1,
      limits: JSON.stringify(input.limits ?? {}),
      config: JSON.stringify(input.config ?? {}),
      status: enabled ? 'active' : 'disabled',
      cooldown_until: null,
      last_error: null,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO accounts (id, provider, label, enabled, priority, weight, limits, config,
           status, cooldown_until, last_error, created_at, updated_at)
         VALUES (@id, @provider, @label, @enabled, @priority, @weight, @limits, @config,
           @status, @cooldown_until, @last_error, @created_at, @updated_at)`,
      )
      .run(row);
    return toAccount(row);
  }

  /** All accounts ordered by priority, then creation time. */
  list(): Account[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY priority ASC, created_at ASC, id ASC')
      .all() as AccountRow[];
    return rows.map(toAccount);
  }

  get(id: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : undefined;
  }

  /** Apply a partial update. Returns the updated account, or `undefined` if it does not exist. */
  update(id: string, patch: AccountUpdateInput): Account | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = @${column}`);
      params[column] = value;
    };
    if (patch.label !== undefined) set('label', patch.label);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.priority !== undefined) set('priority', patch.priority);
    if (patch.weight !== undefined) set('weight', patch.weight);
    if (patch.limits !== undefined) set('limits', JSON.stringify(patch.limits));
    if (patch.config !== undefined) set('config', JSON.stringify(patch.config));
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.cooldownUntil !== undefined) set('cooldown_until', patch.cooldownUntil);
    if (patch.lastError !== undefined) set('last_error', patch.lastError);
    set('updated_at', new Date(this.now()).toISOString());
    const result = this.db
      .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
    return result.changes > 0 ? this.get(id) : undefined;
  }

  /** Delete an account (its secret and sessions cascade). Returns false if it did not exist. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }
}
