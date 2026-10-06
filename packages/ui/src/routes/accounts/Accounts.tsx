import { ChevronRight, Plus, Search, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { QuotaLegend, QuotaMeter } from '../../components/charts/QuotaMeter';
import { AccountStatusBadge, ProviderIcon } from '../../components/domain';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Field';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Segmented } from '../../components/ui/Segmented';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { providerMeta } from '../../lib/providers';
import { useAccounts, useUpdateAccount, useUsage } from '../../lib/queries';
import { setParam, useLocation } from '../../lib/router';
import { toast } from '../../lib/toast';
import type { Account, AccountStatus } from '../../lib/types';
import { AccountSheet } from './AccountSheet';
import { AddAccountSheet } from './AddAccountSheet';

type StatusFilter = 'all' | AccountStatus;

export function Accounts() {
  const accounts = useAccounts();
  const usage = useUsage();
  const update = useUpdateAccount();
  const { params } = useLocation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

  const selectedId = params.get('account');
  const adding = params.get('new') === '1';

  const usageMap = useMemo(
    () => new Map((usage.data ?? []).map((u) => [u.accountId, u])),
    [usage.data],
  );
  const all = useMemo(
    () =>
      [...(accounts.data ?? [])].sort(
        (a, b) => a.priority - b.priority || a.label.localeCompare(b.label),
      ),
    [accounts.data],
  );
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: all.length,
      active: 0,
      cooldown: 0,
      disabled: 0,
      error: 0,
    };
    for (const a of all) c[a.status] += 1;
    return c;
  }, [all]);

  const q = query.trim().toLowerCase();
  const rows = all.filter(
    (a) =>
      (status === 'all' || a.status === status) &&
      (!q ||
        a.label.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.provider.includes(q)),
  );
  const selected = all.find((a) => a.id === selectedId);

  const toggle = (a: Account, enabled: boolean) => {
    update.mutate(
      { id: a.id, patch: { enabled } },
      {
        onError: (err) =>
          toast({
            tone: 'err',
            title: `Could not ${enabled ? 'enable' : 'disable'} ${a.label}`,
            description: errorMessage(err),
          }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Accounts"
        description="Provider accounts the router balances across. Lower priority numbers are tried first."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setParam('new', '1')}>
            Add account
          </Button>
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
            aria-label="Filter accounts"
            placeholder="Filter by label, id or provider"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8"
            data-filter-input
          />
        </div>
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'active', label: 'Active', count: counts.active },
            { value: 'cooldown', label: 'Cooldown', count: counts.cooldown },
            { value: 'disabled', label: 'Disabled', count: counts.disabled },
            { value: 'error', label: 'Error', count: counts.error },
          ]}
        />
        <QuotaLegend className="ml-auto hidden lg:flex" />
      </div>

      {accounts.isError && (
        <Callout tone="err" title="Could not load accounts">
          {errorMessage(accounts.error)}
        </Callout>
      )}

      <Panel>
        {accounts.isPending ? (
          <SkeletonRows rows={5} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No accounts yet"
            description="Add an API key, a local OpenAI-compatible server or a CLI login. The router starts using it immediately."
            command="davecode add-account"
            action={
              <Button variant="primary" icon={Plus} onClick={() => setParam('new', '1')}>
                Add account
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matching accounts"
            description="Try a different filter."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[13px]">
              <caption className="sr-only">Accounts</caption>
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  <th scope="col" className="w-[32%] px-3.5 py-2 font-medium">
                    Account
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="w-20 px-3 py-2 text-right font-medium">
                    Priority
                  </th>
                  <th scope="col" className="w-20 px-3 py-2 text-right font-medium">
                    Weight
                  </th>
                  <th scope="col" className="w-[30%] px-3 py-2 font-medium">
                    Quota
                  </th>
                  <th scope="col" className="w-20 px-3 py-2 font-medium">
                    Enabled
                  </th>
                  <th scope="col" className="w-10 px-2 py-2">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const u = usageMap.get(a.id);
                  const meta = providerMeta(a.provider);
                  return (
                    <tr
                      key={a.id}
                      onClick={() => setParam('account', a.id)}
                      className={cn(
                        'group cursor-pointer border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-hover/60',
                        selectedId === a.id && 'bg-hover/60',
                        !a.enabled && 'text-muted',
                      )}
                    >
                      <td className="max-w-0 px-3.5 py-2.5">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ProviderIcon provider={a.provider} />
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setParam('account', a.id);
                              }}
                              className="block max-w-full truncate text-left font-medium text-fg hover:underline focus-visible:underline"
                            >
                              {a.label}
                            </button>
                            <p className="truncate font-mono text-2xs text-muted">
                              {a.id} · {meta.label}
                              {meta.experimental && (
                                <span className="text-warn"> · experimental</span>
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <AccountStatusBadge account={a} />
                      </td>
                      <td className="tnum px-3 py-2.5 text-right font-mono">{a.priority}</td>
                      <td className="tnum px-3 py-2.5 text-right font-mono">{a.weight}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1">
                          <QuotaMeter label="1m" usage={u?.windows['1m']} />
                          <QuotaMeter label="5h" usage={u?.windows['5h']} />
                          <QuotaMeter label="24h" usage={u?.windows['24h']} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Switch
                          checked={a.enabled}
                          onChange={(v) => toggle(a, v)}
                          label={`${a.enabled ? 'Disable' : 'Enable'} ${a.label}`}
                        />
                      </td>
                      <td className="px-2 py-2.5 text-muted">
                        <ChevronRight
                          aria-hidden
                          className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
                          strokeWidth={1.75}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <AddAccountSheet open={adding} onClose={() => setParam('new', null)} />
      <AccountSheet
        account={selected}
        usage={selected ? usageMap.get(selected.id) : undefined}
        onClose={() => setParam('account', null)}
      />
    </div>
  );
}
