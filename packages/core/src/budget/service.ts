import type { ReportedLimitsStore } from '../rate-limiter/reported';
import { reportedFraction } from '../rate-limiter/reported';
import { type Clock, QUOTA_WINDOWS, type QuotaEngine } from '../rate-limiter/window';
import type { Router, SkipReason } from '../router/router';
import type { AccountRepository } from '../storage/accounts';
import type {
  Account,
  AccountBudget,
  BudgetSnapshot,
  QuotaWindow,
  ReportedLimits,
  SubscriptionInfo,
} from '../types';

const DAY_MS = 86_400_000;
/** Accounts listed in the prompt context; the rest are summarised in one line. */
const CONTEXT_ACCOUNTS = 12;

export interface BudgetServiceOptions {
  accounts: Pick<AccountRepository, 'list'>;
  quota: QuotaEngine;
  reported: ReportedLimitsStore;
  router: Pick<Router, 'unavailableReason'>;
  clock?: Clock;
}

function isoTime(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

function describeReason(
  reason: SkipReason,
  account: Account,
  reported: ReportedLimits | undefined,
): string {
  switch (reason) {
    case 'disabled':
      return 'disabled';
    case 'error':
      return 'credentials rejected (fix the account)';
    case 'experimental':
      return 'experimental provider is off';
    case 'no_provider':
      return 'no adapter for this provider';
    case 'no_tools':
      return 'provider does not support tool calls';
    case 'subscription':
      return 'not the primary subscription account (rotation is off)';
    case 'cooldown':
      return account.cooldownUntil
        ? `cooling down until ${isoTime(account.cooldownUntil)}`
        : 'cooling down';
    case 'circuit_open':
      return 'paused after repeated failures';
    case 'quota':
      return reported && reportedFraction(reported) === 0
        ? `provider quota exhausted${reported.resetAt ? ` until ${isoTime(reported.resetAt)}` : ''}`
        : 'local quota limit reached';
  }
}

function priceText(subscription: SubscriptionInfo): string | undefined {
  const { price } = subscription;
  return price ? `${price.amount} ${price.currency}/${price.period}` : undefined;
}

/**
 * Per-account budget: subscription details, remaining capacity (own quota windows and
 * provider-reported limits) and availability, plus a compact text for agent prompts.
 */
export class BudgetService {
  private readonly clock: Clock;

  constructor(private readonly options: BudgetServiceOptions) {
    this.clock = options.clock ?? options.quota.clock;
  }

  accountBudget(account: Account, all?: readonly Account[]): AccountBudget {
    const usage = this.options.quota.usage(account);
    let own: number | undefined;
    let tightestWindow: QuotaWindow | undefined;
    for (const window of QUOTA_WINDOWS) {
      const w = usage.windows[window];
      if (w.tokenLimit === undefined && w.requestLimit === undefined) continue;
      const left = Math.max(0, 1 - w.utilization);
      if (own === undefined || left < own) {
        own = left;
        tightestWindow = window;
      }
    }
    const reported = this.options.reported.get(account.id);
    const fromProvider = reported ? reportedFraction(reported) : undefined;
    const parts = [own, fromProvider].filter((x): x is number => x !== undefined);
    const remaining = parts.length > 0 ? Math.min(...parts) : null;

    const reason = this.options.router.unavailableReason(account, all);
    const budget: AccountBudget = {
      accountId: account.id,
      label: account.label,
      provider: account.provider,
      enabled: account.enabled,
      remaining,
      usage,
      available: reason === undefined,
    };
    if (tightestWindow && own !== undefined && own === remaining) {
      budget.tightestWindow = tightestWindow;
    }
    if (account.subscription) {
      budget.subscription = account.subscription;
      const renews = account.subscription.renewsAt
        ? Date.parse(account.subscription.renewsAt)
        : Number.NaN;
      if (!Number.isNaN(renews)) budget.renewsInDays = Math.ceil((renews - this.clock()) / DAY_MS);
    }
    if (reported) budget.reported = reported;
    if (reason) budget.unavailableReason = describeReason(reason, account, reported);
    return budget;
  }

  snapshot(): BudgetSnapshot {
    const all = this.options.accounts.list();
    const accounts = all.map((account) => this.accountBudget(account, all));
    return {
      generatedAt: new Date(this.clock()).toISOString(),
      accounts,
      context: this.render(accounts),
    };
  }

  /** The compact text injected into the orchestrator and agent prompts. */
  context(): string {
    return this.snapshot().context;
  }

  private render(accounts: AccountBudget[]): string {
    const enabled = accounts.filter((a) => a.enabled);
    if (enabled.length === 0) return '';
    const available = enabled.filter((a) => a.available).length;
    const lines = [
      `ACCOUNT BUDGET (${isoTime(new Date(this.clock()).toISOString())}; ${available} of ${enabled.length} accounts available).`,
      'The router already avoids exhausted accounts. When budget is scarce, keep prompts and outputs short and prefer fewer, larger steps.',
    ];
    for (const a of enabled.slice(0, CONTEXT_ACCOUNTS)) {
      const details: string[] = [];
      const plan = a.subscription?.plan;
      if (plan) details.push(plan);
      const price = a.subscription ? priceText(a.subscription) : undefined;
      if (price) details.push(price);
      if (a.renewsInDays !== undefined) {
        details.push(
          a.renewsInDays >= 0
            ? `renews in ${a.renewsInDays}d`
            : `renewal overdue ${-a.renewsInDays}d`,
        );
      }
      const head = `- ${a.label} [${a.provider}]${details.length ? ` (${details.join(', ')})` : ''}`;
      let state: string;
      if (!a.available) state = `unavailable: ${a.unavailableReason ?? 'unknown'}`;
      else if (a.remaining === null) state = 'no known limit';
      else {
        const pct = Math.round(a.remaining * 100);
        state = `${pct}% left${a.tightestWindow ? ` (${a.tightestWindow} window)` : ' (provider-reported)'}`;
      }
      lines.push(`${head}: ${state}`);
    }
    if (enabled.length > CONTEXT_ACCOUNTS) {
      lines.push(`- …and ${enabled.length - CONTEXT_ACCOUNTS} more accounts`);
    }
    return lines.join('\n');
  }
}
