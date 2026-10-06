import { ArrowDownRight, ArrowUpRight, ChartArea, Table2, Users } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ActivityFeed, type FeedItem, toFeedItem } from '../components/ActivityFeed';
import { AreaChart, Sparkline } from '../components/charts/AreaChart';
import { QuotaLegend, QuotaMeter } from '../components/charts/QuotaMeter';
import { ShareBar } from '../components/charts/ShareBar';
import { AccountLabel, AccountStatusBadge } from '../components/domain';
import { EmptyState } from '../components/ui/EmptyState';
import { PageHeader, Panel, PanelHeader } from '../components/ui/Panel';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton, SkeletonRows } from '../components/ui/Skeleton';
import { cn } from '../lib/cn';
import { useLive } from '../lib/data';
import { formatCompact, formatDuration, formatHM, formatInt, formatPercent } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useAccounts, useHealth, useTimeseries, useUsage } from '../lib/queries';
import { Link } from '../lib/router';
import { accountSlots, mergeBurn, recentAverage } from '../lib/series';
import type { Account } from '../lib/types';

export function Overview() {
  const health = useHealth();
  const accounts = useAccounts();
  const usage = useUsage();
  const timeseries = useTimeseries(60, 60);
  const live = useLive();
  const now = useNow(5000);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const burn = useMemo(
    () => mergeBurn(timeseries.data, live.minutes, now),
    [timeseries.data, live.minutes, now],
  );
  const tokenSeries = burn.map((p) => p.tokens);
  const requestSeries = burn.map((p) => p.requests);
  const tokensPerMin = recentAverage(tokenSeries, 5);
  const prevTokens = recentAverage(tokenSeries.slice(0, -5), 15);
  const requestsPerMin = recentAverage(requestSeries, 5);
  const hourRequests = requestSeries.reduce((s, v) => s + v, 0);
  const failovers = live.failoverTs.filter((t) => t >= now - 3_600_000).length;

  const accountMap = useMemo(
    () => new Map((accounts.data ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
  const usageMap = useMemo(
    () => new Map((usage.data ?? []).map((u) => [u.accountId, u])),
    [usage.data],
  );

  const feed = useMemo(() => {
    const items: FeedItem[] = [];
    const seen = new Set<string>();
    for (let i = live.events.length - 1; i >= 0 && items.length < 40; i--) {
      const e = live.events[i];
      if (!e) continue;
      const item = toFeedItem(e, accountMap);
      if (item && !seen.has(item.key)) {
        seen.add(item.key);
        items.push(item);
      }
    }
    return items;
  }, [live.events, accountMap]);

  const share = useMemo(() => {
    const slots = accountSlots(accounts.data);
    const totals = new Map<string, number>();
    for (const b of timeseries.data ?? []) {
      for (const [id, v] of Object.entries(b.byAccount))
        totals.set(id, (totals.get(id) ?? 0) + v.tokens);
    }
    return (accounts.data ?? [])
      .filter((a) => a.enabled || (totals.get(a.id) ?? 0) > 0)
      .map((a) => ({
        id: a.id,
        label: a.label,
        value: totals.get(a.id) ?? 0,
        slot: slots.get(a.id) ?? 99,
      }));
  }, [accounts.data, timeseries.data]);

  const active = accounts.data?.filter((a) => a.status === 'active').length ?? 0;
  const cooling = accounts.data?.filter((a) => a.status === 'cooldown').length ?? 0;
  const enabledAccounts = (accounts.data ?? []).filter((a) => a.enabled);
  const loadingSeries = timeseries.isPending && live.minutes.length === 0;
  const delta = prevTokens > 0 ? tokensPerMin / prevTokens - 1 : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description="Gateway health, token burn and quota pressure across every account."
      />

      <Panel aria-label="Key metrics" className="grid grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Token burn"
          hint="tokens / min · 5 min avg"
          loading={loadingSeries}
          value={formatCompact(tokensPerMin)}
          trend={<Sparkline values={tokenSeries.slice(-30)} />}
          delta={
            prevTokens > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-muted">
                {delta >= 0 ? (
                  <ArrowUpRight aria-hidden className="size-3" strokeWidth={2} />
                ) : (
                  <ArrowDownRight aria-hidden className="size-3" strokeWidth={2} />
                )}
                <span className="tnum">{formatPercent(Math.abs(delta))}</span>
                <span className="sr-only">{delta >= 0 ? 'up' : 'down'}</span> vs prior 15 min
              </span>
            ) : null
          }
        />
        <Stat
          label="Requests"
          hint="per min · 5 min avg"
          loading={loadingSeries}
          value={requestsPerMin.toFixed(1)}
          trend={<Sparkline values={requestSeries.slice(-30)} />}
          delta={
            <span className="text-muted">
              <span className="tnum text-fg-2">{formatInt(hourRequests)}</span> in the last hour
            </span>
          }
          className="border-l border-line"
        />
        <Stat
          label="Failovers"
          hint="last hour"
          loading={loadingSeries}
          value={formatInt(failovers)}
          delta={
            <span className="text-muted">
              <span className="tnum text-fg-2">
                {hourRequests ? formatPercent(failovers / hourRequests, 1) : '0%'}
              </span>{' '}
              of requests rerouted
            </span>
          }
          className="border-t border-line lg:border-t-0 lg:border-l"
        />
        <Stat
          label="System"
          hint={health.data ? `v${health.data.version}` : 'gateway'}
          loading={health.isPending}
          value={
            health.isError ? (
              <span className="text-err">Down</span>
            ) : (
              <span className="inline-flex items-center gap-2">
                {health.data?.status === 'ok' ? 'Healthy' : (health.data?.status ?? '—')}
              </span>
            )
          }
          delta={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
              {health.data && <span>up {formatDuration(health.data.uptimeSec)}</span>}
              <span aria-hidden className="text-faint">
                ·
              </span>
              <span>
                <span className="tnum text-fg-2">{active}</span> active
                {cooling > 0 && (
                  <>
                    , <span className="tnum text-warn">{cooling}</span> cooling
                  </>
                )}
              </span>
            </span>
          }
          className="border-t border-l border-line lg:border-t-0"
        />
      </Panel>

      <div className="grid grid-cols-12 gap-4">
        <Panel className="col-span-12 xl:col-span-8" aria-labelledby="burn-title">
          <PanelHeader
            id="burn-title"
            title="Token burn"
            meta="tokens per minute · last 60 min · live tail"
            actions={
              <Segmented
                size="sm"
                label="Token burn view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'chart', label: 'Chart', icon: ChartArea },
                  { value: 'table', label: 'Table', icon: Table2 },
                ]}
              />
            }
          />
          <div className="px-3.5 pt-3 pb-2">
            {loadingSeries ? (
              <Skeleton className="h-[240px] w-full" />
            ) : view === 'chart' ? (
              <AreaChart
                height={240}
                label="Token burn, tokens per minute over the last 60 minutes"
                unit="tokens/min"
                secondaryLabel="requests"
                liveTail
                points={burn.map((p) => ({ ts: p.ts, value: p.tokens, secondary: p.requests }))}
              />
            ) : (
              <div className="h-[240px] overflow-y-auto rounded-md border border-line">
                <table className="w-full text-[12px]">
                  <caption className="sr-only">Tokens and requests per minute</caption>
                  <thead className="sticky top-0 bg-raised text-left text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-1.5 font-medium">
                        Minute
                      </th>
                      <th scope="col" className="px-3 py-1.5 text-right font-medium">
                        Tokens
                      </th>
                      <th scope="col" className="px-3 py-1.5 text-right font-medium">
                        Requests
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...burn].reverse().map((p, i) => (
                      <tr key={p.ts} className="border-t border-line">
                        <td className="tnum px-3 py-1 font-mono text-fg-2">
                          {formatHM(p.ts)}
                          {i === 0 && <span className="ml-2 text-muted">in progress</span>}
                        </td>
                        <td className="tnum px-3 py-1 text-right font-mono text-fg">
                          {formatInt(p.tokens)}
                        </td>
                        <td className="tnum px-3 py-1 text-right font-mono text-fg-2">
                          {p.requests}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Panel>

        <Panel
          className="col-span-12 h-[320px] xl:col-span-4 xl:h-auto"
          aria-labelledby="activity-title"
        >
          <PanelHeader
            id="activity-title"
            title="Recent activity"
            meta="failovers · cooldowns · runner"
            actions={
              <Link to="/traffic" className="text-[12px] text-muted hover:text-fg">
                Traffic →
              </Link>
            }
          />
          {/* Absolutely positioned so the feed never stretches the row past the chart. */}
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0 overflow-y-auto">
              <ActivityFeed items={feed} />
            </div>
          </div>
        </Panel>

        <Panel className="col-span-12 xl:col-span-8" aria-labelledby="quota-title">
          <PanelHeader
            id="quota-title"
            title="Quota utilization"
            meta="sliding windows per account"
            actions={<QuotaLegend />}
          />
          {accounts.isPending || usage.isPending ? (
            <SkeletonRows rows={4} />
          ) : enabledAccounts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No accounts yet"
              description="Add a provider account to start routing traffic through the gateway."
              command="davecode add-account"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[12px]">
                <caption className="sr-only">Quota utilization per account and window</caption>
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th scope="col" className="w-[30%] px-3.5 py-2 font-medium">
                      Account
                    </th>
                    <th scope="col" className="w-[19%] px-2 py-2 font-medium">
                      1 min
                    </th>
                    <th scope="col" className="w-[19%] px-2 py-2 font-medium">
                      5 h
                    </th>
                    <th scope="col" className="w-[19%] px-2 py-2 font-medium">
                      24 h
                    </th>
                    <th scope="col" className="px-3.5 py-2 text-right font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {enabledAccounts.map((a: Account) => {
                    const u = usageMap.get(a.id);
                    return (
                      <tr
                        key={a.id}
                        className="border-b border-line last:border-b-0 hover:bg-hover/50"
                      >
                        <td className="max-w-0 px-3.5 py-2.5">
                          <AccountLabel account={a} />
                        </td>
                        <td className="px-2 py-2.5">
                          <QuotaMeter compact label="1m" usage={u?.windows['1m']} />
                        </td>
                        <td className="px-2 py-2.5">
                          <QuotaMeter compact label="5h" usage={u?.windows['5h']} />
                        </td>
                        <td className="px-2 py-2.5">
                          <QuotaMeter compact label="24h" usage={u?.windows['24h']} />
                        </td>
                        <td className="px-3.5 py-2.5 text-right">
                          <AccountStatusBadge account={a} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel className="col-span-12 xl:col-span-4" aria-labelledby="share-title">
          <PanelHeader id="share-title" title="Traffic share" meta="tokens by account · 60 min" />
          <div className="p-3.5">
            {timeseries.isPending || accounts.isPending ? (
              <SkeletonRows rows={3} />
            ) : (
              <ShareBar items={share} unit="tokens" />
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Stat({
  label,
  hint,
  value,
  delta,
  trend,
  loading,
  className,
}: {
  label: string;
  hint: string;
  value: ReactNode;
  delta?: ReactNode;
  trend?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 px-4 py-3.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[12px] font-medium text-fg-2">{label}</h2>
        <span className="truncate text-2xs text-muted">{hint}</span>
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-32" />
        </>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <p className="text-[26px] leading-8 font-semibold tracking-tight text-fg">{value}</p>
            {trend && <div className="hidden pb-1 sm:block">{trend}</div>}
          </div>
          {delta && <div className="truncate text-[12px]">{delta}</div>}
        </>
      )}
    </div>
  );
}
