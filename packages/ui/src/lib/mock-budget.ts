import type {
  Account,
  AccountBudget,
  AccountUsage,
  BudgetSnapshot,
  QuotaWindow,
  SubscriptionInfo,
} from './types';

const DAY = 86_400_000;
const WINDOWS: QuotaWindow[] = ['1m', '5h', '24h'];

/** Demo plans, relative to the mock clock so renewals always look current. */
const PLANS: Record<string, { info: SubscriptionInfo; paidDaysAgo: number; renewsInDays: number }> =
  {
    acc_claude_pro: {
      info: { plan: 'Claude Pro', price: { amount: 20, currency: 'USD', period: 'month' } },
      paidDaysAgo: 21,
      renewsInDays: 9,
    },
    acc_anthropic_work: {
      info: {
        plan: 'API — Build tier 2',
        price: { amount: 250, currency: 'USD', period: 'month' },
        notes: 'Prepaid credits, topped up monthly',
      },
      paidDaysAgo: 12,
      renewsInDays: 18,
    },
    acc_openai_team: {
      info: { plan: 'ChatGPT Team', price: { amount: 300, currency: 'USD', period: 'year' } },
      paidDaysAgo: 340,
      renewsInDays: 2,
    },
  };

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function mockSubscription(accountId: string, now: number): SubscriptionInfo | undefined {
  const plan = PLANS[accountId];
  if (!plan) return undefined;
  return {
    ...plan.info,
    paidAt: day(now - plan.paidDaysAgo * DAY),
    renewsAt: day(now + plan.renewsInDays * DAY),
  };
}

function budgetFor(account: Account, usage: AccountUsage, now: number): AccountBudget {
  let remaining: number | null = null;
  let tightest: QuotaWindow | undefined;
  for (const window of WINDOWS) {
    const w = usage.windows[window];
    if (w.tokenLimit === undefined && w.requestLimit === undefined) continue;
    const left = Math.max(0, 1 - w.utilization);
    if (remaining === null || left < remaining) {
      remaining = left;
      tightest = window;
    }
  }
  const budget: AccountBudget = {
    accountId: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    remaining,
    usage,
    available: account.enabled && account.status === 'active' && (remaining ?? 1) > 0,
  };
  if (tightest) budget.tightestWindow = tightest;
  if (account.subscription) {
    budget.subscription = account.subscription;
    const renews = account.subscription.renewsAt
      ? Date.parse(account.subscription.renewsAt)
      : Number.NaN;
    if (!Number.isNaN(renews)) budget.renewsInDays = Math.ceil((renews - now) / DAY);
  }
  if (!budget.available) {
    budget.unavailableReason = !account.enabled
      ? 'disabled'
      : account.status === 'cooldown'
        ? 'cooling down'
        : account.status === 'error'
          ? 'credentials rejected (fix the account)'
          : 'local quota limit reached';
  }
  return budget;
}

function render(accounts: AccountBudget[], now: number): string {
  const enabled = accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return '';
  const stamp = `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const lines = [
    `ACCOUNT BUDGET (${stamp}; ${enabled.filter((a) => a.available).length} of ${enabled.length} accounts available).`,
    'The router already avoids exhausted accounts. When budget is scarce, keep prompts and outputs short and prefer fewer, larger steps.',
  ];
  for (const a of enabled) {
    const details: string[] = [];
    if (a.subscription?.plan) details.push(a.subscription.plan);
    const price = a.subscription?.price;
    if (price) details.push(`${price.amount} ${price.currency}/${price.period}`);
    if (a.renewsInDays !== undefined) details.push(`renews in ${a.renewsInDays}d`);
    const head = `- ${a.label} [${a.provider}]${details.length ? ` (${details.join(', ')})` : ''}`;
    const state = !a.available
      ? `unavailable: ${a.unavailableReason}`
      : a.remaining === null
        ? 'no known limit'
        : `${Math.round(a.remaining * 100)}% left (${a.tightestWindow} window)`;
    lines.push(`${head}: ${state}`);
  }
  return lines.join('\n');
}

/** Same shape the gateway's BudgetService returns, computed from the mock's own state. */
export function buildMockBudget(
  accounts: Account[],
  usageFor: (account: Account) => AccountUsage,
  now: number,
): BudgetSnapshot {
  const budgets = accounts.map((a) => budgetFor(a, usageFor(a), now));
  return {
    generatedAt: new Date(now).toISOString(),
    accounts: budgets,
    context: render(budgets, now),
  };
}
