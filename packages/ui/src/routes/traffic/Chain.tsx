import { Check, Loader, X } from 'lucide-react';
import { Fragment } from 'react';
import { ProviderIcon } from '../../components/domain';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../lib/cn';
import { type ChainAttempt, errorStatusLabel, type RequestChain } from '../../lib/traffic';
import type { Account } from '../../lib/types';

/** Inline failover chain: `acc A → 429 → acc B ✓`. Outcome is never encoded by color alone. */
export function ChainView({
  chain,
  accounts,
  className,
}: {
  chain: RequestChain;
  accounts: Map<string, Account>;
  className?: string;
}) {
  const summary = chain.attempts
    .map((a) => {
      const name = accounts.get(a.accountId)?.label ?? a.accountId;
      return a.outcome === 'failed'
        ? `${name} failed (${errorStatusLabel(a)})`
        : `${name} ${a.outcome}`;
    })
    .join(', then ');

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)} title={summary}>
      <span className="sr-only">{summary}</span>
      {chain.attempts.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: attempts are append-only and may repeat an account
        <Fragment key={i}>
          {i > 0 && <Arrow attempt={chain.attempts[i - 1]} />}
          <AttemptChip
            attempt={a}
            account={accounts.get(a.accountId)}
            compact={chain.attempts.length > 2 && i < chain.attempts.length - 1}
          />
        </Fragment>
      ))}
    </div>
  );
}

function Arrow({ attempt }: { attempt: ChainAttempt | undefined }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1 text-faint">
      <span className="h-px w-2 bg-line-strong" />
      {attempt?.outcome === 'failed' && (
        <span className="rounded border border-err/30 bg-err-soft px-1 font-mono text-[10px] leading-4 text-err">
          {errorStatusLabel(attempt)}
        </span>
      )}
      <span className="h-px w-2 bg-line-strong" />
      <span className="-ml-1.5 text-[10px] leading-none">▸</span>
    </span>
  );
}

function AttemptChip({
  attempt,
  account,
  compact,
}: {
  attempt: ChainAttempt;
  account: Account | undefined;
  /** Icon-only chip for intermediate hops of long chains. */
  compact?: boolean;
}) {
  const label = account?.label ?? attempt.accountId;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-6 max-w-[180px] min-w-0 items-center gap-1.5 rounded border pr-1.5 pl-0.5 text-[12px]',
        attempt.outcome === 'failed'
          ? 'border-line text-muted'
          : 'border-line-strong bg-raised text-fg',
      )}
    >
      <ProviderIcon
        provider={attempt.provider}
        size="sm"
        className="size-[18px] border-0 bg-transparent"
      />
      {!compact && (
        <span
          className={cn(
            'truncate',
            attempt.outcome === 'failed' && 'line-through decoration-faint',
          )}
        >
          {label}
        </span>
      )}
      {attempt.outcome === 'success' && (
        <Check className="size-3 shrink-0 text-ok" strokeWidth={2.25} />
      )}
      {attempt.outcome === 'failed' && (
        <X className="size-3 shrink-0 text-err" strokeWidth={2.25} />
      )}
      {attempt.outcome === 'pending' && (
        <Loader
          className="size-3 shrink-0 animate-spin text-info [animation-duration:1.6s]"
          strokeWidth={2}
        />
      )}
    </span>
  );
}

/** Final outcome of a request, with text so it never relies on color. */
export function OutcomeBadge({ chain }: { chain: RequestChain }) {
  if (chain.outcome === 'pending') {
    return (
      <Badge tone="info" dot pulse>
        in flight
      </Badge>
    );
  }
  if (chain.outcome === 'failed') {
    return (
      <Badge tone="err" dot>
        failed
      </Badge>
    );
  }
  if (chain.failovers > 0) {
    return (
      <Badge tone="warn" dot>
        ok · {chain.failovers} failover{chain.failovers > 1 ? 's' : ''}
      </Badge>
    );
  }
  return (
    <Badge tone="ok" dot>
      ok
    </Badge>
  );
}
