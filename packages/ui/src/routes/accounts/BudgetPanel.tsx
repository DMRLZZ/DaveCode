import { Bot } from 'lucide-react';
import { useState } from 'react';
import { ProviderIcon } from '../../components/domain';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Panel, PanelHeader } from '../../components/ui/Panel';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatPercent } from '../../lib/format';
import { useBudget } from '../../lib/queries';
import { setParam } from '../../lib/router';
import type { AccountBudget, SubscriptionInfo } from '../../lib/types';

export function planText(subscription: SubscriptionInfo | undefined): string | undefined {
  if (!subscription) return undefined;
  const price = subscription.price
    ? `${subscription.price.amount} ${subscription.price.currency}/${subscription.price.period === 'month' ? 'mo' : 'yr'}`
    : undefined;
  return [subscription.plan, price].filter(Boolean).join(' · ') || undefined;
}

export function RenewalBadge({ days }: { days: number | undefined }) {
  if (days === undefined) return <span className="text-faint">—</span>;
  if (days < 0) return <Badge tone="err">overdue {-days}d</Badge>;
  return (
    <Badge tone={days <= 3 ? 'warn' : 'neutral'} mono>
      {days === 0 ? 'today' : `in ${days}d`}
    </Badge>
  );
}

/** Remaining share of the tightest known limit (own windows or provider-reported). */
export function RemainingMeter({ budget }: { budget: AccountBudget }) {
  if (budget.remaining === null) {
    return <span className="text-2xs text-faint">no limit known</span>;
  }
  const left = budget.remaining;
  const tone = left <= 0.1 ? 'bg-err' : left <= 0.15 ? 'bg-warn' : 'bg-meter';
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: styled like QuotaMeter for consistency */}
      <div
        role="meter"
        aria-label={`${budget.label} remaining budget`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(left * 100)}
        className="relative h-1.5 min-w-16 flex-1 rounded-full bg-track"
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-snappy',
            tone,
          )}
          style={{ width: `${Math.min(100, left * 100)}%` }}
        />
      </div>
      <span className="tnum w-9 shrink-0 text-right font-mono text-2xs text-fg-2">
        {formatPercent(left)}
      </span>
      <span className="w-14 shrink-0 font-mono text-2xs text-muted">
        {budget.tightestWindow ?? 'provider'}
      </span>
    </div>
  );
}

export function BudgetPanel() {
  const budget = useBudget();
  const [showContext, setShowContext] = useState(false);
  const accounts = budget.data?.accounts ?? [];
  const enabled = accounts.filter((a) => a.enabled);
  const available = enabled.filter((a) => a.available).length;

  return (
    <Panel aria-labelledby="budget-title">
      <PanelHeader
        id="budget-title"
        title="Budget"
        meta={
          budget.data
            ? `${available} of ${enabled.length} enabled accounts available · plans are entered by hand`
            : undefined
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={Bot}
            aria-expanded={showContext}
            onClick={() => setShowContext((v) => !v)}
          >
            What agents see
          </Button>
        }
      />
      {budget.isPending ? (
        <SkeletonRows rows={3} />
      ) : budget.isError ? (
        <p className="px-3.5 py-3 text-[12px] text-err">{errorMessage(budget.error)}</p>
      ) : (
        <>
          {showContext && (
            <div className="relative border-b border-line bg-raised px-3.5 py-3">
              <CopyButton
                value={budget.data.context}
                label="Copy agent budget context"
                className="absolute top-2 right-2"
              />
              <pre className="overflow-x-auto pr-8 font-mono text-2xs leading-5 whitespace-pre-wrap text-fg-2">
                {budget.data.context || 'No enabled accounts: agents get no budget context.'}
              </pre>
            </div>
          )}
          <ul className="divide-y divide-line">
            {accounts.map((b) => (
              <li key={b.accountId}>
                <button
                  type="button"
                  onClick={() => setParam('account', b.accountId)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover/60 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_5.5rem_minmax(0,1.2fr)_minmax(0,1fr)]',
                    !b.enabled && 'text-muted',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderIcon provider={b.provider} />
                    <span className="truncate text-[13px] font-medium">{b.label}</span>
                  </span>
                  <span className="truncate text-[12px] text-fg-2">
                    {planText(b.subscription) ?? <span className="text-faint">no plan</span>}
                  </span>
                  <span className="justify-self-end md:justify-self-start">
                    <RenewalBadge days={b.renewsInDays} />
                  </span>
                  <span className="col-span-2 md:col-span-1">
                    <RemainingMeter budget={b} />
                  </span>
                  <span className="truncate text-[12px] md:text-right">
                    {b.available ? (
                      <Badge tone="ok" dot>
                        available
                      </Badge>
                    ) : (
                      <span className="text-warn" title={b.unavailableReason}>
                        {b.unavailableReason ?? 'unavailable'}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
