import {
  type Account,
  type AccountUpdateInput,
  createEngine,
  type DaveConfig,
  type Engine,
  type ProviderKind,
  type QuotaLimits,
} from '@davecode/core';
import { accountCreateSchema, accountPatchSchema } from '@davecode/server';
import { z } from 'zod';
import { findGateway, type GatewayClient } from '../client';
import { CliError } from '../errors';

/** Body of `POST /api/accounts` (secret is write-only). */
export interface AccountCreate {
  provider: ProviderKind;
  label: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
  secret?: string;
}

export type AccountPatch = Partial<Omit<AccountCreate, 'provider'>>;

/**
 * Account operations against a running gateway (so the dashboard sees the change live) or, when
 * none is running, directly against `state.db` with the same validation and audit trail.
 */
export interface AccountsBackend {
  readonly kind: 'gateway' | 'local';
  readonly config: DaveConfig;
  list(): Promise<Account[]>;
  get(id: string): Promise<Account | undefined>;
  create(input: AccountCreate): Promise<Account>;
  update(id: string, patch: AccountPatch): Promise<Account>;
  remove(id: string): Promise<void>;
  close(): void;
}

function invalid(error: z.ZodError): CliError {
  return new CliError(`Invalid account: ${z.prettifyError(error)}`);
}

export class LocalAccounts implements AccountsBackend {
  readonly kind = 'local' as const;

  constructor(readonly engine: Engine) {}

  get config(): DaveConfig {
    return this.engine.config;
  }

  async list(): Promise<Account[]> {
    return this.engine.accounts.list();
  }

  async get(id: string): Promise<Account | undefined> {
    return this.engine.accounts.get(id);
  }

  async create(input: AccountCreate): Promise<Account> {
    const parsed = accountCreateSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error);
    const { secret, ...fields } = parsed.data;
    const { accounts, keyring, audit, db } = this.engine;
    return db.transaction(() => {
      const created = accounts.create(fields);
      if (secret !== undefined) keyring.set(created.id, secret);
      audit.record({
        actor: 'cli',
        action: 'account.create',
        target: created.id,
        details: { provider: created.provider, label: created.label, hasSecret: !!secret },
      });
      return created;
    })();
  }

  async update(id: string, patch: AccountPatch): Promise<Account> {
    const parsed = accountPatchSchema.safeParse(patch);
    if (!parsed.success) throw invalid(parsed.error);
    const existing = this.engine.accounts.get(id);
    if (!existing) throw notFound(id);
    const { secret, ...fields } = parsed.data;
    const update: AccountUpdateInput = { ...fields };
    const enabled = fields.enabled ?? existing.enabled;
    if (!enabled) {
      update.status = 'disabled';
    } else if (fields.enabled === true || secret !== undefined) {
      update.status = 'active';
      update.cooldownUntil = null;
      update.lastError = null;
    }
    const { accounts, keyring, audit, db } = this.engine;
    return db.transaction(() => {
      const updated = accounts.update(id, update)!;
      if (secret !== undefined) keyring.set(id, secret);
      audit.record({
        actor: 'cli',
        action: 'account.update',
        target: id,
        details: { fields: Object.keys(fields), secretChanged: secret !== undefined },
      });
      return updated;
    })();
  }

  async remove(id: string): Promise<void> {
    const { accounts, sandboxes, chromium, audit } = this.engine;
    if (!accounts.delete(id)) throw notFound(id);
    for (const cleanup of [() => sandboxes.remove(id), () => chromium.remove(id)]) {
      try {
        cleanup();
      } catch {
        // A leftover directory is harmless; the account row is gone.
      }
    }
    audit.record({ actor: 'cli', action: 'account.delete', target: id });
  }

  close(): void {
    this.engine.close();
  }
}

export class GatewayAccounts implements AccountsBackend {
  readonly kind = 'gateway' as const;

  constructor(
    readonly client: GatewayClient,
    readonly config: DaveConfig,
  ) {}

  async list(): Promise<Account[]> {
    return (await this.client.get<{ accounts: Account[] }>('/api/accounts')).accounts;
  }

  async get(id: string): Promise<Account | undefined> {
    return (await this.list()).find((a) => a.id === id);
  }

  async create(input: AccountCreate): Promise<Account> {
    return (await this.client.post<{ account: Account }>('/api/accounts', input)).account;
  }

  async update(id: string, patch: AccountPatch): Promise<Account> {
    return (
      await this.client.patch<{ account: Account }>(
        `/api/accounts/${encodeURIComponent(id)}`,
        patch,
      )
    ).account;
  }

  async remove(id: string): Promise<void> {
    await this.client.delete(`/api/accounts/${encodeURIComponent(id)}`);
  }

  close(): void {}
}

function notFound(id: string): CliError {
  return new CliError(`No account with id ${JSON.stringify(id)}`, {
    hint: 'List accounts with `davecode accounts list`.',
  });
}

/** Prefer the running gateway; fall back to the local database. */
export async function openAccounts(options: {
  home: string;
  env: NodeJS.ProcessEnv;
  projectRoot?: string;
  /** Skip the gateway probe (tests, or `--local`). */
  local?: boolean;
}): Promise<AccountsBackend> {
  const engine = createEngine({
    home: options.home,
    env: options.env,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  if (!options.local) {
    const gateway = await findGateway(engine.config).catch(() => undefined);
    if (gateway) {
      const config = engine.config;
      engine.close();
      return new GatewayAccounts(gateway.client, config);
    }
  }
  return new LocalAccounts(engine);
}

/** Resolve an account by exact id, or by unique label/id prefix for convenience. */
export async function resolveAccount(backend: AccountsBackend, ref: string): Promise<Account> {
  const accounts = await backend.list();
  const exact = accounts.find((a) => a.id === ref);
  if (exact) return exact;
  const matches = accounts.filter(
    (a) => a.label.toLowerCase() === ref.toLowerCase() || a.id.startsWith(ref),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new CliError(`${JSON.stringify(ref)} matches ${matches.length} accounts`, {
      hint: `Use the full id: ${matches.map((a) => a.id).join(', ')}`,
    });
  }
  throw notFound(ref);
}
