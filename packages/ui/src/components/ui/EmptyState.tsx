import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CommandHint } from './CopyButton';

export function EmptyState({
  icon: Icon,
  title,
  description,
  command,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  /** A CLI command that gets the user unstuck. */
  command?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      <div className="flex size-9 items-center justify-center rounded-lg border border-line-strong bg-raised text-muted">
        <Icon aria-hidden className="size-4" strokeWidth={1.5} />
      </div>
      <div className="max-w-sm">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        {description && <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>}
      </div>
      {command && <CommandHint command={command} className="w-full max-w-sm text-left" />}
      {action}
    </div>
  );
}
