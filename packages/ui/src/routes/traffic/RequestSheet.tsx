import type { ReactNode } from 'react';
import { ProviderIcon } from '../../components/domain';
import { Badge } from '../../components/ui/Badge';
import { CopyButton } from '../../components/ui/CopyButton';
import { Sheet } from '../../components/ui/Overlay';
import { cn } from '../../lib/cn';
import { formatClock, formatInt, formatLatency } from '../../lib/format';
import { chainLatency, chainTokens, errorStatusLabel, type RequestChain } from '../../lib/traffic';
import type { Account } from '../../lib/types';
import { OutcomeBadge } from './Chain';

export function RequestSheet({
  chain,
  accounts,
  onClose,
}: {
  chain: RequestChain | undefined;
  accounts: Map<string, Account>;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={Boolean(chain)}
      onClose={onClose}
      title="Request"
      description={
        chain && (
          <span className="inline-flex items-center gap-1 font-mono">
            {chain.requestId}
            <CopyButton value={chain.requestId} label="Copy request id" />
          </span>
        )
      }
      width="w-[min(520px,100vw)]"
    >
      {chain && <RequestDetail chain={chain} accounts={accounts} />}
    </Sheet>
  );
}

function RequestDetail({
  chain,
  accounts,
}: {
  chain: RequestChain;
  accounts: Map<string, Account>;
}) {
  const tokens = chainTokens(chain);
  const latency = chainLatency(chain);
  const rows: [string, ReactNode][] = [
    ['Outcome', <OutcomeBadge key="o" chain={chain} />],
    [
      'Model',
      <span key="m" className="font-mono">
        {chain.model || '—'}
      </span>,
    ],
    [
      'Started',
      <span key="s" className="tnum font-mono">
        {formatClock(chain.startedTs, true)}
      </span>,
    ],
    [
      'End-to-end',
      <span key="l" className="tnum font-mono">
        {latency !== undefined ? formatLatency(latency) : '—'}
      </span>,
    ],
    [
      'Tokens',
      <span key="t" className="tnum font-mono">
        {formatInt(tokens.prompt)} in · {formatInt(tokens.completion)} out
      </span>,
    ],
    [
      'Failovers',
      <span key="f" className="tnum font-mono">
        {chain.failovers}
      </span>,
    ],
  ];

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 text-fg">{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="attempts-title">
        <h3 id="attempts-title" className="mb-2 text-[12px] font-medium text-fg-2">
          Attempts
        </h3>
        <ol className="relative flex flex-col gap-0">
          {chain.attempts.map((a, i) => {
            const account = accounts.get(a.accountId);
            const offset = a.startedTs - chain.startedTs;
            const last = i === chain.attempts.length - 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: attempts are append-only
              <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && (
                  <span
                    aria-hidden
                    className="absolute top-7 bottom-0 left-[11px] w-px bg-line-strong"
                  />
                )}
                <span
                  className={cn(
                    'z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                    a.outcome === 'success'
                      ? 'border-ok/40 bg-ok-soft text-ok'
                      : a.outcome === 'failed'
                        ? 'border-err/40 bg-err-soft text-err'
                        : 'border-info/40 bg-info-soft text-info',
                  )}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 rounded-md border border-line bg-raised p-2.5">
                  <div className="flex items-center gap-2">
                    <ProviderIcon provider={a.provider} size="sm" />
                    <span className="truncate text-[13px] font-medium text-fg">
                      {account?.label ?? a.accountId}
                    </span>
                    <span className="ml-auto">
                      {a.outcome === 'success' ? (
                        <Badge tone="ok">served</Badge>
                      ) : a.outcome === 'failed' ? (
                        <Badge tone="err" mono>
                          {errorStatusLabel(a)} {a.errorKind}
                        </Badge>
                      ) : (
                        <Badge tone="info" dot pulse>
                          in flight
                        </Badge>
                      )}
                    </span>
                  </div>
                  <p className="tnum mt-1.5 font-mono text-2xs text-muted">
                    {a.accountId} · +{formatLatency(offset)}
                    {a.latencyMs !== undefined && ` · took ${formatLatency(a.latencyMs)}`}
                    {a.outcome === 'success' &&
                      ` · ${formatInt(a.promptTokens ?? 0)} → ${formatInt(a.completionTokens ?? 0)} tok`}
                  </p>
                  {a.errorMessage && (
                    <p className="mt-1.5 text-[12px] text-fg-2">{a.errorMessage}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <details className="rounded-md border border-line">
        <summary className="px-3 py-2 text-[12px] font-medium text-fg-2 select-none hover:text-fg">
          Raw chain
        </summary>
        <pre className="max-h-80 overflow-auto border-t border-line p-3 font-mono text-2xs leading-5 text-fg-2">
          {JSON.stringify(chain, null, 2)}
        </pre>
      </details>
    </div>
  );
}
