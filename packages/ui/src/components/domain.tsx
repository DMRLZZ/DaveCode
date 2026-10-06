import { cn } from '../lib/cn';
import { formatCountdown } from '../lib/format';
import { useNow } from '../lib/hooks';
import { providerMeta } from '../lib/providers';
import type { Account, ProviderKind, TaskStatus } from '../lib/types';
import { Badge, Dot, type Tone } from './ui/Badge';

/** Provider glyph in a hairline tile. */
export function ProviderIcon({
  provider,
  size = 'md',
  className,
}: {
  provider: ProviderKind;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const meta = providerMeta(provider);
  const Icon = meta.icon;
  const box =
    size === 'sm' ? 'size-5 rounded' : size === 'lg' ? 'size-8 rounded-md' : 'size-6 rounded-md';
  const glyph = size === 'sm' ? 'size-3' : size === 'lg' ? 'size-4' : 'size-3.5';
  return (
    <span
      title={meta.label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border border-line-strong bg-raised text-fg-2',
        box,
        className,
      )}
    >
      <Icon aria-hidden className={glyph} strokeWidth={1.75} />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

export const ACCOUNT_STATUS_TONE: Record<Account['status'], Tone> = {
  active: 'ok',
  cooldown: 'warn',
  disabled: 'neutral',
  error: 'err',
};

/** Account status with a live cooldown countdown. */
export function AccountStatusBadge({ account }: { account: Account }) {
  const now = useNow(1000);
  const tone = ACCOUNT_STATUS_TONE[account.status];
  if (account.status === 'cooldown' && account.cooldownUntil) {
    const remaining = (Date.parse(account.cooldownUntil) - now) / 1000;
    return (
      <Badge tone={tone} dot>
        <span>cooldown</span>
        <span className="tnum font-mono">
          {remaining > 0 ? formatCountdown(remaining) : '0:00'}
        </span>
      </Badge>
    );
  }
  return (
    <span title={account.status === 'error' ? account.lastError : undefined}>
      <Badge tone={tone} dot>
        {account.status}
      </Badge>
    </span>
  );
}

export const TASK_TONE: Record<TaskStatus, Tone> = {
  PENDING: 'neutral',
  IN_PROGRESS: 'info',
  SUCCESS: 'ok',
  FAILED: 'err',
};

export const TASK_LABEL: Record<TaskStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  SUCCESS: 'Done',
  FAILED: 'Failed',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge tone={TASK_TONE[status]} dot pulse={status === 'IN_PROGRESS'}>
      {TASK_LABEL[status]}
    </Badge>
  );
}

export function TaskStatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  return <Dot tone={TASK_TONE[status]} pulse={status === 'IN_PROGRESS'} className={className} />;
}

/** Account label with its provider glyph, used in tables and chains. */
export function AccountLabel({
  account,
  fallbackId,
  provider,
  showId,
  className,
}: {
  account?: Account;
  fallbackId?: string;
  provider?: ProviderKind;
  showId?: boolean;
  className?: string;
}) {
  const kind = account?.provider ?? provider ?? 'openai-compatible';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <ProviderIcon provider={kind} size="sm" />
      <span className="min-w-0">
        <span className="block truncate text-fg">{account?.label ?? fallbackId ?? 'unknown'}</span>
        {showId && (
          <span className="block truncate font-mono text-2xs text-muted">
            {account?.id ?? fallbackId}
          </span>
        )}
      </span>
    </span>
  );
}
