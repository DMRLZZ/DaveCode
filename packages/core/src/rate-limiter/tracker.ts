import type { EventBus } from '../events';
import type { UsageRepository } from '../storage/usage';
import type { Account, AccountUsage, UsageRecord } from '../types';
import { type QuotaEngine, WINDOW_MS } from './window';

export interface UsageTrackerOptions {
  usage: UsageRepository;
  quota: QuotaEngine;
  events: EventBus;
  /** Look up an account's limits when emitting `quota.updated` (unknown → unlimited). */
  getAccount: (id: string) => Pick<Account, 'id' | 'limits'> | undefined;
}

/**
 * Bridges persistent usage (`token_usage`) and the in-memory {@link QuotaEngine}: hydrates
 * the engine on startup and writes every new record to both, emitting `quota.updated`.
 */
export class UsageTracker {
  constructor(private readonly options: UsageTrackerOptions) {}

  /** Replay the last 24 h of usage into the quota engine. Returns the number of records. */
  hydrate(): number {
    const { quota, usage } = this.options;
    const since = quota.clock() - WINDOW_MS['24h'];
    const records = usage.since(since);
    for (const record of records) {
      quota.record(record.accountId, record.promptTokens + record.completionTokens, {
        ts: record.ts,
      });
    }
    return records.length;
  }

  /** Persist a usage record, count it against the account's windows and broadcast it. */
  record(record: UsageRecord): AccountUsage {
    const { quota, usage, events, getAccount } = this.options;
    usage.insert(record);
    quota.record(record.accountId, record.promptTokens + record.completionTokens, {
      ts: record.ts,
    });
    const current = this.usageFor(
      getAccount(record.accountId) ?? { id: record.accountId, limits: {} },
    );
    events.emit({ type: 'quota.updated', usage: current });
    return current;
  }

  usageFor(account: Pick<Account, 'id' | 'limits'>): AccountUsage {
    return this.options.quota.usage(account);
  }
}
