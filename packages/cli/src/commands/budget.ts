import type { AccountBudget, BudgetSnapshot } from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { EXIT } from '../errors';
import { type AccountsBackend, openAccounts } from '../lib/accounts-backend';
import { detectProjectRoot } from '../runtime';
import { bar, type Column, levelStyle, percent, table, truncate } from '../ui/format';
import type { Theme } from '../ui/theme';

export interface BudgetFlags {
  /** Read the local database even if a gateway is running. */
  local?: boolean;
  /** Print only the text injected into agent prompts. */
  context?: boolean;
}

export interface BudgetDeps {
  backend?: AccountsBackend;
}

function planCell(theme: Theme, budget: AccountBudget): string {
  const sub = budget.subscription;
  if (!sub) return theme.dim('—');
  const price = sub.price ? ` ${sub.price.amount} ${sub.price.currency}/${sub.price.period}` : '';
  return truncate(`${sub.plan ?? 'plan'}${price}`, 32);
}

function renewsCell(theme: Theme, budget: AccountBudget): string {
  const days = budget.renewsInDays;
  if (days === undefined) return theme.dim('—');
  if (days < 0) return theme.error(`overdue ${-days}d`);
  return days <= 3 ? theme.warn(`in ${days}d`) : `in ${days}d`;
}

function leftCell(theme: Theme, budget: AccountBudget, width: number): string {
  if (budget.remaining === null) return theme.dim('no limit known');
  const used = 1 - budget.remaining;
  const source = budget.tightestWindow ?? 'provider';
  return `${bar(theme, used, width)} ${levelStyle(theme, used)(percent(budget.remaining))} ${theme.dim(source)}`;
}

export function renderBudget(theme: Theme, snapshot: BudgetSnapshot, columns = 100): string[] {
  if (snapshot.accounts.length === 0) {
    return [
      theme.dim('No accounts yet.'),
      `Add one with ${theme.accent('davecode accounts add')}.`,
    ];
  }
  const cols: Column[] = [
    { header: 'ACCOUNT' },
    { header: 'PROVIDER', drop: 3 },
    { header: 'PLAN', drop: 2 },
    { header: 'RENEWS', drop: 1 },
    { header: 'LEFT' },
    { header: 'STATE' },
  ];
  const width = columns >= 110 ? 10 : 6;
  const rows = snapshot.accounts.map((b) => [
    truncate(b.label, 28),
    b.provider,
    planCell(theme, b),
    renewsCell(theme, b),
    leftCell(theme, b, width),
    b.available
      ? theme.ok('available')
      : theme.warn(truncate(b.unavailableReason ?? 'unavailable', 40)),
  ]);
  const lines = table(theme, cols, rows, columns);
  const missing = snapshot.accounts.filter((b) => !b.subscription).length;
  if (missing > 0) {
    lines.push('');
    lines.push(
      theme.dim(
        `Record what you pay with ${'`davecode accounts plan <id> --plan "Claude Pro" --price 20 --renews 2026-11-01`'}.`,
      ),
    );
  }
  return lines;
}

export async function budgetCommand(
  ctx: CliContext,
  flags: BudgetFlags = {},
  deps: BudgetDeps = {},
): Promise<number> {
  let backend = deps.backend;
  if (!backend) {
    const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
    backend = await openAccounts({
      home: ctx.home,
      env: ctx.env,
      ...(projectRoot ? { projectRoot } : {}),
      ...(flags.local ? { local: true } : {}),
    });
  }
  try {
    const snapshot = await backend.budget();
    if (ctx.json) {
      printJson(ctx, { source: backend.kind, budget: snapshot });
      return EXIT.ok;
    }
    if (flags.context) {
      ctx.out(snapshot.context || ctx.theme.dim('(empty: no enabled accounts)'));
      return EXIT.ok;
    }
    for (const line of renderBudget(ctx.theme, snapshot, ctx.columns)) ctx.out(line);
    ctx.out();
    ctx.out(
      ctx.theme.dim(
        backend.kind === 'gateway'
          ? 'source: running gateway (includes provider-reported limits)'
          : 'source: local state (provider-reported limits need a running gateway)',
      ),
    );
    return EXIT.ok;
  } finally {
    if (!deps.backend) backend.close();
  }
}
