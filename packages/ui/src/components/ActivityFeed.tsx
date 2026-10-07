import {
  AlertTriangle,
  ArrowRightLeft,
  Bot,
  CircleCheck,
  CircleDot,
  CircleX,
  Info,
  type LucideIcon,
  UserCog,
  UserMinus,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { formatClock } from '../lib/format';
import type { Account, DaveEvent } from '../lib/types';
import type { Tone } from './ui/Badge';

export interface FeedItem {
  key: string;
  ts: number;
  icon: LucideIcon;
  tone: Tone;
  text: string;
  detail?: string;
}

const toneClass: Record<Tone, string> = {
  neutral: 'text-muted',
  accent: 'text-accent-text',
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  info: 'text-info',
};

/** Turn notable events into human-readable feed items (request noise is skipped). */
export function toFeedItem(e: DaveEvent, accounts: Map<string, Account>): FeedItem | null {
  const name = (id: string | null) => (id ? (accounts.get(id)?.label ?? id) : 'nobody');
  // Content-derived key: stable while the event buffer is trimmed from the front.
  const key = `${e.ts}:${e.type}:${JSON.stringify(e).length}`;
  switch (e.type) {
    case 'router.failover':
      return {
        key,
        ts: e.ts,
        icon: ArrowRightLeft,
        tone: e.toAccountId ? 'warn' : 'err',
        text: e.toAccountId
          ? `Failover ${name(e.fromAccountId)} → ${name(e.toAccountId)}`
          : `No failover target left after ${name(e.fromAccountId)}`,
        detail: `${e.reason} · ${e.requestId}`,
      };
    case 'account.updated': {
      const s = e.account.status;
      return {
        key,
        ts: e.ts,
        icon: UserCog,
        tone: s === 'cooldown' ? 'warn' : s === 'error' ? 'err' : s === 'active' ? 'ok' : 'neutral',
        text: `${e.account.label} is ${s}`,
        detail: s === 'cooldown' ? e.account.lastError : e.account.id,
      };
    }
    case 'account.removed':
      return {
        key,
        ts: e.ts,
        icon: UserMinus,
        tone: 'neutral',
        text: `Account ${e.accountId} removed`,
      };
    case 'task.updated':
      return {
        key,
        ts: e.ts,
        icon:
          e.task.status === 'SUCCESS'
            ? CircleCheck
            : e.task.status === 'FAILED'
              ? CircleX
              : CircleDot,
        tone:
          e.task.status === 'SUCCESS'
            ? 'ok'
            : e.task.status === 'FAILED'
              ? 'err'
              : e.task.status === 'IN_PROGRESS'
                ? 'info'
                : 'neutral',
        text: `${e.task.id} → ${e.task.status.toLowerCase().replace('_', ' ')}`,
        detail: e.task.title,
      };
    case 'task.removed':
      return {
        key,
        ts: e.ts,
        icon: CircleX,
        tone: 'neutral',
        text: `${e.taskId} removed`,
      };
    case 'runner.status':
      return {
        key,
        ts: e.ts,
        icon: Bot,
        tone: e.status.state === 'error' ? 'err' : e.status.state === 'repairing' ? 'warn' : 'info',
        text: `Runner ${e.status.state}${e.status.taskId ? ` · ${e.status.taskId}` : ''}`,
        detail: e.status.repairCycle ? `repair cycle ${e.status.repairCycle}/3` : undefined,
      };
    case 'log':
    case 'runner.log':
      if (e.level !== 'warn' && e.level !== 'error') return null;
      return {
        key,
        ts: e.ts,
        icon: e.level === 'error' ? CircleX : AlertTriangle,
        tone: e.level === 'error' ? 'err' : 'warn',
        text: e.message,
        detail: e.type === 'log' ? e.scope : 'runner',
      };
    default:
      return null;
  }
}

export function ActivityFeed({ items, className }: { items: FeedItem[]; className?: string }) {
  if (items.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center gap-2 p-6 text-[12px] text-muted',
          className,
        )}
      >
        <Info aria-hidden className="size-3.5" strokeWidth={1.75} />
        Waiting for activity…
      </div>
    );
  }
  return (
    <ol aria-label="Recent activity" className={cn('flex flex-col', className)}>
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li
            key={item.key}
            className="flex animate-row-in gap-2.5 border-b border-line px-3.5 py-2 last:border-b-0"
          >
            <Icon
              aria-hidden
              className={cn('mt-0.5 size-3.5 shrink-0', toneClass[item.tone])}
              strokeWidth={1.75}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] text-fg">{item.text}</p>
              {item.detail && (
                <p className="truncate font-mono text-2xs text-muted">{item.detail}</p>
              )}
            </div>
            <time
              dateTime={new Date(item.ts).toISOString()}
              className="tnum shrink-0 font-mono text-2xs text-faint"
            >
              {formatClock(item.ts)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
