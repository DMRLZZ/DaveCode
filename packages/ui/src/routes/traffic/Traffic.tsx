import { Activity, Pause, Play, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input, Select } from '../../components/ui/Field';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Segmented } from '../../components/ui/Segmented';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { cn } from '../../lib/cn';
import { useData, useLive } from '../../lib/data';
import { formatClock, formatCompact, formatLatency, shortId } from '../../lib/format';
import { useAccounts } from '../../lib/queries';
import { setParam, useLocation } from '../../lib/router';
import { chainLatency, chainTokens, type RequestChain } from '../../lib/traffic';
import { ChainView, OutcomeBadge } from './Chain';
import { RequestSheet } from './RequestSheet';

type OutcomeFilter = 'all' | 'ok' | 'failover' | 'failed' | 'pending';

function matches(c: RequestChain, f: OutcomeFilter): boolean {
  switch (f) {
    case 'ok':
      return c.outcome === 'success' && c.failovers === 0;
    case 'failover':
      return c.failovers > 0;
    case 'failed':
      return c.outcome === 'failed';
    case 'pending':
      return c.outcome === 'pending';
    default:
      return true;
  }
}

const ROW_LIMIT = 250;

export function Traffic() {
  const live = useLive();
  const { connection } = useData();
  const accounts = useAccounts();
  const { params } = useLocation();
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [accountId, setAccountId] = useState('');
  const [frozen, setFrozen] = useState<RequestChain[] | null>(null);

  const accountMap = useMemo(
    () => new Map((accounts.data ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
  const source = frozen ?? live.chains;
  const newWhilePaused = frozen ? Math.max(0, live.chains.length - frozen.length) : 0;

  const counts = useMemo(() => {
    const c: Record<OutcomeFilter, number> = { all: 0, ok: 0, failover: 0, failed: 0, pending: 0 };
    for (const ch of source) {
      c.all += 1;
      if (matches(ch, 'ok')) c.ok += 1;
      if (matches(ch, 'failover')) c.failover += 1;
      if (matches(ch, 'failed')) c.failed += 1;
      if (matches(ch, 'pending')) c.pending += 1;
    }
    return c;
  }, [source]);

  const q = query.trim().toLowerCase();
  const rows = source
    .filter(
      (c) =>
        matches(c, outcome) &&
        (!accountId || c.attempts.some((a) => a.accountId === accountId)) &&
        (!q ||
          c.requestId.toLowerCase().includes(q) ||
          c.model.toLowerCase().includes(q) ||
          c.attempts.some(
            (a) =>
              a.accountId.toLowerCase().includes(q) ||
              (accountMap.get(a.accountId)?.label.toLowerCase().includes(q) ?? false),
          )),
    )
    .slice(0, ROW_LIMIT);

  const selectedId = params.get('req');
  const selected = selectedId ? live.chains.find((c) => c.requestId === selectedId) : undefined;
  const loading = live.chains.length === 0 && connection.mode !== 'live';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Traffic"
        description="Every request through /v1, with failover hops shown inline."
        actions={
          <div className="flex items-center gap-2">
            {frozen ? (
              <Badge tone="warn">paused{newWhilePaused > 0 && ` · ${newWhilePaused} new`}</Badge>
            ) : (
              <Badge tone="ok" dot pulse>
                streaming
              </Badge>
            )}
            <Button
              icon={frozen ? Play : Pause}
              onClick={() => setFrozen(frozen ? null : live.chains)}
              aria-pressed={Boolean(frozen)}
            >
              {frozen ? 'Resume' : 'Pause'}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted"
            strokeWidth={1.75}
          />
          <Input
            type="search"
            aria-label="Filter requests"
            placeholder="Model, request id or account"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            data-filter-input
          />
        </div>
        <Segmented
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'ok', label: 'OK', count: counts.ok },
            { value: 'failover', label: 'Failover', count: counts.failover },
            { value: 'failed', label: 'Failed', count: counts.failed },
            { value: 'pending', label: 'In flight', count: counts.pending },
          ]}
        />
        <Select
          aria-label="Filter by account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="w-auto min-w-44"
        >
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </Select>
      </div>

      <Panel>
        {loading ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          live.chains.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No requests yet"
              description="Point any OpenAI-compatible client at the gateway and use a davecode/<route> model."
              command={`curl http://127.0.0.1:4040/v1/chat/completions -H 'content-type: application/json' -d '{"model":"davecode/auto","messages":[{"role":"user","content":"hi"}]}'`}
            />
          ) : (
            <EmptyState
              icon={Search}
              title="No matching requests"
              description="Try a different filter."
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-[12px]">
              <caption className="sr-only">Recent requests, newest first</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="w-24 px-3.5 py-2 font-medium">
                    Time
                  </th>
                  <th scope="col" className="w-24 px-2 py-2 font-medium">
                    Request
                  </th>
                  <th scope="col" className="w-40 px-2 py-2 font-medium">
                    Model
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Accounts
                  </th>
                  <th scope="col" className="w-20 px-2 py-2 text-right font-medium">
                    Latency
                  </th>
                  <th scope="col" className="w-28 px-2 py-2 text-right font-medium">
                    Tokens in → out
                  </th>
                  <th scope="col" className="w-36 px-3.5 py-2 text-right font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const t = chainTokens(c);
                  const latency = chainLatency(c);
                  return (
                    <tr
                      key={c.requestId}
                      onClick={() => setParam('req', c.requestId)}
                      className={cn(
                        'animate-row-in cursor-pointer border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-hover/60',
                        selectedId === c.requestId && 'bg-hover/60',
                      )}
                    >
                      <td className="tnum px-3.5 py-2 font-mono text-muted">
                        {formatClock(c.startedTs)}
                      </td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setParam('req', c.requestId);
                          }}
                          className="font-mono text-fg-2 hover:text-fg hover:underline focus-visible:underline"
                          aria-label={`Open request ${c.requestId}`}
                        >
                          {shortId(c.requestId)}
                        </button>
                      </td>
                      <td className="max-w-0 truncate px-2 py-2 font-mono text-fg">
                        {c.model || '—'}
                      </td>
                      <td className="max-w-0 px-2 py-1.5">
                        <ChainView chain={c} accounts={accountMap} />
                      </td>
                      <td className="tnum px-2 py-2 text-right font-mono text-fg-2">
                        {latency !== undefined ? formatLatency(latency) : '…'}
                      </td>
                      <td className="tnum px-2 py-2 text-right font-mono text-fg-2">
                        {t.prompt || t.completion ? (
                          <>
                            {formatCompact(t.prompt)} <span className="text-faint">→</span>{' '}
                            {formatCompact(t.completion)}
                          </>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3.5 py-2 text-right">
                        <OutcomeBadge chain={c} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {rows.length === ROW_LIMIT && (
        <p className="text-center text-[12px] text-muted">
          Showing the latest {ROW_LIMIT} requests.
        </p>
      )}

      <RequestSheet chain={selected} accounts={accountMap} onClose={() => setParam('req', null)} />
    </div>
  );
}
